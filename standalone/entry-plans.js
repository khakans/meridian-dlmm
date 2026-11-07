import { config, MIN_SAFE_BINS_BELOW } from '../config.js';
import { computeBinsBelow } from '../exit-rules.js';
import { fetchGeckoCandles } from './chronos.js';

export function fibonacciRange(candles, now = Date.now()) {
  const closed = (candles ?? []).filter(c =>
    Number(c[0]) * 1000 + 900_000 <= now &&
    [c[2], c[3], c[4]].every(n => Number(n) > 0) &&
    Number(c[2]) >= Number(c[4]) && Number(c[4]) >= Number(c[3]));
  if (closed.length < 16 || now - Number(closed.at(-1)[0]) * 1000 > 1_800_000) return null;
  // Pick the strongest chronological upward swing from closed 15-minute candles.
  let trough = Number(closed[0][3]);
  let swing = null;
  for (const candle of closed.slice(1)) {
    const high = Number(candle[2]);
    if (high > trough && (!swing || high / trough > swing.high / swing.low)) {
      swing = { low: trough, high };
    }
    trough = Math.min(trough, Number(candle[3]));
  }
  if (!swing) return null;
  const span = swing.high - swing.low;
  return {
    lower: swing.low + span * 0.236,
    upper: swing.low + span * 0.618,
    reference: Number(closed.at(-1)[4]),
    ...swing,
  };
}

export async function entryPlans(pool) {
  const step = Number(pool.dlmm_params?.bin_step);
  const bins = Math.max(MIN_SAFE_BINS_BELOW, Math.min(69, computeBinsBelow(pool.volatility)));
  const plans = [
    ...[bins, Math.min(69, bins + 12)].filter((n, i, values) => values.indexOf(n) === i)
      .map(binsBelow => ({ shape: 'spot', range: 'volatility', binsBelow })),
    { shape: 'bid_ask', range: 'volatility', binsBelow: Math.min(69, bins + 12) },
    { shape: 'curve', range: 'volatility', binsBelow: bins },
  ];
  if (!config.research.enabled || !(step > 0)) return plans;
  const fib = fibonacciRange(await fetchGeckoCandles(pool.pool_address, 15, 96));
  if (!fib) return plans;
  for (const shape of ['spot', 'bid_ask']) {
    const widthBins = Math.ceil(Math.log(fib.upper / fib.lower) / Math.log1p(step / 10_000));
    plans.push({
      shape, range: 'dakukeru', ...fib, widthBins,
      entryZoneReached: fib.reference >= fib.upper,
      wideRange: widthBins > 69,
    });
  }
  return plans;
}
