import { config, MIN_SAFE_BINS_BELOW } from '../config.js';
import { computeBinsBelow } from '../exit-rules.js';
import { fetchJson } from './rpc.js';

export const ENTRY_SHAPES = ['spot', 'curve', 'bid_ask'];
const CANDLE_SECONDS = 300;
const SHAPE_LABELS = { spot: 'Spot', curve: 'Curve', bid_ask: 'Bid Ask', auto: 'Auto' };
const PAIR_LABELS = { single: 'Single', dual: 'Dual', auto: 'Auto' };

export function pairModeLabel(mode, side) {
  if (mode === 'auto' && (side === 'single' || side === 'dual')) return `Auto (${PAIR_LABELS[side]})`;
  return PAIR_LABELS[mode] ?? null;
}

export function shapeLabel(shape, mode, rebalances) {
  const actual = SHAPE_LABELS[shape];
  if (!actual) return null;
  const latest = rebalances?.at(-1);
  if (latest) return `Auto (${SHAPE_LABELS[latest.from]} → ${actual})`;
  return mode === 'auto' ? `Auto (${actual})` : actual;
}

function entryMarket(candles, { now, binStep, price }) {
  const end = Math.floor(now / CANDLE_SECONDS) * CANDLE_SECONDS;
  const rows = Array.isArray(candles) ? candles.filter(c => Number.isSafeInteger(c?.timestamp) &&
    c.timestamp % CANDLE_SECONDS === 0 && c.timestamp < end).sort((a, b) => a.timestamp - b.timestamp).slice(-6) : [];
  if (rows.length < 6 || end - rows.at(-1).timestamp > 2 * CANDLE_SECONDS ||
      rows.some((c, i) => (i > 0 && c.timestamp - rows[i - 1].timestamp !== CANDLE_SECONDS) ||
        ![c.open, c.high, c.low, c.close].every(x => Number.isFinite(x) && x > 0) ||
        c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) ||
        !Number.isFinite(c.volume) || c.volume < 0) ||
      !Number.isFinite(price) || !Number.isFinite(binStep) || !(price > 0 && binStep > 0)) return null;
  const bins = (a, b) => Math.log(a / b) / Math.log1p(binStep / 10_000);
  const closes = [rows[0].open, ...rows.map(c => c.close)];
  const changes = closes.slice(1).map((close, i) => bins(close, closes[i]));
  const drift = changes.reduce((sum, n) => sum + n, 0);
  const path = changes.reduce((sum, n) => sum + Math.abs(n), 0);
  const directionality = Math.abs(drift) / (path || 1);
  const recent = changes.slice(-3);
  const recentDrift = recent.reduce((sum, n) => sum + n, 0);
  const recentPath = recent.reduce((sum, n) => sum + Math.abs(n), 0);
  const moveSinceClose = bins(price, closes.at(-1));
  const falling = changes.at(-1) <= -4 || moveSinceClose <= -4 ||
    (recentDrift <= -4 && -recentDrift >= 0.65 * recentPath);
  const [priorVolume, recentVolume] = [rows.slice(0, 3), rows.slice(-3)]
    .map(group => group.reduce((sum, c) => sum + c.volume, 0));
  const thin = recentVolume <= 0 || recentVolume < 0.35 * priorVolume;
  return { rows, bins, drift, path, directionality, recentDrift, moveSinceClose, falling, thin, recentVolume, priorVolume };
}

export function narrowEntryRange(candles, market, baselineWidth, minimumWidth) {
  const trend = entryMarket(candles, market);
  if (!trend || trend.falling || trend.thin) return null;
  const support = Math.min(...trend.rows.slice(0, -1).map(c => c.low));
  if (Math.min(market.price, trend.rows.at(-1).close) < support) return null;
  const ratio = 1 + market.binStep / 10_000;
  return [35, 45].find(width => width >= minimumWidth && width < baselineWidth &&
    market.price / ratio ** width <= support * 0.98) ?? null;
}

export function chooseEntryPair(mode, candles, market) {
  if (mode === 'single' || mode === 'dual') return { side: mode, reason: 'manual' };
  if (mode !== 'auto') return { side: null, reason: 'pengaturan pair mode tidak valid' };
  const trend = entryMarket(candles, market);
  if (!trend) return { side: null, reason: 'data candle atau harga belum lengkap' };
  const { rows, bins, drift, recentDrift, moveSinceClose, falling, thin, recentVolume, priorVolume } = trend;
  if (falling) return { side: null, reason: 'harga turun tajam' };
  if (thin) return { side: null, reason: 'volume terbaru menipis' };
  const tolerance = 1e-9; // Logarithmic bin distances round slightly at integer boundaries.
  const support = Math.min(...rows.slice(0, -1).map(c => c.low));
  if (bins(Math.min(market.price, rows.at(-1).close), support) < -1 - tolerance) {
    return { side: null, reason: 'harga menembus support' };
  }
  const recent = rows.slice(-3);
  const spread = bins(Math.max(market.price, ...recent.map(c => c.high)), Math.min(market.price, ...recent.map(c => c.low)));
  if (drift >= -2 - tolerance && recentDrift >= -1 - tolerance && moveSinceClose >= -1 - tolerance && spread <= 6 + tolerance &&
      priorVolume > 0 && recentVolume >= 0.8 * priorVolume) {
    return { side: 'dual', reason: 'harga stabil, support bertahan, dan volume terjaga' };
  }
  return { side: 'single', reason: 'support bertahan, tetapi harga atau volume belum cukup stabil untuk Dual' };
}

export function chooseEntryShape(candles, { now, binStep, binsBelow, price, feeRatio, minFeeRatio, exitRatio, minExitRatio }) {
  const market = entryMarket(candles, { now, binStep, price });
  if (!market || !(binsBelow > 0)) return { shape: null, reason: 'data candle belum lengkap atau kedaluwarsa' };
  if (!(exitRatio >= minExitRatio)) return { shape: null, reason: 'quote jual belum lolos' };
  const { rows, bins, path, directionality, falling, thin, recentVolume, priorVolume } = market;
  if (falling) return { shape: null, reason: 'harga turun tajam satu arah' };
  if (thin) return { shape: null, reason: 'volume terbaru menipis' };
  const spread = bins(Math.max(...rows.map(c => c.high)), Math.min(...rows.map(c => c.low)));
  if (spread <= Math.max(5, binsBelow * 0.18) && directionality <= 0.45 && path >= 1 &&
      recentVolume >= 0.8 * priorVolume && feeRatio >= minFeeRatio) {
    return { shape: 'curve', reason: 'harga bolak-balik dalam range sempit dan fee memadai' };
  }
  if (spread >= Math.max(10, binsBelow * 0.25) && directionality <= 0.5 && path >= 4 &&
      recentVolume >= 0.65 * priorVolume && exitRatio >= Math.max(0.98, minExitRatio)) {
    return { shape: 'bid_ask', reason: 'ayunan lebar dua arah dengan quote jual kuat' };
  }
  return { shape: 'spot', reason: 'kondisi campuran' };
}

export async function entryCandles(address, now = Math.floor(Date.now() / 1000)) {
  const query = new URLSearchParams({ timeframe: '5m', start_time: String(now - 9 * CANDLE_SECONDS), end_time: String(now) });
  const result = await fetchJson(`https://dlmm.datapi.meteora.ag/pools/${address}/ohlcv?${query}`,
    { signal: AbortSignal.timeout(4500) }).catch(() => null);
  return result?.data;
}

export async function resolveEntryShape(mode, pool, binsBelow, entry, { candles, now = Math.floor(Date.now() / 1000) } = {}) {
  if (ENTRY_SHAPES.includes(mode)) return { shape: mode, reason: 'manual' };
  if (mode !== 'auto') return { shape: null, reason: 'pengaturan shape tidak valid' };
  return chooseEntryShape(candles ?? await entryCandles(pool.pool_address, now), {
    now, binsBelow, binStep: entry.binStep, price: Number(entry.price),
    feeRatio: Number(pool.fee_active_tvl_ratio), minFeeRatio: config.screening.minFeeActiveTvlRatio,
    exitRatio: entry.exitRatio, minExitRatio: config.research.paperMinExitRatio,
  });
}

export function scoreShadowScreen(candles, poolHour, capital, now) {
  const end = Math.floor(now / CANDLE_SECONDS) * CANDLE_SECONDS;
  const volumes = [2, 1].map(i => candles?.find(row => row.timestamp === end - i * CANDLE_SECONDS)?.volume);
  // Historical pool-level proxy. Actual fees are measured per bin by the paper lifecycle.
  const ratio = poolHour?.fee_active_tvl_ratio == null || poolHour.fee_active_tvl_ratio === '' ? NaN : Number(poolHour.fee_active_tvl_ratio);
  if (!volumes.every(v => Number.isFinite(v) && v >= 0) || !Number.isFinite(ratio) || ratio < 0) return { status: 'missing' };
  const estimatedFeeSol = capital * ratio / 100;
  return { status: volumes.every(v => v >= 500) && estimatedFeeSol >= 0.0003 ? 'pass' : 'reject', estimatedFeeSol };
}

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
