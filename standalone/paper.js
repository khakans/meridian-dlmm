import { config } from '../config.js';
import { getDeterministicCloseRule, lowerRangeStop } from '../exit-rules.js';
import { log } from '../logger.js';
import { getActiveBin, getPaperBinSnapshot } from '../tools/dlmm.js';
import { quoteTokenToSol } from '../tools/wallet.js';
import { markPaperBins, paperRiskBlocked, recordPaperNav, seedPaperBins } from './paper-accounting.js';
import { ENTRY_SHAPES, entryCandles, isActivePaperVariant, narrowEntryRange } from './entry-plans.js';
import { assessRebalance, rebalanceDue, REBALANCE_CHECK_MS } from './paper-rebalance.js';
import { prepareTokenRunner, RUNNER_POLL_MS, sampleTokenRunner } from './paper-token-runner.js';
import { applyHoldCheck, holdEvidence, observeHold, updateLongRun } from './paper-long-run.js';

const MINUTE = 60_000;
const COST_SOL = 0.001; // Estimated round-trip network cost, excluding refundable rent.

export function entryRange(width, minimum = config.strategy.minBinsBelow, dual = false) {
  if (!dual) return { binsBelow: Math.max(minimum, Math.min(width, 69)), binsAbove: 0 };
  const binsBelow = Math.max(minimum, Math.ceil(Math.min(width, 69) / 2));
  const binsAbove = Math.max(0, Math.min(69 - binsBelow, Math.max(12, width - binsBelow)));
  return { binsBelow, binsAbove };
}

export function paperBins(plan, active, step) {
  if (plan.range !== 'volatility') return null;
  const ratio = 1 + step / 10_000;
  const [lower, upper] = [-plan.binsBelow, -1];
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper >= 0 ||
      lower > upper || upper - lower >= 200) return null;
  return { lower: active.binId + lower, upper: active.binId + upper, ratio };
}

export function paperInventory(position, activeBin) {
  const { lower, upper, entryPrice, entryBin, ratio, capital, shape } = position;
  let total = 0, sol = 0, tokens = 0;
  for (let bin = lower; bin <= upper; bin++) {
    const weight = shape === 'spot' ? 1 : shape === 'curve' ? bin - lower + 1 : upper - bin + 1;
    total += weight;
    if (bin > activeBin) tokens += weight / (entryPrice * ratio ** (bin - entryBin));
    else sol += weight;
  }
  return { sol: capital * sol / total, tokens: capital * tokens / total };
}

function rawTokens(amount, decimals) {
  const raw = Math.floor(amount * 10 ** decimals);
  if (!Number.isSafeInteger(raw) || raw < 0) throw Error('Paper token quantity out of range');
  return raw;
}

function validActive(active) {
  return Number.isSafeInteger(active?.binId) && Number.isFinite(Number(active?.price)) && Number(active.price) > 0;
}

export async function validateExitQuote({ mint, pool, decimals, binStep, binsBelow, binsAbove = 0, capital, verifyRange = false }) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      !(binStep > 0 && binsBelow > 0 && capital > 0)) throw Error('Invalid exit sizing inputs');
  const active = await getActiveBin({ pool_address: pool });
  if (!validActive(active)) throw Error('Active bin unavailable');
  const price = Number(active.price);
  const raw = rawTokens(capital / (price / (1 + binStep / 10_000) ** binsBelow), decimals);
  const quote = await quoteTokenToSol(mint, raw);
  const mark = raw / 10 ** decimals * price;
  if (quote < mark * config.research.paperMinExitRatio) throw Error('Exit quote below minimum');
  if (!verifyRange) return { ...active, exitRatio: quote / mark };
  if (Number(active.binStep) !== binStep) throw Error('Pool bin step changed');
  const bins = await getPaperBinSnapshot(pool, active.binId - binsBelow, active.binId + binsAbove, { verifyRange });
  return { ...active, bins, exitRatio: quote / mark };
}

export function prepareMirrorPosition({ source, mint, pool, pair, decimals, binStep, binsBelow, binsAbove = 0, capital, shape, entry, dualSide, pairEntry }, now = Date.now()) {
  const id = `mirror:${mint}:${now}`;
  const variant = source === 'convergence' ? 'convergence/baseline' : 'discovery/volatility/mirror';
  const costSol = config.research.mirrorRoundTripCostSol;
  const p = { id, mint, pool, pair, decimals, capital, source, shape, pairEntry, variant, mirror: true, range: 'volatility', costSol,
    lower: entry.binId - binsBelow, upper: entry.binId + binsAbove, entryBin: entry.binId, entryPrice: Number(entry.price),
    ratio: 1 + binStep / 10_000, openedAt: now, filledAt: now, rangeReached: true,
    mark: { at: now, pnl: -costSol - (dualSide?.buyCostSol ?? 0) } };
  p.binSeed = seedPaperBins(p, entry.bins, dualSide);
  return p;
}

export function prepareShapeTrials(input, mirror) {
  return ENTRY_SHAPES.map(shape => {
    const trial = shape === mirror.shape ? { ...mirror } : prepareMirrorPosition({ ...input, shape }, mirror.openedAt);
    return { ...trial, id: `${mirror.id}:${shape}`, mirror: false, shapeTrial: mirror.id,
      variant: `shape-comparison/${shape}` };
  });
}

export function prepareNarrowRangeTrial(input, mirror, candles, now) {
  if (input.pairEntry?.side !== 'single' || input.shape !== 'spot' || input.binsAbove > 0) return null;
  const binsBelow = narrowEntryRange(candles, { now, price: Number(input.entry.price), binStep: input.binStep },
    input.binsBelow, config.strategy.minBinsBelow);
  if (!binsBelow) return null;
  const trial = prepareMirrorPosition({ ...input, binsBelow }, mirror.openedAt);
  mirror.rangeComparison = true;
  return { ...trial, id: `${mirror.id}:narrow`, variant: 'range-comparison/narrow', mirror: false,
    rangeTrial: mirror.id, shapeMode: mirror.shapeMode, shapeReason: mirror.shapeReason };
}

function tracksRange(p) {
  return p.shapeTrial || p.shapeComparison || p.rangeTrial || p.rangeComparison;
}

export function paperLowerExit(p, active) {
  if (p.rangeTrial && Number.isSafeInteger(active.binId) && active.binId < p.lower) return 'narrow range lower bound breached';
  return lowerRangeStop(active.binId, p.lower, active.binStep ?? (p.ratio - 1) * 10_000,
    config.management.outOfRangeBelowStopPct);
}

export function narrowLossExit(p, pnl, fresh) {
  return p.rangeTrial && fresh && Number.isFinite(pnl) && p.capital > 0 && pnl <= -0.03 * p.capital
    ? 'narrow range net loss stop (3%)' : null;
}

export function paperCloseRule(p, active, pnlPct, now) {
  const outside = active.binId < p.lower ? 'below' : active.binId > p.upper ? 'above' : null;
  if (active.binId <= p.upper) p.rangeReached = true;
  if (outside !== p.outside) {
    p.outside = outside;
    p.outsideSince = outside ? now : null;
  }
  if (Number.isFinite(pnlPct)) p.peakPct = Math.max(p.peakPct ?? pnlPct, pnlPct);
  const m = config.management;
  const rule = getDeterministicCloseRule({
    position: p.id, pnl_pct: pnlPct, pnl_pct_suspicious: pnlPct == null,
    active_bin: active.binId, lower_bin: p.lower, upper_bin: p.upper,
    minutes_out_of_range: p.outsideSince ? (now - p.outsideSince) / MINUTE : 0,
  }, m);
  if (rule?.rule === 1) return rule.reason;
  if (p.longHold?.ended || now - p.openedAt >= (p.maxHoldMinutes ?? config.research.paperMaxHoldMinutes) * MINUTE) return 'maximum hold time';
  if (!p.rangeReached && outside === 'above') {
    return now - p.openedAt >= (p.rangeWaitMinutes ?? config.research.paperInitialRangeWaitMinutes) * MINUTE
      ? 'entry range not reached' : null;
  }
  const trailing = Number.isFinite(pnlPct) && m.trailingTakeProfit && p.peakPct >= m.trailingTriggerPct &&
    pnlPct <= p.peakPct - m.trailingDropPct;
  const reason = rule?.reason ?? (trailing ? 'trailing take profit' : null);
  if (!reason || pnlPct > 0) {
    p.lossExitSince = null;
    return reason;
  }
  p.lossExitSince ??= now;
  return now - p.lossExitSince >= config.research.paperLossGraceMinutes * MINUTE ? reason : null;
}

export function mirrorExitReason(p, active, pnlPct, now) {
  const reason = paperCloseRule(p, active, pnlPct, now);
  p.exitTicks = reason && reason === p.exitSignal ? (p.exitTicks ?? 0) + 1 : Number(Boolean(reason));
  p.exitSignal = reason;
  if (reason && p.exitTicks >= Math.max(1, config.pnl.confirmTicks)) return reason;
  return null;
}

export function startPaper(store, notify, {
  getBin = getActiveBin, snapshot = getPaperBinSnapshot, quote = quoteTokenToSol, schedule = setInterval, admitResearch = true,
  rebalancePlan, candles = entryCandles,
} = {}) {
  const paper = store.data.paper ??= { open: {}, closed: [], skipped: 0 };
  paper.realized ??= {};
  paper.cancelled ??= [];
  paper.legacy ??= [];
  const runners = paper.tokenRunners ??= { open: {}, closed: [] };
  for (const p of Object.values(paper.open)) {
    if (p.binSeed && p.range === 'volatility') continue;
    paper.legacy.push({ ...p, archivedAt: Date.now(), archiveReason: p.binSeed ? 'retired strategy' : 'missing entry snapshot' });
    delete paper.open[p.id];
  }
  let stopped = false, busy = false;
  async function tick() {
    if (busy || stopped || !config.standalone.shadow) return;
    busy = true;
    try {
      const now = Date.now();
      const cohorts = Object.values(paper.longRun?.open ?? {});
      const trackedLegs = new Set(cohorts.flatMap(c => Object.values(c.arms).flatMap(a => [a.lpId, a.entrySpotId])));
      const recent = rows => rows.filter(row => now - row.closedAt < 90 * 86_400_000);
      const keepTracked = (rows, limit) => {
        const newest = recent(rows).slice(-limit);
        const ids = new Set(newest.map(row => row.id));
        return [...rows.filter(row => trackedLegs.has(row.id) && !ids.has(row.id)), ...newest];
      };
      paper.closed = keepTracked(paper.closed, 10_000);
      paper.cancelled = paper.cancelled.filter(p => now - p.at < 90 * 86_400_000).slice(-10_000);
      runners.closed = keepTracked(runners.closed, 2000);
      if (paper.longRun) paper.longRun.closed = recent(paper.longRun.closed).slice(-2000);
      const activeReads = new Map();
      const quotes = new Map();
      const readActive = pool => {
        if (!activeReads.has(pool)) activeReads.set(pool, getBin({ pool_address: pool }).catch(() => null));
        return activeReads.get(pool);
      };
      const sellQuote = (mint, raw) => {
        if (!raw) return Promise.resolve(0);
        const key = `${mint}:${raw}`;
        if (!quotes.has(key)) quotes.set(key, quote(mint, raw).catch(() => null));
        return quotes.get(key);
      };
      const downsideQuoteRatio = async (p, active) => {
        const price = Number(active.price);
        const raw = rawTokens(p.capital / (price * p.ratio ** (p.lower - active.binId)), p.decimals);
        const value = raw / 10 ** p.decimals * price;
        const proceeds = await sellQuote(p.mint, raw);
        return value > 0 && proceeds != null ? proceeds / value : 0;
      };
      const candleReads = new Map();
      const readCandles = (pool, time) => {
        if (!candleReads.has(pool)) candleReads.set(pool, candles(pool, time));
        return candleReads.get(pool);
      };
      const closed = [];
      const snapshots = new Map();
      const readSnapshot = (pool, lower, upper) => {
        const key = `${pool}:${lower}:${upper}`;
        if (!snapshots.has(key)) snapshots.set(key, snapshot(pool, lower, upper).catch(() => null));
        return snapshots.get(key);
      };
      const markUnavailable = (p, reason, indicativeMark = null) => {
        p.markIssue = reason;
        p.indicativeMark = indicativeMark;
      };
      for (const p of Object.values(paper.open)) {
        if (stopped || !config.standalone.shadow) return;
        try {
          const costSol = p.costSol ?? COST_SOL;
          if (p.manualExit && !p.exit) p.manualExitCheckedAt = now;
          const active = p.exit ? null : await readActive(p.pool);
          if (!p.exit && !validActive(active)) {
            if (p.longHold) applyHoldCheck(p, now, null);
            markUnavailable(p, 'Bin aktif belum tersedia');
            continue;
          }
          if (tracksRange(p) && !p.exit) {
            const elapsed = now - (p.lastRangeMarkAt ?? now);
            if (elapsed > 0 && elapsed <= 180_000) {
              p.observedMs = (p.observedMs ?? 0) + elapsed;
              p.inRangeMs = (p.inRangeMs ?? 0) + (p.wasInRange ? elapsed : 0);
            }
            p.lastRangeMarkAt = now;
            p.wasInRange = active.binId >= p.lower && active.binId <= p.upper;
            if (active.binId < p.lower) p.wasBelowRange = true;
          }
          if (!p.exit) p.hardLowerExit ??= paperLowerExit(p, active);
          const bins = p.exit ? null : await readSnapshot(p.pool, p.lower, p.upper);
          const inventory = p.exit?.inventory ?? (bins && markPaperBins(p, active.binId, bins));
          if (inventory && !p.exit && p.rebalanceTrial) {
            inventory.sol += p.rebalanceIdleSol ?? 0;
            inventory.feeSol += p.rebalanceFeeSol ?? 0;
            inventory.feeTokens += p.rebalanceFeeTokens ?? 0;
          }
          if (!inventory) {
            if (p.longHold) applyHoldCheck(p, now, null);
            markUnavailable(p, bins ? 'Inventori bin belum bisa dinilai' : 'Snapshot bin belum tersedia');
            if (p.mirror) p.manualExit ??= mirrorExitReason(p, active, null, now);
            continue;
          }
          if (!p.filledAt && (inventory.tokens > 0 || inventory.feeEvidence)) p.filledAt = now;
          const forcedExit = p.hardLowerExit ?? p.manualExit;
          if (!p.exit && forcedExit) p.exit = { at: now, reason: forcedExit, inventory };
          const tokenAmount = inventory.tokens + inventory.feeTokens;
          const raw = rawTokens(tokenAmount, p.decimals);
          const proceeds = await sellQuote(p.mint, raw);
          const quotedAt = Date.now();
          if (stopped || !config.standalone.shadow) return;
          const net = inventory.sol + inventory.feeSol + proceeds - p.capital - costSol;
          const pnl = proceeds != null && Number.isFinite(net) ? net : null;
          const feeTokenPrice = tokenAmount > 0 && proceeds != null ? proceeds / tokenAmount : 0;
          const feeValueSol = pnl == null ? null : inventory.feeSol + inventory.feeTokens * feeTokenPrice;
          if (pnl != null) {
            p.mark = { at: Date.now(), pnl };
            p.markIssue = null;
            p.indicativeMark = null;
            if (tracksRange(p)) {
              p.trialPeakPnl = Math.max(p.trialPeakPnl ?? 0, pnl);
              p.trialDrawdownPct = Math.max(p.trialDrawdownPct ?? 0, 100 * (p.trialPeakPnl - pnl) / p.capital);
            }
          } else {
            const indicative = validActive(active)
              ? inventory.sol + inventory.feeSol + tokenAmount * Number(active.price) - p.capital - costSol : null;
            markUnavailable(p, 'Quote jual belum tersedia', Number.isFinite(indicative) ? { at: Date.now(), pnl: indicative } : null);
          }
          if (!p.exit && p.longHold && !p.hardLowerExit && !p.manualExit) {
            const valued = pnl != null && Date.now() - now <= 30_000;
            observeHold(p, { now, activeBin: active.binId, feeSol: inventory.feeSol, feeTokens: inventory.feeTokens, valued });
            if (!p.longHold.ended && now >= p.longHold.checkAt) {
              const ordinaryExit = paperCloseRule({ ...p, longHold: null, maxHoldMinutes: Infinity },
                active, pnl == null ? null : pnl / p.capital * 100, now);
              if (!ordinaryExit && !p.exitSignal) {
                const evidence = valued ? holdEvidence(p, now, Math.min(feeTokenPrice, Number(active.price)), pnl) : null;
                const ratio = evidence ? await downsideQuoteRatio(p, active).catch(() => 0) : 0;
                if (stopped || !config.standalone.shadow) return;
                const eligible = evidence && ratio >= config.research.paperMinExitRatio && Date.now() - now <= 30_000 &&
                  !p.hardLowerExit && !p.manualExit;
                applyHoldCheck(p, now, eligible ? { ...evidence, exitRatio: ratio } : null);
              } else if (now >= p.longHold.until) applyHoldCheck(p, now, null);
            }
          }
          if (!p.exit && (p.hardLowerExit || p.manualExit)) p.exit = { at: now, reason: p.hardLowerExit ?? p.manualExit, inventory };
          if (!p.exit) {
            const reason = narrowLossExit(p, pnl, quotedAt - now <= 30_000) ??
              mirrorExitReason(p, active, pnl == null ? null : pnl / p.capital * 100, now);
            if (reason) p.exit = { at: now, reason, inventory };
          }
          if (p.rebalanceTrial && config.strategy.autoRebalance && !store.data.paused && rebalancePlan && pnl != null &&
              active.binId > p.lower + 1 && active.binId <= p.upper && rebalanceDue(p, now)) {
            const exitRatio = await downsideQuoteRatio(p, active);
            let plan = exitRatio >= config.research.paperMinExitRatio ? await rebalancePlan(p, { ...active, exitRatio }).catch(() => null) : null;
            if (plan?.shape && plan.shape !== p.shape) {
              const fresh = await getBin({ pool_address: p.pool }).catch(() => null);
              if (fresh?.binId !== active.binId) plan = null;
            }
            if (stopped || !config.standalone.shadow) return;
            if (!store.data.paused && config.strategy.autoRebalance && Date.now() - now < REBALANCE_CHECK_MS / 3 &&
                assessRebalance(p, { now, active, bins, plan, quotePrice: Number(active.price) * Math.min(1, exitRatio) })) {
              p.mark.pnl -= p.costSol - costSol;
            }
          }
          if (p.exit && !p.filledAt) {
            paper.cancelled.push({ id: p.id, mint: p.mint, pool: p.pool, pair: p.pair, capital: p.capital,
              lower: p.lower, upper: p.upper, entryBin: p.entryBin, source: p.source, variant: p.variant, at: now, closedAt: now,
              openedAt: p.openedAt, reason: p.exit.reason, costSol, pnl: -costSol, outcome: 'cancelled', accountingVersion: 1 });
            paper.realized[p.variant] -= costSol;
            delete paper.open[p.id];
          } else if (p.exit && pnl != null) {
            const scope = p.longRunArm ?? 'baseline';
            const activeRunners = Object.values(runners.open).filter(runner => (runner.longRunArm ?? 'baseline') === scope);
            if (config.research.paperTokenRunner && (p.mirror || p.longRunArm) && activeRunners.length < 4 &&
                !activeRunners.some(runner => runner.mint === p.mint)) {
              const runner = await prepareTokenRunner(p, { raw, sol: inventory.sol + inventory.feeSol,
                fullQuote: proceeds, pnl, now: quotedAt, quote: sellQuote, candles: readCandles }).catch(() => null);
              if (stopped || !config.standalone.shadow) return;
              if (runner && config.research.paperTokenRunner && Date.now() - quotedAt <= RUNNER_POLL_MS) {
                runners.open[p.id] = runner;
              }
            }
            paper.closed.push({ id: p.id, mint: p.mint, pool: p.pool, pair: p.pair, capital: p.capital,
              lower: p.lower, upper: p.upper, entryBin: p.entryBin, shape: p.shape, range: p.range, variant: p.variant, openedAt: p.openedAt,
              closedAt: Date.now(), filledAt: p.filledAt, pnl, reason: p.exit.reason, solInventory: inventory.sol, quotedSol: proceeds,
              feeSol: inventory.feeSol, feeTokens: inventory.feeTokens, feeValueSol, costSol,
              exitRunnerId: runners.open[p.id]?.id, longRunExtensions: p.longHold?.extensions,
              source: p.source, mirror: p.mirror, shapeMode: p.shapeMode, shapeReason: p.shapeReason, pairEntry: p.pairEntry,
              rebalancePair: p.rebalancePair, rebalanceTrial: p.rebalanceTrial, rebalances: p.rebalances, screenTrial: p.screenTrial,
              ...(tracksRange(p) ? { shapeTrial: p.shapeTrial, rangeTrial: p.rangeTrial, wasBelowRange: Boolean(p.wasBelowRange),
                observedMs: p.observedMs ?? 0, inRangeMs: p.inRangeMs ?? 0, drawdownPct: p.trialDrawdownPct ?? 0,
                exitQuoteDelayMs: Math.max(0, quotedAt - p.exit.at) } : {}),
              outcome: 'settled', accountingVersion: 1 });
            paper.realized[p.variant] += pnl;
            if (p.mirror) paper.mirrorRealized = (paper.mirrorRealized ?? 0) + pnl;
            delete paper.open[p.id];
            if (!p.shapeTrial && !p.rangeTrial && !p.rebalanceTrial && (!p.longRunArm || p.mirror)) {
              const runner = runners.open[p.id];
              closed.push(`• ${p.mint.slice(0, 8)} · ${p.variant ?? `${p.range}/${p.shape}`} · ${pnl.toFixed(4)} SOL · ${p.exit.reason}${runner ? ` · sisa token ${runner.initialQuote.toFixed(5)} SOL` : ''}`);
            }
          }
        } catch { markUnavailable(p, 'Valuasi belum bisa dihitung'); }
      }
      recordPaperNav(paper, Date.now(), config.research.paperBankrollSol);
      const openMints = new Set(Object.values(paper.open).map(p => `${p.source}:${p.mint}`));
      const recentClosed = new Set([
        ...paper.closed.filter(p => isActivePaperVariant(p.variant) && now - p.closedAt < 6 * 60 * MINUTE).map(p => `${p.source}:${p.mint}`),
        ...paper.cancelled.filter(p => isActivePaperVariant(p.variant) && now - p.at < 60 * MINUTE).map(p => `${p.source}:${p.mint}`),
      ]);
      const candidateKey = c => `${c.source ?? 'discovery'}:${c.mint}`;
      const candidates = Object.values(store.data.research ?? {}).filter(c =>
        now - c.at <= 5 * MINUTE && c.at <= now && c.paperAt == null &&
        !openMints.has(candidateKey(c)) && !recentClosed.has(candidateKey(c)))
        .sort((a, b) => Number(b.source === 'convergence') - Number(a.source === 'convergence') || a.at - b.at);
      for (const c of admitResearch ? candidates.slice(0, 4) : []) {
        if (stopped || !config.standalone.shadow) return;
        const source = c.source ?? 'discovery';
        if ([...openMints].filter(key => key.startsWith(`${source}:`)).length >= config.risk.maxPositions) continue;
        if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 18 || !(c.binStep > 0)) continue;
        const active = await readActive(c.pool);
        if (!validActive(active)) continue;
        const price = Number(active.price);
        const capital = c.capital ?? config.research.paperCapitalSol;
        if (!(capital > COST_SOL)) break;
        try {
          const plans = c.plans.flatMap((plan, index) => {
            const range = paperBins(plan, { ...active, price }, c.binStep);
            return range ? [{ ...range, shape: plan.shape, range: plan.range,
              maxHoldMinutes: plan.maxHoldMinutes, rangeWaitMinutes: plan.rangeWaitMinutes,
              variant: plan.variant ?? `discovery/${plan.range}/${plan.shape}${index === 1 && plan.shape === 'spot' ? '-wide' : ''}` }] : [];
          });
          if (source === 'discovery' && config.research.paperSizingExperiment) {
            const spot = plans.filter(p => p.shape === 'spot').sort((a,b) => a.lower - b.lower)[0];
            if (spot) plans.push(
              { ...spot, variant: 'discovery/volatility/sizing-0.14', capital: 0.14, bankroll: 1 },
              { ...spot, variant: 'discovery/volatility/sizing-0.30', capital: 0.30, bankroll: 1 },
            );
          }
          if (!plans.length) continue;
          const worstPrice = Math.min(...plans.map(plan => price * plan.ratio ** (plan.lower - active.binId)));
          const expectedQuote = capital * price / worstPrice;
          const exitQuote = await sellQuote(c.mint, rawTokens(capital / worstPrice, c.decimals));
          if (stopped || !config.standalone.shadow) return;
          const normalQuoteOk = exitQuote != null && exitQuote >= expectedQuote * config.research.paperMinExitRatio;
          if (!normalQuoteOk) {
            if (c.paperRejectedAt == null) paper.skipped++;
            c.paperRejectedAt = now;
            if (!plans.some(plan => plan.bankroll)) continue;
          }
          const entryBins = await readSnapshot(c.pool, Math.min(...plans.map(p => p.lower)), Math.max(...plans.map(p => p.upper)));
          if (!entryBins || stopped || !config.standalone.shadow) continue;
          let admitted = 0;
          for (const [index, plan] of plans.entries()) {
            const positionCapital = plan.capital ?? capital;
            if (!plan.bankroll && !normalQuoteOk) continue;
            if (plan.bankroll && Object.values(paper.open).some(p => p.variant === plan.variant)) continue;
            if (paperRiskBlocked(paper, plan.variant, now, config.research.paperDailyLossLimitPct, config.research.paperDrawdownLimitPct)) continue;
            if (plan.bankroll) {
              const floor = price * plan.ratio ** (plan.lower - active.binId);
              const raw = rawTokens(positionCapital / floor, c.decimals);
              const quoteSol = await sellQuote(c.mint, raw);
              if (stopped || !config.standalone.shadow) return;
              if (quoteSol == null || quoteSol < positionCapital * price / floor * config.research.paperMinExitRatio) continue;
            }
            const reserved = Object.values(paper.open).filter(p => p.variant === plan.variant).reduce((n, p) => n + p.capital + COST_SOL, 0);
            const available = (plan.bankroll ?? config.research.paperBankrollSol) + (paper.realized[plan.variant] ?? 0) - reserved;
            if (available < positionCapital + COST_SOL) continue;
            const id = `${source}:${c.mint}:${c.at}:${index}`;
            const position = { ...plan, id, mint: c.mint, pool: c.pool, pair: c.pair, decimals: c.decimals, source,
              openedAt: now, entryBin: active.binId, entryPrice: price, capital: positionCapital, mark: { at: now, pnl: -COST_SOL } };
            position.binSeed = seedPaperBins(position, entryBins);
            paper.realized[plan.variant] ??= 0;
            if (plan.bankroll) (paper.bankrolls ??= {})[plan.variant] = plan.bankroll;
            paper.open[id] = position;
            admitted++;
          }
          if (!admitted) continue;
          openMints.add(candidateKey(c));
          c.paperAt = now;
          log('paper', `Opened ${admitted} simulated variants for ${c.mint} (${source})`);
        } catch { log('paper_warn', `Paper admission unavailable for ${c.mint}`); }
      }
      recordPaperNav(paper, Date.now(), config.research.paperBankrollSol);
      updateLongRun(paper, Date.now());
      store.save();
      if (closed.length && !stopped) {
        const limit = config.research.paperCloseListLimit;
        const lines = [`🧪 Meridian paper close · ${closed.length} varian (estimasi net)`, '', ...closed.slice(0, limit)];
        if (closed.length > limit) lines.push(`+${closed.length - limit} close lainnya tersimpan.`);
        await notify(lines.join('\n'));
      }
    } catch { log('paper_warn', 'Paper lifecycle pass unavailable'); }
    finally { busy = false; }
  }
  const timer = schedule(tick, MINUTE);
  let samplingRunners = false, nextRunnerAt = 0;
  async function tickRunners() {
    const now = Date.now();
    const open = Object.values(runners.open);
    if (samplingRunners || stopped || !config.standalone.shadow || !open.length || now < nextRunnerAt) return;
    samplingRunners = true;
    nextRunnerAt = now + RUNNER_POLL_MS;
    try {
      const quotes = new Map(), market = new Map();
      const sharedQuote = (mint, raw) => {
        const key = `${mint}:${raw}`;
        if (!quotes.has(key)) quotes.set(key, quote(mint, raw).catch(() => null));
        return quotes.get(key);
      };
      const sharedCandles = (pool, at) => {
        if (!market.has(pool)) market.set(pool, candles(pool, at).catch(() => null));
        return market.get(pool);
      };
      const notices = await Promise.all(open.map(async row => {
        const result = await sampleTokenRunner(row, { now, candles: sharedCandles, quote: sharedQuote });
        if (stopped || !config.standalone.shadow || runners.open[row.id] !== row) return null;
        const name = row.pair ?? row.mint.slice(0, 8);
        if (result.closed) {
          runners.closed.push(result.closed);
          delete runners.open[row.id];
          const delta = result.closed.deltaSol;
          return !row.longRunArm || row.longRunArm === 'baseline'
            ? `${name} · ${delta >= 0 ? '+' : ''}${delta.toFixed(5)} SOL vs langsung jual · ${result.closed.reason}` : null;
        }
        runners.open[row.id] = result.next;
        return result.alert ? `${name} · quote jual belum tersedia, posisi simulasi masih terbuka` : null;
      }));
      if (stopped || !config.standalone.shadow) return;
      updateLongRun(paper, Date.now());
      store.save();
      const lines = notices.filter(Boolean);
      if (lines.length) await notify(['🧪 Shadow · Sisa token', ...lines.map(line => `• ${line}`)].join('\n'));
    } catch { log('paper_warn', 'Token runner check unavailable'); }
    finally { samplingRunners = false; }
  }
  let watching = false;
  const fastTimer = setInterval(async () => {
    if (stopped || !config.standalone.shadow) return;
    void tickRunners();
    if (watching) return;
    if (Object.values(paper.open).some(p => p.manualExit && !p.exit && !p.manualExitCheckedAt)) void tick();
    if (!(config.management.outOfRangeBelowStopPct > 0) && !Object.values(paper.open).some(p => p.rangeTrial)) return;
    watching = true;
    try {
      const reads = new Map();
      let breached = false, observedBelow = false;
      await Promise.all(Object.values(paper.open).map(async p => {
        if (p.exit || p.hardLowerExit || (!p.rangeTrial && !(config.management.outOfRangeBelowStopPct > 0))) return;
        if (!reads.has(p.pool)) reads.set(p.pool, getBin({ pool_address: p.pool }).catch(() => null));
        const active = await reads.get(p.pool);
        if (!active || stopped || !config.standalone.shadow || paper.open[p.id] !== p || p.exit) return;
        if (tracksRange(p) && !p.wasBelowRange && Number.isSafeInteger(active.binId) && active.binId < p.lower) {
          p.wasBelowRange = true;
          observedBelow = true;
        }
        const reason = paperLowerExit(p, active);
        if (reason) {
          p.hardLowerExit = reason;
          breached = true;
        }
      }));
      if (breached || observedBelow) store.save();
      if (breached || Object.values(paper.open).some(p => p.hardLowerExit && !p.exit)) void tick();
    } catch { log('paper_warn', 'Fast lower-range check unavailable'); }
    finally { watching = false; }
  }, Math.max(1, config.pnl.pollIntervalSec) * 1000);
  void tick();
  return () => { stopped = true; clearInterval(timer); clearInterval(fastTimer); };
}
