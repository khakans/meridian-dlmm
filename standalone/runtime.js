// Standalone orchestrator: monitor → convergence signal → focused screening →
// revalidated deploy → deterministic exits. No Meridian server, no LLM authority.
//
// Entry and exit paths are independent: exits keep running while a signal is
// being screened, and wallet mutations are serialized by the wallet lock
// (close_position > other writes > deploy_position) in standalone/transactions.js.

import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { sendNotification as notify, setNotificationMirror } from "../telegram.js";
import { MonitorStore, finishSignal } from "./store.js";
import { WalletMonitor } from "./monitor.js";
import { screenMint, poolDetail } from "./screening.js";
import { startDiscovery } from "./discovery.js";
import { isActivePaperVariant } from "./entry-plans.js";
import { mirrorExitReason, prepareMirrorPosition, startPaper, validateExitQuote } from "./paper.js";
import { advanceSettlement, dueSettlements, settlementRows } from "./settlement.js";
import { positionWrites, reconcilePositionWrites } from "./position-journal.js";
import { readRpc } from "./rpc.js";
import { withWalletLock } from "./transactions.js";
import { paperDay } from "./paper-accounting.js";
import { getPerformanceHistory } from "../performance.js";
import { paperPnlLines, paperRealizedLine, signed, summarizePaper } from "./pnl-summary.js";
import { openPositions, positionsPage, positionTarget } from "./positions-view.js";
import { exposureStillPresent } from "./events.js";
import { getActiveBin, getMyPositions, simulateEntryPosition } from "../tools/dlmm.js";
import { executeTool, validateDeployPoolThresholds } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPosition, getTrackedPositions, syncOpenPositions, trackPosition } from "../state.js";
import { latchLowerRangeExit } from "../state.js";
import { recordPositionSnapshot } from "../pool-memory.js";
import { computeBinsBelow, lowerRangeStop } from "../exit-rules.js";
import { startAdmin } from "./telegram-admin.js";
import { startSlackAdmin } from "./slack-admin.js";
import { analyzePoolWithChronos, startChronosKeepalive, stopChronosKeepalive } from "./chronos.js";

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
let preflight = null;
let settlementBusy = false;
let entryInFlight = false;

async function reconcileEntries() {
  if (entryInFlight) return;
  for (const [mint, attempt] of Object.entries(store.data.attempts)) {
    if (attempt.status !== "submitting") continue;
    const rows = attempt.position ? await reconcilePositionWrites(attempt.position) : [];
    if (rows.some(row => row.status === "pending")) continue;
    if (!attempt.journalVersion && !rows.length) continue;
    const confirmed = rows.filter(row => row.stage === "entry" && row.status === "confirmed");
    if (confirmed.length) {
      const book = await getMyPositions({ force: true, silent: true });
      const position = book.positions?.find(p => p.position === attempt.position);
      if (book.error || !position) {
        const account = await readRpc("monitor", c => c.getAccountInfo(new PublicKey(attempt.position), "finalized"));
        if (account) continue;
        // A confirmed signature with no account still requires attribution before re-entry.
        attempt.status = "review_required";
      } else {
        if (!getTrackedPosition(attempt.position)) trackPosition({
          position: attempt.position, pool: position.pool, pool_name: position.pair,
          strategy: attempt.strategy, amount_sol: attempt.amountSol,
          bin_step: attempt.binStep, bin_range: { min: position.lower_bin, max: position.upper_bin },
        });
        attempt.status = "entered";
        attempt.txs = confirmed.map(row => row.signature);
      }
    } else {
      attempt.status = "failed";
      attempt.failures = (attempt.failures ?? 0) + 1;
    }
    attempt.at = Date.now();
    const signal = store.data.signals[mint];
    if (signal && !signal.done) finishSignal(store, signal, `recovered entry: ${attempt.status}`);
    else store.save();
    log("recovery", `${mint.slice(0, 8)} entry reconciled: ${attempt.status}`);
  }
}

function riskGate(positions, cash, shadow, now = Date.now()) {
  if (shadow ? positions.some(p => p.exit || p.manualExit || p.hardLowerExit) :
    settlementRows().some(row => !["swapped", "no_balance"].includes(row.status))) {
    return "position settlement pending";
  }
  const values = positions.map(p => shadow
    ? (!p.markIssue && p.mark?.at <= now && now - p.mark.at <= 180_000 ? p.capital + p.mark.pnl : null)
    : p.equity_sol);
  if (!Number.isFinite(cash) || values.some(value => !Number.isFinite(value) || value < 0)) return "portfolio equity unavailable";
  const equity = cash + values.reduce((sum, value) => sum + value, 0);
  const day = paperDay(now);
  const prior = store.data.strategyRisk;
  const state = {
    day, equity, start: prior?.day === day ? prior.start : equity, peak: Math.max(prior?.peak ?? 0, equity),
  };
  store.data.strategyRisk = state;
  store.save();
  if (state.start > 0 && equity <= state.start * (1 - config.research.paperDailyLossLimitPct / 100)) return "daily loss limit reached";
  if (state.peak > 0 && equity <= state.peak * (1 - config.research.paperDrawdownLimitPct / 100)) return "drawdown limit reached";
  return null;
}

function startSettlementWorker() {
  if (config.standalone.shadow) return;
  timers.settlement = setInterval(async () => {
    if (shuttingDown || settlementBusy) return;
    const next = dueSettlements()[0];
    settlementBusy = true;
    try {
      const result = await withWalletLock(async () => {
        await reconcileEntries();
        const fresh = next && dueSettlements().find(r => r.id === next.id);
        return fresh && !shuttingDown ? advanceSettlement(fresh) : null;
      }, 1);
      if (result?.status === "closing" && result.retryClose && !shuttingDown) {
        await executeTool("close_position", { position_address: result.id, reason: "resume interrupted close" });
      }
      if (["swapped", "no_balance"].includes(result?.status)) {
        await notify(`✅ LP settlement selesai\nPosition ${result.id}\nPnL net ${Number.isFinite(result.netSol) ? signed(result.netSol) + " SOL" : "belum tersedia"}${result.signature ? "\nTx: " + result.signature : ""}`);
      }
    } catch { log("settlement_warn", "Settlement retry unavailable"); }
    finally { settlementBusy = false; }
  }, 10_000);
}

async function refreshPreflight() {
  if (preflight && Date.now() - preflight.at < 60_000) return preflight;
  const sample = [store.data.preflightCandidate, ...Object.values(store.data.research ?? {})].filter(c => c && Date.now() - c.at < 300_000)
    .sort((a,b) => b.at - a.at)[0];
  const result = { at: Date.now(), pool: "belum ada sampel segar", quote: "belum diuji", simulation: "belum diuji" };
  if (sample) {
    try {
      const screened = await screenMint(sample.mint, { poolAddress: sample.pool });
      result.pool = screened.pass ? "lolos screening ulang" : screened.reason;
      if (screened.pass) {
        const binsBelow = Math.max(config.strategy.minBinsBelow, Math.min(69, computeBinsBelow(screened.pool.volatility)));
        try {
          await validateExitQuote({ mint: sample.mint, pool: sample.pool, decimals: screened.decimals,
            binStep: Number(screened.pool.dlmm_params?.bin_step), binsBelow,
            capital: config.risk.maxDeployAmount });
          result.quote = "lolos ukuran maksimum";
        } catch { result.quote = "tidak lolos atau provider gagal"; }
        try {
          const sim = await simulateEntryPosition({ poolAddress: sample.pool, binsBelow, capital: config.risk.maxDeployAmount });
          result.simulation = sim.err ? `RPC menolak ${JSON.stringify(sim.err).slice(0, 120)}` : "lolos tanpa broadcast";
        } catch { result.simulation = "build atau RPC belum tersedia"; }
      }
    } catch { result.pool = "data tidak tersedia"; }
  }
  return preflight = result;
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
  log("signal", `${signal.source ?? "convergence"} on ${signal.mint.slice(0, 8)}: ${signal.events.length} wallets [${wallets}] — screening with ${config.standalone.screeningDeadlineSec}s deadline`);
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
  if (!config.standalone.shadow && Object.values(store.data.attempts).some(a => a.status === "submitting" || a.status === "review_required")) {
    return "an earlier entry needs on-chain reconciliation";
  }
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
  const shadow = config.standalone.shadow;
  const source = signal.source ?? "convergence";
  const paper = store.data.paper;
  const mirror = Object.values(paper?.open ?? {}).filter(p => p.mirror);
  const positions = shadow ? { positions: mirror } : await getMyPositions({ force: true }).catch(() => null);
  if (!positions || positions.error || !Array.isArray(positions.positions)) return "position read unavailable";
  if (positions.positions.length >= config.risk.maxPositions ||
      positions.positions.some(p => (p.mint ?? p.base_mint) === mint)) {
    finishSignal(store, signal, "portfolio full or mint already open");
    return null;
  }

  // Focused screening: this mint and its eligible pools only.
  let screened;
  try {
    screened = await screenMint(mint, { poolAddress: signal.pool });
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

  const simulatedSol = shadow ? config.research.paperBankrollSol + (paper?.mirrorRealized ?? 0) -
    mirror.reduce((total, p) => total + p.capital, 0) : null;
  const gate = await finalRecheck(signal, screened, simulatedSol);
  if (gate) return gate;

  const balances = shadow ? { sol: simulatedSol } : await getWalletBalances({ force: true, nativeOnly: true });
  if (balances.error || !Number.isFinite(balances.sol)) return "balance read unavailable";
  if (balances.sol < config.management.minSolToOpen + config.management.gasReserve) return "insufficient spendable SOL";
  const risk = riskGate(positions.positions, balances.sol, shadow);
  if (risk) return risk;

  const pool = screened.pool;
  // Both execution paths use the same SOL-only range and allocation.
  const binsAbove = 0;
  const rawBinsBelow = computeBinsBelow(pool.volatility);
  let binsBelow = Math.max(config.strategy.minBinsBelow, Math.min(rawBinsBelow, 69));

  // Chronos AI Pre-Deploy Gate & Dynamic Bin Calibration (InstaBox 5-Node Cluster + Fallback)
  const chronos = await analyzePoolWithChronos(pool.pool_address, {
    binStep: pool.dlmm_params?.bin_step ?? 100,
    activePrice: pool.pool_price,
    defaultBinsAbove: binsAbove,
    defaultBinsBelow: binsBelow,
    minBinsBelow: MIN_SAFE_BINS_BELOW,
  }).catch(() => null);

  let convictionMult = 1.0;
  if (chronos) {
    if (chronos.gate?.action === "DEFER") {
      log("chronos_gate", `Deferred ${mint.slice(0, 8)} (${pool.pool_address.slice(0, 8)}): ${chronos.gate.reason}`);
      return `chronos gate: ${chronos.gate.reason}`;
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
    const s = chronos.summary ?? {};
    log(
      "chronos",
      `Pool ${pool.pool_address.slice(0, 8)} [${chronos.engine}]: P10=${s.p10_pct}% P50=${s.p50_pct}% P90=${s.p90_pct}% RSI=${s.rsi_14} BB%B=${s.bb_pct_b} → bins=${binsBelow}↓/${binsAbove}↑ convMult=${convictionMult} (${chronos.latency_ms}ms)`,
    );
  }
  const amountY = computeDeployAmount(balances.sol, convictionMult);
  const minDeploy = Math.max(0.1, Number((config.management.deployAmountSol * 0.75).toFixed(2)));
  if (!(amountY >= minDeploy && amountY <= config.risk.maxDeployAmount &&
        amountY + config.management.gasReserve <= balances.sol)) return "invalid or unaffordable position size";
  if (positions.positions.some(p => p.pool === pool.pool_address)) return "pool already open";
  const poolCheck = await validateDeployPoolThresholds({ pool_address: pool.pool_address });
  if (!poolCheck.pass) return poolCheck.reason;
  let entry, model;
  try {
    entry = await validateExitQuote({
      mint, pool: pool.pool_address, decimals: screened.decimals,
      binStep: Number(pool.dlmm_params?.bin_step), binsBelow, capital: amountY, verifyRange: true,
    });
    model = prepareMirrorPosition({ source, mint, pool: pool.pool_address, pair: pool.name,
      decimals: screened.decimals, binStep: Number(pool.dlmm_params?.bin_step), binsBelow,
      capital: amountY, shape: config.strategy.strategy, entry });
  } catch { return "exit quote or entry range unavailable"; }
  const fresh = await finalRecheck(signal, screened, simulatedSol);
  if (fresh) return fresh;
  if (shadow) {
    if (!Number.isSafeInteger(entry.binId) || (await getActiveBin({ pool_address: pool.pool_address })).binId !== entry.binId) {
      return "active bin changed after entry validation";
    }
    if (shuttingDown || Date.now() >= signal.deadline) return "entry window expired";
    paper.realized[model.variant] ??= 0;
    paper.open[model.id] = model;
    store.data.attempts[mint] = { at: Date.now(), mint, pool: pool.pool_address, status: "entered", amountSol: amountY };
    finishSignal(store, signal, "entered");
    return null;
  }
  // Checkpoint before building anything: a crash mid-sequence leaves a
  // recovery pointer instead of a silent duplicate-entry risk.
  store.data.attempts[mint] = {
    at: Date.now(), mint, pool: pool.pool_address, wallets: signal.events.map(e => e.wallet),
    status: "submitting", failures: attempt?.failures ?? 0, position: null, txs: [],
    amountSol: amountY, strategy: config.strategy.strategy, binStep: entry.binStep, journalVersion: 1,
  };
  store.save();

  let submitted = 0;
  entryInFlight = true;
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
    expected_active_bin: entry.binId,
    strategy: config.strategy.strategy,
    before_submit: async (stage = "lp") => {
      // Always recheck before the pre-deploy swap AND before the first LP creation tx.
      // Subsequent chunks of a multi-tx LP creation skip recheck so a half-built position completes.
      if (stage !== "swap" && submitted++ > 0) return;
      const fresh = await finalRecheck(signal, screened);
      if (fresh) throw new Error(`Pre-submit recheck failed: ${fresh}`);
      const active = await getActiveBin({ pool_address: pool.pool_address });
      if (active.binId !== entry.binId) throw new Error("Active bin changed before entry");
    },
    on_prepared: position => {
      store.data.attempts[mint].position = position;
      store.save();
    },
  }).catch(e => ({ error: e.message })).finally(() => { entryInFlight = false; });

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
    log("entry", `${label} ${amountY} SOL → pool ${pool.pool_address.slice(0, 8)} mint ${mint.slice(0, 8)} (${binsBelow} bins below, ${source})`);
    void notify(`${result.dry_run ? "🕯️ Shadow proposal" : "✅ Entry"}: ${amountY} SOL → ${pool.pool_address.slice(0, 8)} (mint ${mint.slice(0, 8)}, ${signal.events.length} wallets)`);
    return null;
  }

  if (record.position && positionWrites(record.position).some(row => ["pending", "confirmed"].includes(row.status))) {
    store.save();
    finishSignal(store, signal, "entry submitted; awaiting on-chain reconciliation");
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
  if (shuttingDown || Date.now() >= signal.deadline) return "entry window expired";
  let present = 0;
  for (const e of signal.events) {
    try { if (await exposureStillPresent(e)) present++; } catch { /* unreadable position = not confirmed */ }
  }
  if (signal.source !== "discovery" && present < config.standalone.walletThreshold) {
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
    for (const p of live.positions) {
      recordPositionSnapshot(p.pool, p);
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
  let lastDecisionAt = 0;
  timers.pnl = setInterval(async () => {
    if (pollBusy || shuttingDown) return;
    const tracked = getTrackedPositions(true);
    if (tracked.length === 0) return;
    pollBusy = true;
    try {
      if (config.management.outOfRangeBelowStopPct > 0) {
        const pools = new Map();
        const breaches = await Promise.all(tracked.map(async p => {
          if (p.hard_lower_exit) return { p, reason: p.hard_lower_exit };
          if (!p.pool || !Number.isSafeInteger(p.bin_range?.min)) return null;
          if (!pools.has(p.pool)) pools.set(p.pool, getActiveBin({ pool_address: p.pool }).catch(() => null));
          const active = await pools.get(p.pool);
          const reason = lowerRangeStop(active?.binId, p.bin_range.min, active?.binStep, config.management.outOfRangeBelowStopPct);
          if (!reason || shuttingDown) return null;
          const latched = latchLowerRangeExit(p.position, reason);
          return latched ? { p, reason: latched } : null;
        }));
        for (const breach of breaches.filter(Boolean)) {
          if (shuttingDown || manageBusy) return;
          manageBusy = true;
          try {
            const { p, reason } = breach;
            const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
            log("poll", `${p.position.slice(0, 8)}: ${reason} — ${res?.error || res?.reason || (res?.success ? "closed" : "unconfirmed")}`);
          } finally { manageBusy = false; }
        }
        if (breaches.some(Boolean)) return;
      }
      const now = Date.now();
      if (manageBusy || shuttingDown || now - lastDecisionAt < 60_000) return;
      lastDecisionAt = now;
      const live = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!live || live.error || !Array.isArray(live.positions)) return;
      const states = store.data.mirrorExits ??= {};
      const openIds = new Set(live.positions.map(p => p.position));
      for (const id of Object.keys(states)) if (!openIds.has(id)) delete states[id];
      for (const p of live.positions) {
        if (![p.active_bin, p.lower_bin, p.upper_bin].every(Number.isSafeInteger)) continue;
        const trackedPosition = getTrackedPosition(p.position);
        const openedAt = Date.parse(p.opened_at ?? trackedPosition?.deployed_at);
        const state = states[p.position] ??= {
          id: p.position,
          openedAt: typeof p.opened_at === "number" ? p.opened_at :
            Number.isFinite(openedAt) ? openedAt : now - (p.age_minutes ?? 0) * 60_000,
          rangeReached: true,
        };
        state.lower = p.lower_bin;
        state.upper = p.upper_bin;
        const pnlPct = Number.isFinite(p.strategy_pnl_pct) ? p.strategy_pnl_pct : null;
        const reason = state.closeReason ?? mirrorExitReason(state, { binId: p.active_bin }, pnlPct, now);
        if (!reason) continue;
        state.closeReason = reason;
        store.save();
        manageBusy = true;
        try {
          const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
          log("poll", `${p.position.slice(0, 8)}: ${reason} — ${res?.error || res?.reason || (res?.success ? "closed" : "unconfirmed")}`);
        } finally { manageBusy = false; }
      }
      store.save();
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

async function lifecycleStatusLines(detailed = false) {
  const [wallet, book] = await Promise.all([
    getWalletBalances({ force: true, nativeOnly: true }),
    getMyPositions({ silent: true }),
  ]);
  const lines = [
    `Wallet on-chain ${wallet.wallet || book.wallet || "belum tersedia"}`,
    `Saldo ${!wallet.error && Number.isFinite(wallet.sol) ? `${wallet.sol.toFixed(4)} SOL` : "belum tersedia"}`,
  ];
  const settlements = config.standalone.shadow ? [] : settlementRows();
  const unsettled = settlements.filter(r => !["swapped", "no_balance"].includes(r.status));
  lines.push(`Kesehatan · monitor ${monitor?.healthy() ? "siap" : "belum siap"} · RPC wallet ${wallet.error ? "gagal" : "OK"}${unsettled.length ? ` · ${unsettled.length} settlement belum selesai` : ""}`);
  if (detailed) {
    const check = await refreshPreflight();
    lines.push(`Preflight · pool ${check.pool} · quote keluar ${check.quote}`);
    lines.push(`Simulasi build entry · ${check.simulation}`);
    if (unsettled.length) for (const row of unsettled.slice(0, 4)) {
      lines.push(`• Settlement ${row.id.slice(0, 8)} · ${row.status}${row.reason ? ` · ${row.reason}` : ""}`);
    }
    for (const [mint, d] of Object.entries(store.data.convergenceDiagnostics ?? {}).sort((a,b) => b[1].at-a[1].at).slice(0, 4)) {
      lines.push(`• ${mint.slice(0, 8)} · ${d.current} wallet / ${config.standalone.windowSec}s · ${d.wider} / ${Math.max(300,config.standalone.windowSec)}s${d.spreadSec == null ? "" : ` · selisih ${d.spreadSec}s`} · ${d.reason}`);
    }
  }
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
  const resetAt = store.data.pnlResetAt?.[store.database.mode] ?? 0;
  const from = Math.max(now - 86_400_000, resetAt);
  if (config.standalone.shadow) {
    const paper = store.data.paper;
    const mirror = { open: Object.fromEntries(Object.entries(paper?.open ?? {}).filter(([, p]) => p.mirror)),
      closed: (paper?.closed ?? []).filter(p => p.mirror) };
    lines.push(paperRealizedLine(summarizePaper(paper, from, now), "All"),
      ...paperPnlLines(summarizePaper(mirror, from, now), detailed, "discovery/volatility/mirror", "Mirror"));
    const legacy = Object.values(paper?.open ?? {}).filter(p => !p.mirror).length;
    if (legacy) lines.push(`Eksperimen lama · ${legacy} posisi terbuka di riwayat paper`);
  }
  if (resetAt > now - 86_400_000) lines.push(`Periode PnL sejak reset ${new Date(resetAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`);
  if (!config.standalone.shadow) {
    const recovering = Object.values(store.data.attempts).filter(row => row.status === "submitting").length;
    const review = Object.values(store.data.attempts).filter(row => row.status === "review_required").length;
    if (recovering || review) lines.push(`Recovery entry · ${recovering} rekonsiliasi · ${review} perlu diperiksa`);
    const settled = settlements.filter(row => ["swapped", "no_balance"].includes(row.status) && row.updatedAt >= from);
    const priced = settled.filter(row => Number.isFinite(row.netSol));
    const missing = settled.length - priced.length;
    lines.push(`PnL net settlement ${priced.length ? signed(priced.reduce((total, row) => total + row.netSol, 0)) + " SOL" : "—"} · ${priced.length} terukur · ${unsettled.length} tertunda${missing ? ` · ${missing} tanpa data lengkap` : ""}`);
    const closed = getPerformanceHistory({ hours: 24, limit: 10000 }).positions.filter(p =>
      Date.parse(p.closed_at) >= from && Number.isFinite(p.pnl_usd) && p.pnl_source !== "unavailable");
    const estimated = closed.filter(p => p.pnl_source === "cached").length;
    lines.push(closed.length ? `PnL LP sebelum settlement · ${signed(closed.reduce((n,p) => n + p.pnl_usd, 0))} USD · ${closed.length} posisi${estimated ? ` (${estimated} estimasi)` : ""}` : "PnL LP ditutup · belum ada catatan");
  }
  const signals = Object.values(store.data.signals).filter(signal => now - signal.createdAt < 86_400_000);
  const discovery = signals.filter(signal => signal.source === "discovery").length;
  lines.push(`Entry 24 jam · Discovery ${discovery} kandidat · Convergence ${signals.length - discovery} sinyal`);
  if (config.standalone.shadow) {
    const paper = store.data.paper;
    const open = Object.values(paper?.open ?? {}).filter(p => p.mirror);
    const closed = (paper?.closed ?? []).filter(p => p.mirror && now - p.closedAt < 86_400_000);
    lines.push(`Mirror · ${open.length} terbuka · ${closed.length} selesai/24j · ${open.filter(p => p.exit).length} tunggu settlement`);
  }
  const { received, retries, waiting, passed, dropped, reasons } = discoveryStats;
  lines.push(`Discovery sejak restart ${received} masuk · ${waiting} antre · ${retries} retry · ${passed} lolos · ${dropped} kedaluwarsa/tergeser`);
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topReasons.length) lines.push(`Kendala ${topReasons.map(([reason, n]) => `${reason} ×${n}`).join(" · ")}`);
  if (detailed && config.standalone.shadow) {
    try {
      const saved = store.database.get("overnight");
      lines.push(`Arsip semalam · ${saved.periodWib} · ${saved.uniqueClosedMints} mint selesai`);
      for (const v of saved.variants.filter(v => isActivePaperVariant(v.variant)).slice(0, 10)) lines.push(`• ${v.variant} · ${signed(v.realized)} SOL · ${v.closed} close`);
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

  if (config.standalone.shadow) stopPaper = startPaper(store, notify, { admitResearch: false });
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
  startSettlementWorker();
  startHeartbeat();
  startChronosKeepalive();
  const readBook = () => getMyPositions({ force: true, silent: true });
  const listCloseTargets = async () => (await openPositions({ store, readBook }))?.map(positionTarget);
  async function forceClosePositions(targets) {
    if (shuttingDown) return "Meridian sedang restart. Coba lagi setelah aktif.";
    if (store.database.mode === "shadow") {
      const open = store.data.paper?.open ?? {};
      const positions = targets.map(({ id }) => open[id]).filter(Boolean);
      const newlyQueued = positions.filter(p => !p.exit && !p.manualExit);
      for (const p of newlyQueued) p.manualExit = "manual force close";
      try { store.save(); }
      catch (error) {
        for (const p of newlyQueued) delete p.manualExit;
        throw error;
      }
      return `Shadow · ${newlyQueued.length} masuk antrean close · ${positions.length - newlyQueued.length} sudah diproses/antre · ${targets.length - positions.length} sudah tidak terbuka. Lifecycle menyelesaikan close setelah data tersedia.`;
    }
    if (config.standalone.shadow || process.env.DRY_RUN === "true") return "Mode berubah. Buka Positions lagi.";
    const current = await listCloseTargets();
    if (!current) return "Posisi on-chain gagal dibaca. Coba lagi.";
    const open = new Set(current.map(p => p.id));
    let closed = 0, skipped = 0;
    const failed = [];
    for (const target of targets) {
      if (shuttingDown || !open.has(target.id)) { skipped++; continue; }
      const result = await executeTool("close_position", { position_address: target.id, reason: "manual force close" })
        .catch(error => ({ error: error.message }));
      if (result?.success && !result.dry_run) closed++;
      else {
        failed.push(target.id);
        log("close_warn", `Slack force close ${target.id} failed: ${result?.error || result?.reason || "unknown"}`);
      }
    }
    return [`Live · ${closed} ditutup · ${skipped} dilewati · ${failed.length} gagal. Settlement ke SOL dipantau terpisah.`,
      ...failed.slice(0, 10).map(id => `Position ${id}`)].join("\n");
  }
  const adminOptions = {
    monitor,
    statusDetails: () => lifecycleStatusLines(true),
    positionDetails: (tab, page) => positionsPage({
      store, tab, page, readBook,
      getTracked: getTrackedPosition, getSettlements: settlementRows, solMode: config.management.solMode,
    }),
    listCloseTargets,
    forceClosePositions,
    resetPnl: () => store.resetPnl(),
    activeSignals: () => Object.values(store.data.signals).filter(s => !s.done).length,
    restart: async (send, beforeRestart) => {
      if (pursuing || manageBusy || pollBusy || settlementBusy) {
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
    onMatch: (mint, screened, sources) => {
      store.data.preflightCandidate = { mint, pool: screened.pool.pool_address, at: Date.now() };
      const now = Date.now();
      const prior = store.data.signals[mint];
      if (!shuttingDown && (!prior || (prior.done && now >= prior.cooldownUntil))) {
        const signal = { mint, pool: screened.pool.pool_address, source: "discovery", sources, events: [],
          createdAt: now, deadline: now + config.standalone.screeningDeadlineSec * 1000, done: false };
        store.data.signals[mint] = signal;
        store.save();
        onSignal(signal);
      } else store.save();
    },
    stats: discoveryStats,
  });
  startLifecycleReports();

  const trackedWallets = Object.keys(store.data.wallets).length;
  void notify(`🤖 Meridian started — ${config.standalone.shadow ? "SHADOW (nothing submitted)" : "LIVE"}\n${trackedWallets} wallet(s) monitored | trigger: ${config.standalone.walletThreshold} within ${config.standalone.windowSec}s | exits: ${config.pnl.pollIntervalSec}s poller`);

  log("runtime", `Running — exits every ${config.schedule.managementIntervalMin}m + ${config.pnl.pollIntervalSec}s poller; waiting for Discovery and Convergence`);
}
