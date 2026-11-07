import { config } from '../config.js';
import { getDeterministicCloseRule } from '../exit-rules.js';
import { log } from '../logger.js';
import { getActiveBin } from '../tools/dlmm.js';
import { quoteTokenToSol } from '../tools/wallet.js';

const MINUTE = 60_000;
const COST_SOL = 0.001; // Estimated round-trip network cost, excluding refundable rent.

export function paperBins(plan, active, step) {
  const ratio = 1 + step / 10_000;
  const offsets = plan.range === 'fibonacci'
    ? [Math.ceil(Math.log(plan.lower / active.price) / Math.log(ratio)), Math.floor(Math.log(plan.upper / active.price) / Math.log(ratio))]
    : [-plan.binsBelow, -1];
  const [lower, upper] = offsets;
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
  if (now - p.openedAt >= config.research.paperMaxHoldMinutes * MINUTE) return 'paper max hold';
  if (!p.rangeReached && outside === 'above') {
    return now - p.openedAt >= config.research.paperInitialRangeWaitMinutes * MINUTE
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
  getBin = getActiveBin, quote = quoteTokenToSol, schedule = setInterval,
} = {}) {
  const paper = store.data.paper ??= { open: {}, closed: [], skipped: 0 };
  let stopped = false, busy = false;
  async function tick() {
    if (busy || stopped || !config.standalone.shadow) return;
    busy = true;
    try {
      const now = Date.now();
      paper.closed = paper.closed.filter(p => now - p.closedAt < 7 * 86_400_000).slice(-1000);
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
      for (const p of Object.values(paper.open)) {
        if (stopped || !config.standalone.shadow) return;
        try {
          const active = p.exit ? null : await readActive(p.pool);
          if (!p.exit && !validActive(active)) { p.mark = null; continue; }
          const inventory = p.exit?.inventory ?? paperInventory(p, active.binId);
          const proceeds = await sellQuote(p.mint, rawTokens(inventory.tokens, p.decimals));
          if (stopped || !config.standalone.shadow) return;
          const pnl = proceeds == null ? null : inventory.sol + proceeds - p.capital - COST_SOL;
          p.mark = pnl == null ? null : { at: Date.now(), pnl };
          if (!p.exit) {
            const reason = paperCloseRule(p, active, pnl == null ? null : pnl / p.capital * 100, now);
            p.exitTicks = reason && reason === p.exitSignal ? (p.exitTicks ?? 0) + 1 : Number(Boolean(reason));
            p.exitSignal = reason;
            if (reason && p.exitTicks >= Math.max(1, config.pnl.confirmTicks)) p.exit = { at: now, reason, inventory };
          }
          if (p.exit && pnl != null) {
            paper.closed.push({ id: p.id, mint: p.mint, shape: p.shape, range: p.range, variant: p.variant, openedAt: p.openedAt,
              closedAt: Date.now(), pnl, reason: p.exit.reason, solInventory: inventory.sol, quotedSol: proceeds });
            delete paper.open[p.id];
            closed.push(`• ${p.mint.slice(0, 8)} · ${p.variant ?? `${p.range}/${p.shape}`} · ${pnl.toFixed(4)} SOL · ${p.exit.reason}`);
          }
        } catch { p.mark = null; }
      }
      const openMints = new Set(Object.values(paper.open).map(p => p.mint));
      const recentClosed = new Set(paper.closed.filter(p => now - p.closedAt < 6 * 60 * MINUTE).map(p => p.mint));
      const candidates = Object.values(store.data.research ?? {}).filter(c =>
        now - c.at <= 5 * MINUTE && c.at <= now && c.paperAt == null &&
        !openMints.has(c.mint) && !recentClosed.has(c.mint)).sort((a, b) => a.at - b.at);
      for (const c of candidates.slice(0, 4)) {
        if (stopped || !config.standalone.shadow) return;
        if (openMints.size >= config.risk.maxPositions) break;
        if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 18 || !(c.binStep > 0)) continue;
        const active = await readActive(c.pool);
        if (!validActive(active)) continue;
        const price = Number(active.price);
        const capital = config.research.paperCapitalSol;
        if (!(capital > COST_SOL)) break;
        try {
          const plans = c.plans.flatMap((plan, index) => {
            const range = paperBins(plan, { ...active, price }, c.binStep);
            return range ? [{ ...range, shape: plan.shape, range: plan.range, variant: `${plan.range}/${plan.shape}${index === 1 && plan.shape === 'spot' ? '-wide' : ''}` }] : [];
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
          for (const [index, plan] of plans.entries()) {
            const id = `${c.mint}:${c.at}:${index}`;
            paper.open[id] = { ...plan, id, mint: c.mint, pool: c.pool, decimals: c.decimals,
              openedAt: now, entryBin: active.binId, entryPrice: price, capital };
          }
          openMints.add(c.mint);
          c.paperAt = now;
          log('paper', `Opened ${plans.length} simulated variants for ${c.mint}`);
        } catch { log('paper_warn', `Paper admission unavailable for ${c.mint}`); }
      }
      store.save();
      if (closed.length && !stopped) {
        const limit = config.research.paperCloseListLimit;
        const lines = [`🧪 Meridian paper close · ${closed.length} varian (estimasi, tanpa fee LP)`, '', ...closed.slice(0, limit)];
        if (closed.length > limit) lines.push(`+${closed.length - limit} close lainnya tersimpan.`);
        await notify(lines.join('\n'));
      }
    } catch { log('paper_warn', 'Paper lifecycle pass unavailable'); }
    finally { busy = false; }
  }
  const timer = schedule(tick, MINUTE);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
