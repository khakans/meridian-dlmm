import { config } from '../config.js';
import { getDeterministicCloseRule, lowerRangeStop } from '../exit-rules.js';
import { log } from '../logger.js';
import { getActiveBin, getPaperBinSnapshot } from '../tools/dlmm.js';
import { quoteTokenToSol } from '../tools/wallet.js';
import { markPaperBins, paperRiskBlocked, recordPaperNav, seedPaperBins } from './paper-accounting.js';
import { isActivePaperVariant } from './entry-plans.js';

const MINUTE = 60_000;
const COST_SOL = 0.001; // Estimated round-trip network cost, excluding refundable rent.

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

export async function validateExitQuote({ mint, pool, decimals, binStep, binsBelow, capital }) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      !(binStep > 0 && binsBelow > 0 && capital > 0)) throw Error('Invalid exit sizing inputs');
  const active = await getActiveBin({ pool_address: pool });
  if (!validActive(active)) throw Error('Active bin unavailable');
  const price = Number(active.price);
  const raw = rawTokens(capital / (price / (1 + binStep / 10_000) ** binsBelow), decimals);
  const quote = await quoteTokenToSol(mint, raw);
  const mark = raw / 10 ** decimals * price;
  if (quote < mark * config.research.paperMinExitRatio) throw Error('Exit quote below minimum');
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
  if (now - p.openedAt >= (p.maxHoldMinutes ?? config.research.paperMaxHoldMinutes) * MINUTE) return 'paper max hold';
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

export function startPaper(store, notify, {
  getBin = getActiveBin, snapshot = getPaperBinSnapshot, quote = quoteTokenToSol, schedule = setInterval,
} = {}) {
  const paper = store.data.paper ??= { open: {}, closed: [], skipped: 0 };
  paper.realized ??= {};
  paper.cancelled ??= [];
  paper.legacy ??= [];
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
      paper.closed = paper.closed.filter(p => now - p.closedAt < 90 * 86_400_000).slice(-10_000);
      paper.cancelled = paper.cancelled.filter(p => now - p.at < 90 * 86_400_000).slice(-10_000);
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
      const closed = [];
      const snapshots = new Map();
      const readSnapshot = (pool, lower, upper) => {
        const key = `${pool}:${lower}:${upper}`;
        if (!snapshots.has(key)) snapshots.set(key, snapshot(pool, lower, upper).catch(() => null));
        return snapshots.get(key);
      };
      for (const p of Object.values(paper.open)) {
        if (stopped || !config.standalone.shadow) return;
        try {
          const active = p.exit ? null : await readActive(p.pool);
          if (!p.exit && !validActive(active)) { p.mark = null; continue; }
          if (!p.exit) p.hardLowerExit ??= lowerRangeStop(active.binId, p.lower,
            active.binStep ?? (p.ratio - 1) * 10_000, config.management.outOfRangeBelowStopPct);
          const bins = p.exit ? null : await readSnapshot(p.pool, p.lower, p.upper);
          const inventory = p.exit?.inventory ?? (bins && markPaperBins(p, active.binId, bins));
          if (!inventory) { p.mark = null; continue; }
          if (!p.filledAt && (inventory.tokens > 0 || inventory.feeEvidence)) p.filledAt = now;
          if (!p.exit && p.hardLowerExit) p.exit = { at: now, reason: p.hardLowerExit, inventory };
          const proceeds = await sellQuote(p.mint, rawTokens(inventory.tokens + inventory.feeTokens, p.decimals));
          if (stopped || !config.standalone.shadow) return;
          const pnl = proceeds == null ? null : inventory.sol + inventory.feeSol + proceeds - p.capital - COST_SOL;
          p.mark = pnl == null ? null : { at: Date.now(), pnl };
          if (!p.exit) {
            const reason = paperCloseRule(p, active, pnl == null ? null : pnl / p.capital * 100, now);
            p.exitTicks = reason && reason === p.exitSignal ? (p.exitTicks ?? 0) + 1 : Number(Boolean(reason));
            p.exitSignal = reason;
            if (reason && p.exitTicks >= Math.max(1, config.pnl.confirmTicks)) p.exit = { at: now, reason, inventory };
          }
          if (p.exit && !p.filledAt) {
            paper.cancelled.push({ id: p.id, mint: p.mint, source: p.source, variant: p.variant, at: now, closedAt: now,
              openedAt: p.openedAt, reason: p.exit.reason, costSol: COST_SOL, pnl: -COST_SOL, outcome: 'cancelled', accountingVersion: 1 });
            paper.realized[p.variant] -= COST_SOL;
            delete paper.open[p.id];
          } else if (p.exit && pnl != null) {
            paper.closed.push({ id: p.id, mint: p.mint, shape: p.shape, range: p.range, variant: p.variant, openedAt: p.openedAt,
              closedAt: Date.now(), filledAt: p.filledAt, pnl, reason: p.exit.reason, solInventory: inventory.sol, quotedSol: proceeds,
              feeSol: inventory.feeSol, feeTokens: inventory.feeTokens, costSol: COST_SOL,
              source: p.source, outcome: 'settled', accountingVersion: 1 });
            paper.realized[p.variant] += pnl;
            delete paper.open[p.id];
            closed.push(`• ${p.mint.slice(0, 8)} · ${p.variant ?? `${p.range}/${p.shape}`} · ${pnl.toFixed(4)} SOL · ${p.exit.reason}`);
          }
        } catch { p.mark = null; }
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
      for (const c of candidates.slice(0, 4)) {
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
          if (!plans.length) continue;
          const worstPrice = Math.min(...plans.map(plan => price * plan.ratio ** (plan.lower - active.binId)));
          const expectedQuote = capital * price / worstPrice;
          const exitQuote = await sellQuote(c.mint, rawTokens(capital / worstPrice, c.decimals));
          if (stopped || !config.standalone.shadow) return;
          if (exitQuote == null || exitQuote < expectedQuote * config.research.paperMinExitRatio) {
            if (c.paperRejectedAt == null) paper.skipped++;
            c.paperRejectedAt = now;
            continue;
          }
          const entryBins = await readSnapshot(c.pool, Math.min(...plans.map(p => p.lower)), Math.max(...plans.map(p => p.upper)));
          if (!entryBins || stopped || !config.standalone.shadow) continue;
          let admitted = 0;
          for (const [index, plan] of plans.entries()) {
            if (paperRiskBlocked(paper, plan.variant, now, config.research.paperDailyLossLimitPct, config.research.paperDrawdownLimitPct)) continue;
            const reserved = Object.values(paper.open).filter(p => p.variant === plan.variant).reduce((n, p) => n + p.capital + COST_SOL, 0);
            const available = config.research.paperBankrollSol + (paper.realized[plan.variant] ?? 0) - reserved;
            if (available < capital + COST_SOL) continue;
            const id = `${source}:${c.mint}:${c.at}:${index}`;
            const position = { ...plan, id, mint: c.mint, pool: c.pool, decimals: c.decimals, source,
              openedAt: now, entryBin: active.binId, entryPrice: price, capital, mark: { at: now, pnl: -COST_SOL } };
            position.binSeed = seedPaperBins(position, entryBins);
            paper.realized[plan.variant] ??= 0;
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
  let watching = false;
  const fastTimer = setInterval(async () => {
    if (watching || stopped || !config.standalone.shadow || !(config.management.outOfRangeBelowStopPct > 0)) return;
    watching = true;
    try {
      const reads = new Map();
      let breached = false;
      await Promise.all(Object.values(paper.open).map(async p => {
        if (p.exit || p.hardLowerExit) return;
        if (!reads.has(p.pool)) reads.set(p.pool, getBin({ pool_address: p.pool }).catch(() => null));
        const active = await reads.get(p.pool);
        if (!active || stopped || !config.standalone.shadow || paper.open[p.id] !== p || p.exit) return;
        const reason = lowerRangeStop(active.binId, p.lower, active.binStep ?? (p.ratio - 1) * 10_000,
          config.management.outOfRangeBelowStopPct);
        if (reason) { p.hardLowerExit = reason; breached = true; }
      }));
      if (breached) store.save();
      if (breached || Object.values(paper.open).some(p => p.hardLowerExit && !p.exit)) void tick();
    } catch { log('paper_warn', 'Fast lower-range check unavailable'); }
    finally { watching = false; }
  }, Math.max(1, config.pnl.pollIntervalSec) * 1000);
  void tick();
  return () => { stopped = true; clearInterval(timer); clearInterval(fastTimer); };
}
