import { config } from '../config.js';
import { log } from '../logger.js';
import { chooseEntryShape, liveNarrowEntryRange } from './entry-plans.js';
import { prepareMirrorPosition, startPaper } from './paper.js';
import { paperDay } from './paper-accounting.js';

export const NARROW_CURVE_KEY = 'narrow-curve-trial-v1';
const DAY = 86_400_000;
const MIN_PAIRS = 20;

export function narrowCurveEvidence(paper, now = Date.now()) {
  const groups = new Map();
  const ended = new Map();
  for (const row of paper?.closed ?? []) {
    if (!Number.isFinite(row.closedAt) || row.closedAt < now - 14 * DAY || row.closedAt > now ||
        !row.rangeTrial || !['spot', 'curve'].includes(row.shape)) continue;
    ended.set(row.rangeTrial, (ended.get(row.rangeTrial) ?? 0) + 1);
    if (row.outcome !== 'settled' ||
        !Number.isFinite(row.pnl) || !(row.capital > 0) || !Number.isFinite(row.drawdownPct) ||
        !Number.isFinite(row.exitQuoteDelayMs) || row.exitQuoteDelayMs > 60_000) continue;
    if (!groups.has(row.rangeTrial)) groups.set(row.rangeTrial, {});
    groups.get(row.rangeTrial)[row.shape] = row;
  }
  const pairs = [...groups.values()].filter(({ spot, curve }) => spot && curve && spot.mint === curve.mint &&
    spot.pool === curve.pool && spot.openedAt === curve.openedAt && spot.capital === curve.capital &&
    spot.lower === curve.lower && spot.upper === curve.upper);
  const days = new Set(pairs.map(({ spot }) => paperDay(spot.openedAt))).size;
  const mints = new Set(pairs.map(({ spot }) => spot.mint)).size;
  const resolved = new Set([...ended].filter(([, count]) => count === 2).map(([id]) => id));
  for (const p of paper?.cancelled ?? []) {
    if (p.at >= now - 14 * DAY && p.at <= now) resolved.add(p.rangeTrial);
  }
  const invalid = resolved.size - pairs.length;
  const enough = pairs.length >= MIN_PAIRS && days >= 3 && mints >= 10;
  const spotPnl = pairs.reduce((sum, p) => sum + p.spot.pnl, 0);
  const curvePnl = pairs.reduce((sum, p) => sum + p.curve.pnl, 0);
  const spotDD = Math.max(0, ...pairs.map(p => p.spot.drawdownPct));
  const curveDD = Math.max(0, ...pairs.map(p => p.curve.drawdownPct));
  const spotBelow = pairs.filter(p => p.spot.wasBelowRange).length;
  const curveBelow = pairs.filter(p => p.curve.wasBelowRange).length;
  const eligibleForReview = enough && invalid <= resolved.size * 0.2 && curvePnl > Math.max(0, spotPnl) &&
    curveDD <= Math.min(3, spotDD) && curveBelow <= spotBelow;
  return { pairs: pairs.length, days, mints, invalid, enough, eligibleForReview, spotPnl, curvePnl, spotDD, curveDD, spotBelow, curveBelow };
}

export function narrowCurveStatus(paper, now) {
  const e = narrowCurveEvidence(paper, now);
  const status = e.eligibleForReview ? 'layak review' : e.enough ? 'batas hasil/risiko belum lolos' : 'mengumpulkan sampel';
  const summary = `Curve vs Spot sempit · ${e.pairs}/${MIN_PAIRS} pasangan valid · ${e.mints} mint / ${e.days} hari · ${status}${e.invalid ? ` · ${e.invalid} sampel tak lengkap` : ''}`;
  if (!e.pairs) return summary;
  return `${summary}\nNet Curve ${e.curvePnl.toFixed(4)} vs Spot ${e.spotPnl.toFixed(4)} SOL · DD maks ${e.curveDD.toFixed(1)}% vs ${e.spotDD.toFixed(1)}% · tembus bawah ${e.curveBelow} vs ${e.spotBelow}`;
}

export function startNarrowCurveTrial(database) {
  const paper = database.get(NARROW_CURVE_KEY, { open: {}, closed: [] });
  const save = () => database.put(NARROW_CURVE_KEY, paper);
  let status = narrowCurveStatus(paper);
  log('paper', status.replaceAll('\n', ' | '));
  const stop = startPaper({ data: { paper }, save() {
    save();
    const latest = narrowCurveStatus(paper);
    if (latest !== status) log('paper', (status = latest).replaceAll('\n', ' | '));
  } }, async () => {}, { comparisonOnly: true, admitResearch: false });

  function offer(input, candles, candleTime, at = Date.now()) {
    const now = Date.now();
    if (now - at > 15_000 || input.pairEntry?.side !== 'single' || input.shape !== 'spot' ||
        input.binsAbove !== 0 || input.entry.exitRatio < 0.98 || !Number.isFinite(input.entry.exitRatio)) return;
    const market = { now: Math.floor(now / 1000), price: Number(input.entry.price), binStep: input.binStep };
    if (Math.floor(candleTime / 300) !== Math.floor(market.now / 300) ||
        liveNarrowEntryRange(candles, market) !== input.binsBelow) return;
    const choice = chooseEntryShape(candles, { ...market, binsBelow: input.binsBelow,
      feeRatio: input.feeRatio, minFeeRatio: config.screening.minFeeActiveTvlRatio,
      exitRatio: input.entry.exitRatio, minExitRatio: Math.max(0.98, config.research.paperMinExitRatio) });
    if (choice.shape !== 'curve') return;
    const open = Object.values(paper.open);
    if (open.length >= 4 || open.some(p => p.mint === input.mint) ||
        paper.closed.some(p => p.mint === input.mint && now - p.openedAt < DAY) ||
        paper.cancelled.some(p => p.mint === input.mint && now - p.openedAt < DAY)) return;
    const cohort = `narrow-curve:${input.mint}:${at}`;
    const arms = ['spot', 'curve'].map(shape => {
      const position = prepareMirrorPosition({ ...input, shape }, at);
      return { ...position, id: `${cohort}:${shape}`, mirror: false, rangeTrial: cohort,
        variant: `narrow-curve/${shape}`, lastRangeMarkAt: at, wasInRange: true };
    });
    for (const arm of arms) {
      paper.open[arm.id] = arm;
      paper.realized[arm.variant] ??= 0;
    }
    try { save(); }
    catch (error) {
      for (const arm of arms) delete paper.open[arm.id];
      throw error;
    }
    log('paper', `Curve vs Spot cohort sampled · ${input.mint.slice(0, 8)} · ${input.binsBelow} bins · step ${input.binStep} bps`);
  }
  return { stop, offer };
}
