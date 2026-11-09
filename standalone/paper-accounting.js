import { isActivePaperVariant } from './entry-plans.js';

const Q = 1n << 64n;
const integer = value => BigInt(value.toString());

export function seedPaperBins(position, bins, dualSide) {
  const { lower, upper, shape, capital, decimals, entryBin, ratio } = position;
  const ids = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i);
  const solUpper = dualSide ? entryBin : upper;
  const solWeights = ids.map(id => id > solUpper ? 0 :
    shape === 'spot' ? 1 : shape === 'curve' ? id - lower + 1 : solUpper - id + 1);
  const tokenWeights = dualSide ? ids.map(id => id <= entryBin ? 0 :
    (shape === 'spot' ? 1 : shape === 'curve' ? upper - id + 1 : id - entryBin) / ratio ** (id - entryBin)) : [];
  const solWeight = solWeights.reduce((a, b) => a + b, 0);
  const tokenWeight = tokenWeights.reduce((a, b) => a + b, 0);
  const solLamports = dualSide?.solLamports ?? capital * 1e9;
  const rawX = BigInt(dualSide?.rawX ?? 0);
  let assignedX = 0n, assignedY = 0n;
  return ids.map((id, i) => {
    const bin = bins.get(id);
    if (!bin) throw Error('Missing entry bin');
    const y = dualSide && id === solUpper ? BigInt(solLamports) - assignedY :
      BigInt(Math.floor(solLamports * solWeights[i] / solWeight));
    const x = !dualSide ? 0n : id === upper ? rawX - assignedX :
      rawX * BigInt(Math.floor(tokenWeights[i] / tokenWeight * 1e12)) / 1_000_000_000_000n;
    assignedX += x;
    assignedY += y;
    const supply = integer(bin.supply);
    const solValue = amount => BigInt(Math.floor(Number(amount) / 10 ** decimals * Number(bin.pricePerToken) * 1e9));
    const liquidity = integer(bin.yAmount) + solValue(bin.xAmount);
    if (supply > 0n && liquidity <= 0n) throw Error('Invalid bin liquidity');
    const value = y + (x > 0n ? solValue(x) : 0n);
    const share = supply === 0n ? value * Q : value * supply / liquidity;
    return { id, y: String(y), ...(dualSide && { x: String(x) }), share: String(share),
      feeX: String(bin.feeAmountXPerTokenStored), feeY: String(bin.feeAmountYPerTokenStored) };
  });
}

// Counterfactual position against observed on-chain reserves and cumulative LP fee growth.
// An empty bin can keep its initial inventory until price crosses it.
export function markPaperBins(position, activeBin, bins) {
  let x = 0n, y = 0n, feeX = 0n, feeY = 0n;
  for (const seed of position.binSeed) {
    const bin = bins.get(seed.id);
    if (!bin) return null;
    const supply = integer(bin.supply);
    const share = BigInt(seed.share);
    const dx = integer(bin.feeAmountXPerTokenStored) - BigInt(seed.feeX);
    const dy = integer(bin.feeAmountYPerTokenStored) - BigInt(seed.feeY);
    if (dx < 0n || dy < 0n) return null;
    if (supply === 0n) {
      const initialX = BigInt(seed.x ?? 0);
      const initialY = BigInt(seed.y);
      if (seed.id < activeBin && initialX === 0n) y += initialY;
      else if (seed.id > activeBin && initialY === 0n && seed.x != null) x += initialX;
      else return null;
      continue;
    }
    x += share * integer(bin.xAmount) / supply;
    y += share * integer(bin.yAmount) / supply;
    feeX += (share / Q) * dx / Q;
    feeY += (share / Q) * dy / Q;
  }
  const unit = 10 ** position.decimals;
  return { sol: Number(y) / 1e9, tokens: Number(x) / unit, feeSol: Number(feeY) / 1e9,
    feeTokens: Number(feeX) / unit, feeEvidence: feeX > 0n || feeY > 0n };
}

export const paperDay = ms => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);

export function recordPaperNav(paper, now, bankroll) {
  const day = paperDay(now);
  paper.nav ??= {};
  paper.realized ??= {};
  const open = Object.values(paper.open).filter(p => p.binSeed);
  for (const [variant, realized] of Object.entries(paper.realized)) {
    if (!isActivePaperVariant(variant)) continue;
    const positions = open.filter(p => p.variant === variant);
    const waiting = positions.some(p => p.markIssue || !p.mark || now - p.mark.at > 180_000);
    const initial = paper.bankrolls?.[variant] ?? bankroll;
    const equity = waiting ? null : initial + realized + positions.reduce((n, p) => n + p.mark.pnl, 0);
    const rows = paper.nav[variant] ??= [];
    let row = rows.at(-1);
    if (row?.day !== day) {
      const startOfDay = now - (now + 7 * 3_600_000) % 86_400_000;
      const continuous = row && startOfDay - row.updatedAt <= 180_000;
      if (row && !continuous) row.complete = false;
      row = { day, start: continuous ? row.end : equity, end: equity,
        complete: equity != null && continuous && row.end != null && now - startOfDay < 180_000 };
      rows.push(row);
    } else if (now - row.updatedAt > 180_000) row.complete = false;
    row.end = equity;
    row.updatedAt = now;
    if (equity == null) row.complete = false;
    else {
      row.low = Math.min(row.low ?? equity, equity);
      paper.peak ??= {};
      paper.peak[variant] = Math.max(paper.peak[variant] ?? initial, equity);
      row.drawdown = Math.max(row.drawdown ?? 0, 1 - equity / paper.peak[variant]);
    }
    if (rows.length > 90) rows.splice(0, rows.length - 90);
  }
}

export function paperRiskBlocked(paper, variant, now, dailyLimit, drawdownLimit) {
  const row = paper.nav?.[variant]?.at(-1);
  if (!row) return false;
  if (row.end == null || now - row.updatedAt > 180_000) return true;
  const dailyLoss = row.day === paperDay(now) && row.start > 0 && row.end <= row.start * (1 - dailyLimit / 100);
  const peak = paper.peak?.[variant];
  return dailyLoss || (peak > 0 && row.end <= peak * (1 - drawdownLimit / 100));
}

export function recommendPaperVariant(results, now) {
  const split = now - 3 * 86_400_000;
  const byVariant = new Map();
  for (const row of results) {
    if (!row.accountingVersion || row.source !== 'convergence' || !Number.isFinite(row.pnl)) continue;
    const map = byVariant.get(row.variant) ?? new Map();
    if (!map.has(row.mint)) map.set(row.mint, row);
    byVariant.set(row.variant, map);
  }
  const baseline = byVariant.get('convergence/baseline');
  if (!baseline) return null;
  const comparisons = [];
  for (const [variant, rows] of byVariant) {
    if (variant === 'convergence/baseline') continue;
    const train = [], test = [];
    for (const [mint, a] of baseline) {
      const b = rows.get(mint);
      if (!b || a.openedAt !== b.openedAt) continue;
      const lastClose = Math.max(a.closedAt, b.closedAt);
      if (lastClose < split) train.push(b.pnl - a.pnl);
      else if (a.openedAt >= split) test.push(b.pnl - a.pnl);
    }
    if (train.length >= 20 && test.length >= 10) comparisons.push({ variant,
      train: train.reduce((a,b) => a+b, 0)/train.length,
      test: test.reduce((a,b) => a+b, 0)/test.length, trainMints: train.length, testMints: test.length });
  }
  comparisons.sort((a,b) => b.train-a.train);
  const winner = comparisons[0];
  return winner?.train > 0 && winner.test > 0 ? winner : null;
}
