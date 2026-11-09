import { markPaperBins, seedPaperBins } from './paper-accounting.js';
import { ENTRY_SHAPES } from './entry-plans.js';

export const REBALANCE_CHECK_MS = 3 * 60_000;
const COOLDOWN_MS = 30 * 60_000;
const COST_SOL = 0.00010;

export function prepareRebalanceTrial(mirror) {
  mirror.rebalancePair = mirror.id;
  return { ...mirror, id: `${mirror.id}:rebalance`, variant: 'shape-rebalance/auto',
    mirror: false, rebalanceTrial: true };
}

export function rebalanceDue(p, now) {
  return !p.exit && !p.exitSignal && !p.lossExitSince && !p.hardLowerExit && !p.manualExit &&
    now >= (p.rebalanceCheck?.at ?? p.openedAt) + REBALANCE_CHECK_MS &&
    now >= (p.rebalances?.at(-1)?.at ?? -Infinity) + COOLDOWN_MS;
}

// Model only the initialized, SOL-only bins strictly below the current price.
// The active bin, token exposure and range stay in place, so no swap or new rent is assumed.
export function assessRebalance(p, { now, active, bins, plan, quotePrice }) {
  if (!rebalanceDue(p, now)) return false;
  const previous = p.rebalanceCheck;
  const shape = plan?.shape;
  p.rebalanceCheck = { at: now };
  if (!ENTRY_SHAPES.includes(shape) || shape === p.shape || !(quotePrice > 0) ||
      active.binId <= p.lower + 1 || active.binId > p.upper) return false;
  const movable = p.binSeed.filter(seed => seed.id < active.binId);
  if (movable.length < 2 || movable.some(({ id }) => {
    const bin = bins.get(id);
    return !bin || BigInt(bin.supply) <= 0n || BigInt(bin.xAmount) !== 0n;
  })) return false;
  const same = previous?.shape === shape && previous.bin === active.binId &&
    now - previous.at < 1.5 * REBALANCE_CHECK_MS;
  const fees = movable.map(({ id }) => {
    const bin = bins.get(id);
    return { id, feeX: String(bin.feeAmountXPerTokenStored), feeY: String(bin.feeAmountYPerTokenStored) };
  });
  const checks = same ? previous.checks + 1 : 1;
  Object.assign(p.rebalanceCheck, { shape, bin: active.binId, checks, fees });
  if (checks < 3) return false;
  const current = markPaperBins({ decimals: p.decimals, binSeed: movable }, active.binId, bins);
  if (!current || current.tokens !== 0 || !(current.sol > 0)) return false;
  const next = seedPaperBins({ ...p, upper: active.binId - 1, shape, capital: current.sol }, bins);
  const feeValue = seeds => {
    const marks = seeds.map((seed, i) => {
      const { id, feeX, feeY } = previous.fees[i];
      return { ...seed, id, feeX, feeY };
    });
    const estimate = markPaperBins({ decimals: p.decimals, binSeed: marks }, active.binId, bins);
    return estimate ? estimate.feeSol + estimate.feeTokens * quotePrice : null;
  };
  const before = feeValue(movable);
  const after = feeValue(next);
  if (before == null || after == null) return false;
  // Discount the recent fee-rate differential by half before projecting over the cooldown.
  const gain = (after - before) * COOLDOWN_MS / (now - previous.at) * 0.5;
  if (!Number.isFinite(gain) || gain < COST_SOL * 3) return false;
  const reseeded = markPaperBins({ decimals: p.decimals, binSeed: next }, active.binId, bins);
  if (!reseeded || reseeded.tokens !== 0 || reseeded.sol > current.sol + 1e-9) return false;
  p.binSeed = [...next, ...p.binSeed.filter(seed => seed.id >= active.binId)];
  p.rebalanceIdleSol = (p.rebalanceIdleSol ?? 0) + Math.max(0, current.sol - reseeded.sol);
  p.rebalanceFeeSol = (p.rebalanceFeeSol ?? 0) + current.feeSol;
  p.rebalanceFeeTokens = (p.rebalanceFeeTokens ?? 0) + current.feeTokens;
  p.costSol += COST_SOL;
  p.rebalances ??= [];
  p.rebalances.push({ at: now, from: p.shape, to: shape, reason: plan.reason,
    costSol: COST_SOL, estimatedNetGainSol: gain - COST_SOL });
  p.shape = shape;
  p.rebalanceCheck = { at: now };
  return true;
}
