import { MIN_SAFE_BINS_BELOW } from '../config.js';
import { computeBinsBelow } from '../exit-rules.js';

export function isActivePaperVariant(variant) {
  return typeof variant === 'string' &&
    (variant.startsWith('convergence/') || variant.startsWith('discovery/volatility/'));
}

export function entryPlans(pool) {
  const bins = Math.max(MIN_SAFE_BINS_BELOW, Math.min(69, computeBinsBelow(pool.volatility)));
  const wide = Math.min(69, bins + 12);
  return [
    { shape: 'spot', range: 'volatility', binsBelow: bins },
    ...(wide > bins ? [{ shape: 'spot', range: 'volatility', binsBelow: wide }] : []),
    { shape: 'bid_ask', range: 'volatility', binsBelow: wide },
    { shape: 'curve', range: 'volatility', binsBelow: bins },
  ];
}
