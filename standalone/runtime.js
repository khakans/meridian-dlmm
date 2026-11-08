// Standalone orchestrator: monitor → convergence signal → focused screening →
// revalidated deploy → deterministic exits. No Meridian server, no LLM authority.
//
// Entry and exit paths are independent: exits keep running while a signal is
// being screened, and wallet mutations are serialized by the wallet lock
// (close_position > other writes > deploy_position) in standalone/transactions.js.

import fs from "node:fs";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { sendNotification as notify, setNotificationMirror } from "../telegram.js";
import { MonitorStore, finishSignal } from "./store.js";
import { WalletMonitor } from "./monitor.js";
import { screenMint, poolDetail } from "./screening.js";
import { startDiscovery } from "./discovery.js";
import { entryPlans } from "./entry-plans.js";
import { startPaper, validateExitQuote } from "./paper.js";
import { paperDay, recommendPaperVariant } from "./paper-accounting.js";
import { getPerformanceHistory } from "../performance.js";
import { paperPnlLines, signed, summarizePaper } from "./pnl-summary.js";
import { exposureStillPresent } from "./events.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPosition, getTrackedPositions, confirmPeak, updatePnlAndCheckExits, registerExitSignal, syncOpenPositions } from "../state.js";
import { recordPositionSnapshot } from "../pool-memory.js";
import { getDeterministicCloseRule, computeBinsBelow } from "../exit-rules.js";
import { startAdmin } from "./telegram-admin.js";
import { startSlackAdmin } from "./slack-admin.js";
import { analyzePoolWithChronos, getCachedChronosAnalysis, startChronosKeepalive, stopChronosKeepalive } from "./chronos.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let store = null;
let monitor = null;
let lockPath = null;
let stopAdmin = null;
let stopDiscovery = null;
let stopPaper = null;
let slackAdmin = null;
let shuttingDown = false;
let manageBusy = false;
let pollBusy = false;
let pursuing = false;
const timers = {};
const signalQueue = [];
const discoveryStats = { received: 0, retries: 0, waiting: 0, passed: 0, dropped: 0, reasons: Object.create(null) };

function shadowScreeningThresholds() {
  if (!config.standalone.shadow || !config.research.enabled) return undefined;
  return {
    ...config.screening,
    minMcap: config.research.minMcap,
    minHolders: config.research.minHolders,
    minTokenFeesSol: config.research.minTokenFeesSol,
    minTvl: config.research.minTvl,
    minTokenAgeHours: config.research.minTokenAgeHours,
  };
}

// ─── Signal pursuit ──────────────────────────────────────────────────────────

function onSignal(signal) {
  signalQueue.push(signal);
  void drainSignals();
}

async function drainSignals() {
  if (pursuing) return;
  pursuing = true;
  try {
    while (signalQueue.length && !shuttingDown) {
      const signal = signalQueue.shift();
      try {
        await pursueSignal(signal);
      } catch (e) {
        finishSignal(store, signal, `error: ${e.message}`);
        log("signal_error", `Signal ${signal.mint.slice(0, 8)} aborted: ${e.message}`);
      }
    }
  } finally {
    pursuing = false;
  }
}

// Screen and enter within the signal deadline. Terminal outcomes finish the
// signal; temporary failures retry every retrySec until the deadline expires.
async function pursueSignal(signal) {
  const wallets = signal.events.map(e => `${e.wallet.slice(0, 6)}(◎${e.depositSol.toFixed(1)})`).join(", ");
  log("signal", `Convergence on ${signal.mint.slice(0, 8)}: ${signal.events.length} wallets [${wallets}] — screening with ${config.standalone.screeningDeadlineSec}s deadline`);
  let lastReason = "no attempt";
  while (!shuttingDown && !signal.done && Date.now() < signal.deadline) {
    const reason = await attemptEntry(signal);
    if (reason == null) return;
    lastReason = reason;
    const wait = Math.min(config.standalone.retrySec * 1000, signal.deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }
  if (!signal.done) {
    finishSignal(store, signal, lastReason);
    log("signal", `Signal ${signal.mint.slice(0, 8)} expired: ${lastReason}`);
  }
}

// One entry attempt. Returns null when the signal is finished (entered,
// terminal rejection, or fatal condition), or a reason string to retry.
async function attemptEntry(signal) {
  const mint = signal.mint;
  const attempt = store.data.attempts[mint];
  const attemptCooldownMs = (config.standalone.cooldownSec ?? 300) * 1000;
  // Block concurrent mid-submit or immediate duplicate signal within signal cooldown;
  // longer-term repeat-entry limits are enforced by pool-memory (repeatDeployCooldownTriggerCount).
  if (
    attempt &&
    (attempt.status === "submitting" ||
      (["entered", "proposed"].includes(attempt.status) && Date.now() - (attempt.at ?? 0) < attemptCooldownMs))
  ) {
    finishSignal(store, signal, `mint already attempted (${attempt.status})`);
    return null;
  }
  if (attempt?.status === "failed" && (attempt.failures ?? 0) >= 2) {
    finishSignal(store, signal, "deploy failed repeatedly");
    return null;
  }

  // A failed position read is unavailable data, never "no positions".
  const paperConvergence = config.standalone.shadow && config.research.enabled;
  const paper = store.data.paper;
  const baselinePositions = Object.values(paper?.open ?? {}).filter(p => p.variant === "convergence/baseline");
  const positions = paperConvergence ? { positions: baselinePositions } : await getMyPositions({ force: true }).catch(() => null);
  if (!positions || positions.error || !Array.isArray(positions.positions)) return "position read unavailable";
  if (positions.positions.length >= config.risk.maxPositions) {
    finishSignal(store, signal, "portfolio full");
    return null;
  }

  // Focused screening: this mint and its eligible pools only.
  let screened;
  try {
    screened = await screenMint(mint);
  } catch (e) {
    return `screening error: ${e.message}`;
  }
  if (!screened.pass) {
    if (screened.terminal) {
      finishSignal(store, signal, `blocked: ${screened.reason}`);
      return null;
    }
    return screened.reason;
  }

  const paperReserved = baselinePositions.reduce((total, p) => total + p.capital + 0.001, 0);
  const simulatedSol = config.research.paperBankrollSol + (paper?.realized?.["convergence/baseline"] ?? 0) - paperReserved;
  const gate = await finalRecheck(signal, screened, paperConvergence ? simulatedSol : null);
  if (gate) return gate;

  const balances = paperConvergence ? { sol: simulatedSol } : await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) {
    finishSignal(store, signal, "insufficient spendable SOL");
    return null;
  }

  const pool = screened.pool;
  const configuredBinsAbove = Number(config.strategy.defaultBinsAbove ?? 0);
  const whaleBinsAbove = Math.max(0, ...signal.events.map(e => Number(e.binsAbove || 0)));
  let binsAbove = configuredBinsAbove > 0
    ? Math.min(configuredBinsAbove, whaleBinsAbove > 0 ? whaleBinsAbove : configuredBinsAbove)
    : 0;
  const rawBinsBelow = computeBinsBelow(pool.volatility);
  let binsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.min(rawBinsBelow, 69 - binsAbove));

  // Chronos AI Pre-Deploy Gate & Dynamic Bin Calibration (InstaBox 5-Node Cluster + Fallback)
  const chronos = await analyzePoolWithChronos(pool.pool_address, {
    binStep: pool.dlmm_params?.bin_step ?? 100,
    activePrice: pool.pool_price,
    defaultBinsAbove: binsAbove,
    defaultBinsBelow: binsBelow,
    minBinsBelow: MIN_SAFE_BINS_BELOW,
  }).catch(() => null);

  let convictionMult = 1.0;
  let xRatioMult = 0.65;
  if (chronos) {
    if (chronos.gate?.action === "DEFER") {
      log("chronos_gate", `Deferred ${mint.slice(0, 8)} (${pool.pool_address.slice(0, 8)}): ${chronos.gate.reason}`);
      return `chronos gate: ${chronos.gate.reason}`;
    }
    if (configuredBinsAbove > 0 && chronos.recommended_bins?.bins_above > 0) {
      binsAbove = chronos.recommended_bins.bins_above;
    }
    if (chronos.recommended_bins?.bins_below > 0) {
      binsBelow = Math.max(
        MIN_SAFE_BINS_BELOW,
        Math.min(Math.max(binsBelow, chronos.recommended_bins.bins_below), 69 - binsAbove),
      );
    }
    if (Number.isFinite(Number(chronos.tactical_signals?.conviction_mult))) {
      convictionMult = Number(chronos.tactical_signals.conviction_mult);
    }
    if (Number.isFinite(Number(chronos.tactical_signals?.x_ratio_mult))) {
      xRatioMult = Number(chronos.tactical_signals.x_ratio_mult);
    }
    const s = chronos.summary ?? {};
    log(
      "chronos",
      `Pool ${pool.pool_address.slice(0, 8)} [${chronos.engine}]: P10=${s.p10_pct}% P50=${s.p50_pct}% P90=${s.p90_pct}% RSI=${s.rsi_14} BB%B=${s.bb_pct_b} → bins=${binsBelow}↓/${binsAbove}↑ xMult=${xRatioMult} convMult=${convictionMult} (${chronos.latency_ms}ms)`,
    );
  }
  const amountY = computeDeployAmount(balances.sol, convictionMult);
  if (paperConvergence || (!config.standalone.shadow && process.env.DRY_RUN !== "true")) {
    try {
      await validateExitQuote({
        mint, pool: pool.pool_address, decimals: screened.decimals,
        binStep: Number(pool.dlmm_params?.bin_step), binsBelow, capital: amountY,
      });
    } catch { return "exit quote unavailable or below minimum"; }
  }
  if (paperConvergence) {
    if (binsAbove !== 0) return "paper accounting requires SOL-only configuration";
    const shape = config.strategy.strategy;
    const baseline = { shape, range: "volatility", binsBelow, variant: "convergence/baseline" };
    const plans = [
      baseline,
      ...(binsBelow < 69 ? [{ ...baseline, binsBelow: Math.min(69, binsBelow + 10), variant: "convergence/wider" }] : []),
      { ...baseline, rangeWaitMinutes: config.research.paperInitialRangeWaitMinutes + 15, variant: "convergence/wait-longer" },
      { ...baseline, maxHoldMinutes: Math.max(15, Math.floor(config.research.paperMaxHoldMinutes * 0.75)), variant: "convergence/hold-shorter" },
    ];
    await recordResearch(mint, screened, ["wallet convergence"], { plans, capital: amountY });
    store.data.attempts[mint] = { at: Date.now(), mint, pool: pool.pool_address, status: "proposed", amountSol: amountY };
    finishSignal(store, signal, "convergence paper proposal recorded");
    log("entry", `[SHADOW] Convergence paper proposal for ${mint}`);
    return null;
  }
  // Checkpoint before building anything: a crash mid-sequence leaves a
  // recovery pointer instead of a silent duplicate-entry risk.
  store.data.attempts[mint] = {
    at: Date.now(), mint, pool: pool.pool_address, wallets: signal.events.map(e => e.wallet),
    status: "submitting", failures: attempt?.failures ?? 0, position: null, txs: [],
  };
  store.save();

  let submitted = 0;
  const result = await executeTool("deploy_position", {
    pool_address: pool.pool_address,
    base_mint: mint,
    pool_name: pool.name,
    bin_step: pool.dlmm_params?.bin_step,
    volatility: pool.volatility,
    fee_tvl_ratio: pool.fee_active_tvl_ratio,
    organic_score: screened.token?.organicScore,
    amount_y: amountY,
    bins_below: binsBelow,
    bins_above: binsAbove,
    x_ratio_mult: xRatioMult,
    before_submit: async (stage = "lp") => {
      // Always recheck before the pre-deploy swap AND before the first LP creation tx.
      // Subsequent chunks of a multi-tx LP creation skip recheck so a half-built position completes.
      if (stage !== "swap" && submitted++ > 0) return;
      const fresh = await finalRecheck(signal, screened);
      if (fresh) throw new Error(`Pre-submit recheck failed: ${fresh}`);
    },
    on_prepared: position => {
      store.data.attempts[mint].position = position;
      store.save();
    },
  }).catch(e => ({ error: e.message }));

  const record = store.data.attempts[mint];
  if (Array.isArray(result?.txs) && result.txs.length > 0) {
    record.txs = result.txs;
  }
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (ok) {
    record.status = result.dry_run ? "proposed" : "entered";
    record.position = result.position ?? record.position;
    record.txs = result.txs ?? [];
    record.amountSol = amountY;
    store.save();
    finishSignal(store, signal, record.status === "proposed" ? "shadow proposal recorded" : "entered");
    const label = result.dry_run ? "[SHADOW] Would deploy" : "Deployed";
    log("entry", `${label} ${amountY} SOL → pool ${pool.pool_address.slice(0, 8)} mint ${mint.slice(0, 8)} (${binsBelow} bins below, ${signal.events.length}-wallet convergence)`);
    void notify(`${result.dry_run ? "🕯️ Shadow proposal" : "✅ Entry"}: ${amountY} SOL → ${pool.pool_address.slice(0, 8)} (mint ${mint.slice(0, 8)}, ${signal.events.length} wallets)`);
    return null;
  }

  record.status = "failed";
  record.failures = (record.failures ?? 0) + 1;
  record.error = result?.error || result?.reason || "unknown";
  if (Array.isArray(record.txs) && record.txs.length > 0) record.note = "transaction submitted before failure — outcome uncertain";
  store.save();
  return `deploy failed (${record.error})`;
}

// Immediate pre-entry conditions: the triggering wallets still hold their
// exposure, the market has not run away since screening, and spendable funds
// cover the entry. Returns null when everything holds, else the reason.
async function finalRecheck(signal, screened, simulatedSol = null) {
  let present = 0;
  for (const e of signal.events) {
    try { if (await exposureStillPresent(e)) present++; } catch { /* unreadable position = not confirmed */ }
  }
  if (present < config.standalone.walletThreshold) {
    return `wallet exposure gone (${present}/${signal.events.length} remain)`;
  }
  try {
    const fresh = await poolDetail(screened.pool.pool_address);
    const base = Number(screened.pool.pool_price);
    const now = Number(fresh.pool_price);
    if (!(base > 0) || !(now > 0)) return "price unavailable for move check";
    const movePct = Math.abs(now - base) / base * 100;
    if (movePct > config.standalone.maxPriceMovePct) return `price moved ${movePct.toFixed(1)}% since screening`;
  } catch (e) {
    return `fresh pool read failed (${e.message})`;
  }
  const balances = simulatedSol == null ? await getWalletBalances({ force: true, nativeOnly: true }) : { sol: simulatedSol };
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) return "insufficient spendable SOL";
  return null;
}

// ─── Exits (deterministic, no LLM) ──────────────────────────────────────────

// One management pass: trailing/rule exits and fee claims. Never triggers
// screening — an empty portfolio just waits for the next convergence signal.
export async function manageOnce() {
  if (manageBusy || shuttingDown) return null;
  manageBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) {
      log("manage_warn", "Position read unavailable — holding this cycle");
      return null;
    }
    syncOpenPositions(live.positions.map(p => p.position));
    if (live.positions.length === 0) return "No open positions";
    const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
    for (const p of live.positions) {
      recordPositionSnapshot(p.pool, p);
      const tracked = getTrackedPosition(p.position);
      // Refresh Chronos tactical context for open position during management pass
      const chronos = await analyzePoolWithChronos(p.pool, {
        binStep: tracked?.bin_step ?? 100,
      }).catch(() => getCachedChronosAnalysis(p.pool));
      const chronosCtx = chronos
        ? { ...(chronos.tactical_signals ?? {}), oor_below_outlook: chronos.oor_below_outlook }
        : null;
      confirmPeak(p.position, p.pnl_pct, confirmTicks);
      const exit = updatePnlAndCheckExits(p.position, p, config.management, chronosCtx);
      const closeRule = exit
        ? { action: "CLOSE", rule: "exit", reason: exit.reason }
        : getDeterministicCloseRule(p, config.management, chronosCtx);
      const exitSignalName = exit ? (exit.action ?? "EXIT") : closeRule ? `RULE_${closeRule.rule}` : null;
      const { fire: exitConfirmed } = registerExitSignal(p.position, exitSignalName, confirmTicks);
      let action = null;
      if (closeRule?.action === "CLOSE" && exitConfirmed) {
        action = { tool: "close_position", args: { position_address: p.position, reason: closeRule.reason }, label: `close (${closeRule.reason})` };
      } else if ((p.unclaimed_fees_true_usd ?? p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        action = { tool: "claim_fees", args: { position_address: p.position }, label: "claim fees" };
      }
      // LLM-set free-text instructions have no execution path in standalone — hold.
      if (!action) continue;
      const res = await executeTool(action.tool, action.args).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      log("manage", `${p.pair ?? p.position.slice(0, 8)}: ${action.label} ${ok ? "done" : `FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
    return null;
  } finally {
    manageBusy = false;
  }
}

// Fast exit poller (RPC + Meteora deposits, no LLM). An exit fires only after
// `confirmTicks` consecutive confirming polls; confirmed exits close directly.
function startPnlPoller() {
  if (config.standalone.shadow) return;
  const pollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  timers.pnl = setInterval(async () => {
    if (manageBusy || pollBusy || shuttingDown) return;
    if (getTrackedPositions(true).length === 0) return;
    pollBusy = true;
    try {
      const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!live?.positions?.length) return;
      for (const p of live.positions) {
        const cachedChronos = getCachedChronosAnalysis(p.pool);
        const chronosCtx = cachedChronos
          ? { ...(cachedChronos.tactical_signals ?? {}), oor_below_outlook: cachedChronos.oor_below_outlook }
          : null;
        confirmPeak(p.position, p.pnl_pct, confirmTicks);
        const exit = updatePnlAndCheckExits(p.position, p, config.management, chronosCtx);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management, chronosCtx);
        let signal = null, reason = null;
        if (exit) { signal = exit.action ?? "EXIT"; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; }
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;
        log("poll", `Exit confirmed (${confirmTicks} ticks): ${p.pair ?? p.position.slice(0, 8)} — ${reason} — closing`);
        manageBusy = true; // hold the slow cycle off this position
        try {
          const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
          const ok = res?.success !== false && !res?.error && !res?.blocked;
          log("poll", `${p.pair ?? p.position.slice(0, 8)}: ${ok ? "closed" : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
        } finally {
          manageBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      pollBusy = false;
    }
  }, pollMs);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function startHeartbeat() {
  timers.heartbeat = setInterval(() => {
    const stats = monitor?.stats ?? {};
    const active = Object.values(store.data.signals).filter(s => !s.done).length;
    const pending = Object.keys(store.data.pending).length;
    const lag = stats.lastLagMs != null ? `${(stats.lastLagMs / 1000).toFixed(1)}s` : "n/a";
    log("heartbeat", `mode=${config.standalone.shadow ? "shadow" : "live"} | monitor tx=${stats.transactions ?? 0} entries=${stats.entries ?? 0} lag=${lag} pending=${pending} errors=${stats.errors ?? 0} | signals active=${active} queued=${signalQueue.length}`);
    store.prune();
    store.save();
  }, 60_000);
}

async function recordResearch(mint, screened, sources, convergence = null) {
  if (!config.standalone.shadow || !config.research.enabled || shuttingDown) return;
  const records = store.data.research ??= {};
  const key = convergence ? `convergence:${mint}` : mint;
  const current = records[key];
  if (current && Date.now() - current.at < 300_000) {
    current.sources = [...new Set([...current.sources, ...sources])];
    store.save();
    return `Shadow research: ${current.plans.length} range/shape variants.`;
  }
  const plans = convergence?.plans ?? await entryPlans(screened.pool);
  if (shuttingDown || !config.standalone.shadow) return;
  const latest = records[key];
  records[key] = {
    at: Date.now(), mint, pool: screened.pool.pool_address,
    source: convergence ? "convergence" : "discovery",
    capital: convergence?.capital,
    marketCap: screened.token.mcap,
    decimals: screened.decimals,
    binStep: Number(screened.pool.dlmm_params?.bin_step),
    sources: [...new Set([...(latest?.sources ?? []), ...sources])],
    plans,
  };
  store.save();
  log("research", `${mint} ${plans.length} shadow plans (${sources.join(", ")})`);
  const fib = plans.find(plan => plan.range === "fibonacci");
  return `Shadow research: ${plans.length} range/shape variants.${fib ? ` Fibonacci ≈ ${fib.widthBins} bins${fib.wideRange ? " (wide range)" : ""}; ${fib.entryZoneReached ? "upper level reached" : "waiting for upper level"}.` : " Fibonacci waiting for candle history."}`;
}

async function lifecycleStatusLines(detailed = false) {
  const [wallet, book] = await Promise.all([
    getWalletBalances({ force: true, nativeOnly: true }),
    getMyPositions({ silent: true }),
  ]);
  const lines = [
    `Wallet on-chain ${wallet.wallet || book.wallet || "belum tersedia"}`,
    `Saldo ${!wallet.error && Number.isFinite(wallet.sol) ? `${wallet.sol.toFixed(4)} SOL` : "belum tersedia"}`,
  ];
  if (book.error || !Array.isArray(book.positions)) {
    lines.push("Posisi dan PnL belum tersedia.");
  } else {
    const unit = config.management.solMode ? "SOL" : "USD";
    const known = book.positions.filter(p => Number.isFinite(p.pnl_usd) && !p.pnl_pct_suspicious);
    const pnl = known.reduce((sum, p) => sum + p.pnl_usd, 0);
    lines.push(`Posisi on-chain ${book.positions.length}`);
    lines.push(`PnL on-chain terbuka ${known.length ? `${signed(pnl)} ${unit}` : book.positions.length ? "belum tersedia" : "—"}${known.length < book.positions.length ? ` (${known.length}/${book.positions.length} terukur)` : ""}`);
    for (const p of book.positions.slice(0, 10)) {
      const pct = !p.pnl_pct_suspicious && Number.isFinite(p.pnl_pct) ? `${p.pnl_pct.toFixed(2)}%` : "PnL belum tersedia";
      const range = typeof p.in_range === "boolean" ? (p.in_range ? "in range" : "out of range") : "range belum tersedia";
      lines.push(`• ${String(p.pair || p.position).slice(0, 80)} · ${pct} · ${range}`);
    }
    if (book.positions.length > 10) lines.push(`+${book.positions.length - 10} posisi lainnya`);
  }
  const now = Date.now();
  const resetAt = store.data.pnlResetAt?.[config.standalone.shadow ? "shadow" : "live"] ?? 0;
  const from = Math.max(now - 86_400_000, resetAt);
  if (resetAt > now - 86_400_000) lines.push(`Periode PnL sejak reset ${new Date(resetAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`);
  if (!config.standalone.shadow) {
    const closed = getPerformanceHistory({ hours: 24, limit: 10000 }).positions.filter(p =>
      Date.parse(p.closed_at) >= from && Number.isFinite(p.pnl_usd) && p.pnl_source !== "unavailable");
    const estimated = closed.filter(p => p.pnl_source === "cached").length;
    lines.push(closed.length ? `PnL LP ditutup · ${signed(closed.reduce((n,p) => n + p.pnl_usd, 0))} USD · ${closed.length} posisi${estimated ? ` (${estimated} estimasi)` : ""}` : "PnL LP ditutup · belum ada catatan");
  }
  const research = Object.values(store.data.research ?? {}).filter(item => now - item.at < 86_400_000);
  if (config.standalone.shadow && config.research.enabled) {
    lines.push(`Riset 24 jam ${research.length} kandidat · ${research.reduce((sum, item) => sum + item.plans.length, 0)} rencana entry`);
    const paper = store.data.paper;
    lines.push(...paperPnlLines(summarizePaper(paper, from, now), detailed));
    const open = Object.values(paper?.open ?? {});
    const recent = (paper?.closed ?? []).filter(p => p.accountingVersion && Date.now() - p.closedAt < 86_400_000);
    const cancelled = (paper?.cancelled ?? []).filter(p => Date.now() - p.at < 86_400_000).length;
    const pending = open.filter(p => p.exit).length;
    lines.push(`Paper · ${open.filter(p => p.filledAt).length} terisi · ${open.filter(p => !p.filledAt).length} tunggu fill · ${recent.length} selesai/24j · ${cancelled} batal${pending ? ` · ${pending} tunggu quote` : ""}`);
    const rows = (paper?.nav?.["convergence/baseline"] ?? []).filter(r => r.day < paperDay(Date.now()) && r.complete && r.start > 0 && r.end != null).slice(-30);
    const average = rows.reduce((sum, r) => sum + (r.end / r.start - 1), 0) / rows.length;
    const rec = recommendPaperVariant([...(paper?.closed ?? []), ...(paper?.cancelled ?? [])].sort((a,b) => a.openedAt-b.openedAt), Date.now());
    lines.push(rows.length ? `Baseline · ${(average * 100).toFixed(2)}% rata-rata/hari · ${rows.length}/30 hari valid` : "Baseline · belum ada hari valid");
    if (rec) lines.push(`Uji parameter · ${rec.variant.split("/").at(-1)} unggul ${rec.test.toFixed(4)} SOL/token pada ${rec.testMints} token validasi`);
    const tracked = Object.keys(store.data.wallets).length;
    if (tracked < config.standalone.walletThreshold) lines.push(`Convergence · ${tracked}/${config.standalone.walletThreshold} wallet siap`);
  }
  const { received, retries, waiting, passed, dropped, reasons } = discoveryStats;
  lines.push(`Discovery sejak restart ${received} masuk · ${waiting} antre · ${retries} retry · ${passed} lolos · ${dropped} kedaluwarsa/tergeser`);
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topReasons.length) lines.push(`Kendala ${topReasons.map(([reason, n]) => `${reason} ×${n}`).join(" · ")}`);
  if (detailed) {
    try {
      const saved = store.database.get("overnight");
      lines.push(`Arsip semalam · ${saved.periodWib} · ${saved.uniqueClosedMints} mint selesai`);
      for (const v of saved.variants.slice(0, 10)) lines.push(`• ${v.variant} · ${signed(v.realized)} SOL · ${v.closed} close`);
    } catch { /* Archive is optional. */ }
  }
  return lines;
}

function startLifecycleReports() {
  const minutes = config.lifecycleReportMinutes;
  if (!(minutes >= 1 && minutes <= 1440)) return;
  let busy = false;
  const report = async () => {
    if (busy || shuttingDown) return;
    busy = true;
    try {
      const lines = [`📊 Meridian • ${config.standalone.shadow ? "SHADOW" : "LIVE"}`, ...await lifecycleStatusLines()];
      if (!shuttingDown) {
        await notify(lines.join("\n"));
        log("lifecycle", "Wallet, position and PnL report generated");
      }
    } catch {
      log("lifecycle_warn", "Wallet report unavailable");
    } finally {
      busy = false;
    }
  };
  timers.lifecycle = setInterval(() => void report(), minutes * 60_000);
  void report();
}

function acquireLock() {
  lockPath = repoPath("standalone.lock");
  if (fs.existsSync(lockPath)) {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* not running or invalid pid */ }
    if (alive && pid !== process.pid) throw new Error(`Another standalone instance is running (pid ${pid}) — refusing to start`);
    log("runtime", `Removing stale standalone lock (pid ${pid || "unknown"} is not running)`);
    fs.rmSync(lockPath);
  }
  fs.writeFileSync(lockPath, String(process.pid));
}

async function shutdown(signalName, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("runtime", `${signalName} received — shutting down`);
  stopChronosKeepalive();
  for (const timer of Object.values(timers)) clearInterval(timer);
  stopPaper?.();
  await Promise.race([stopDiscovery?.(), sleep(3000)]);
  try { stopAdmin?.(); } catch { /* best-effort */ }
  try { await monitor?.stop(); } catch { /* best-effort */ }
  // Bound best-effort stop notices so either transport can be unavailable.
  await Promise.race([notify(`🛑 Meridian stopped (${signalName})`), sleep(3000)]).catch(() => {});
  setNotificationMirror(null);
  await Promise.race([slackAdmin?.stop(), sleep(3000)]).catch(() => {});
  try { if (lockPath) fs.rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
  process.exit(exitCode);
}

export async function startStandalone() {
  if (!config.standalone.monitorRpcUrl) throw new Error("Standalone requires RPC_URL or MONITOR_RPC_URL");
  acquireLock();

  store = new MonitorStore();
  log("runtime", `SQLite storage mode=${store.database.mode}`);
  for (const [mint, attempt] of Object.entries(store.data.attempts)) {
    if (attempt.status === "submitting") {
      log("runtime_warn", `Mint ${mint.slice(0, 8)} was mid-submit at shutdown (position ${attempt.position ?? "unknown"}, txs ${attempt.txs?.length ?? 0}) — reconcile on-chain before re-enabling entries`);
    }
  }

  monitor = new WalletMonitor(store, config.standalone, { onSignal });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log("runtime", `Standalone starting — ${config.standalone.shadow ? "SHADOW MODE (proposals recorded, nothing submitted)" : "LIVE MODE"} | threshold=${config.standalone.walletThreshold} wallets / ${config.standalone.windowSec}s window | screening deadline=${config.standalone.screeningDeadlineSec}s`);

  await monitor.start();
  if (!monitor.healthy()) {
    log("runtime_warn", "Monitor baseline incomplete — wallets without a portfolio baseline produce no signals until reconciliation succeeds");
  }
  for (const s of Object.values(store.data.signals)) {
    if (!s.done && s.deadline > Date.now()) onSignal(s);
  }

  // Entries come only from signals; exits run on their own cadences.
  if (!config.standalone.shadow) {
    timers.manage = setInterval(() => { void manageOnce(); }, Math.max(1, config.schedule.managementIntervalMin) * 60_000);
    void manageOnce();
  }
  startPnlPoller();
  startHeartbeat();
  startChronosKeepalive();
  const adminOptions = {
    monitor,
    statusDetails: () => lifecycleStatusLines(true),
    resetPnl: () => {
      store.data.pnlResetAt ??= {};
      store.data.pnlResetAt[config.standalone.shadow ? "shadow" : "live"] = Date.now();
      store.save();
    },
    activeSignals: () => Object.values(store.data.signals).filter(s => !s.done).length,
    restart: async (send, beforeRestart) => {
      if (pursuing || manageBusy || pollBusy) {
        await send("Meridian sedang memproses pekerjaan. Coba restart lagi setelah selesai.");
        return;
      }
      beforeRestart?.();
      await shutdown("Admin restart", 1);
    },
  };
  stopAdmin = startAdmin(adminOptions);
  slackAdmin = await startSlackAdmin(adminOptions);
  setNotificationMirror(slackAdmin?.sendMessage ?? null);
  stopDiscovery = startDiscovery({
    gmgnKey: process.env.GMGN_API_KEY?.trim(),
    heliusKey: process.env.HELIUS_API_KEY?.trim(),
    notify,
    thresholds: shadowScreeningThresholds(),
    onMatch: recordResearch,
    stats: discoveryStats,
  });
  if (config.standalone.shadow && config.research.enabled) stopPaper = startPaper(store, notify);
  startLifecycleReports();

  const trackedWallets = Object.keys(store.data.wallets).length;
  void notify(`🤖 Meridian started — ${config.standalone.shadow ? "SHADOW (nothing submitted)" : "LIVE"}\n${trackedWallets} wallet(s) monitored | trigger: ${config.standalone.walletThreshold} within ${config.standalone.windowSec}s | exits: ${config.pnl.pollIntervalSec}s poller`);

  log("runtime", `Running — exits every ${config.schedule.managementIntervalMin}m + ${config.pnl.pollIntervalSec}s poller; waiting for wallet convergence`);
}
