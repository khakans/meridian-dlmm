const CANDLE_SEC = 300;
const MAX_HOLD_MS = 30 * 60_000;
const TRAIL = 0.10;
const EXTRA_SWAP_COST_SOL = 0.00003;
export const RUNNER_POLL_MS = 15_000;

const usableQuote = value => Number.isFinite(value) && value > 0;
const bucket = now => Math.floor(now / (CANDLE_SEC * 1000)) * CANDLE_SEC;

function recentCandles(data, now) {
  const end = bucket(now);
  const rows = Array.isArray(data) ? data.filter(c => Number.isSafeInteger(c?.timestamp) &&
    c.timestamp % CANDLE_SEC === 0 && c.timestamp < end).sort((a, b) => a.timestamp - b.timestamp).slice(-4) : [];
  if (rows.length !== 4 || end - rows.at(-1).timestamp > 2 * CANDLE_SEC ||
      rows.some((c, i) => (i && c.timestamp - rows[i - 1].timestamp !== CANDLE_SEC) ||
        !usableQuote(c.low) || !usableQuote(c.close) || c.low > c.close ||
        !Number.isFinite(c.volume) || c.volume < 0)) return null;
  return rows;
}

function risingTrend(data, now) {
  const rows = recentCandles(data, now);
  if (!rows) return null;
  const [a, b, c, d] = rows;
  return d.close > c.close && c.close > b.close && d.low > c.low &&
    c.volume + d.volume >= a.volume + b.volume && d.volume > 0 ? { candleAt: d.timestamp, swingLow: Math.min(c.low, d.low) } : null;
}

function runner(p, { id = p.id, raw, now, quote, trend, costSol = EXTRA_SWAP_COST_SOL }) {
  return { id, mint: p.mint, pool: p.pool, pair: p.pair, raw, openedAt: now, expiresAt: now + MAX_HOLD_MS,
    longRunArm: p.longRunArm, quote, quoteAt: now, peak: quote, maxDrawdownSol: 0, costSol,
    ...trend, trendCheckedAt: now };
}

export async function prepareEntrySpot(p, { capital, now, candles, buy, sell, minExitRatio }) {
  const trend = risingTrend(candles, now);
  if (!trend) return null;
  const lamports = Math.floor(capital * 1e9);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) return null;
  const raw = await buy(p.mint, lamports);
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  const kept = await sell(p.mint, raw);
  const basis = lamports / 1e9;
  if (!usableQuote(kept) || kept < basis * minExitRatio) return null;
  return { ...runner(p, { id: `${p.id}:spot-entry`, raw, now, quote: kept, trend,
    costSol: 2 * EXTRA_SWAP_COST_SOL }),
    entrySpot: true, initialQuote: kept, baselinePnl: 0, sold: 0, fullQuote: basis };
}

export async function prepareTokenRunner(p, { raw, sol, fullQuote, pnl, now, quote, candles }) {
  const reason = p.exit?.reason ?? '';
  if (!(p.mirror || p.longRunArm === 'adaptive' || p.longRunArm === 'spot') || p.manualExit || p.hardLowerExit || !(pnl > 0) ||
      !(/^(take profit|trailing take profit|pumped far above range|OOR above \(\d+m\))$/.test(reason))) return null;
  const total = sol + fullQuote;
  if (!usableQuote(fullQuote) || !(sol >= 0) || !(fullQuote > total / 2)) return null;
  const amount = Math.floor(raw * (0.15 * total / fullQuote));
  if (!(amount > 0 && amount < raw)) return null;
  const [data, sold, kept] = await Promise.all([
    candles(p.pool, Math.floor(now / 1000)), quote(p.mint, raw - amount), quote(p.mint, amount),
  ]);
  const trend = risingTrend(data, now);
  if (!trend) return null;
  if (!usableQuote(sold) || !usableQuote(kept) || kept < 0.001 || kept > total * 0.20 ||
      !(pnl + sold + kept - fullQuote - EXTRA_SWAP_COST_SOL > 0)) return null;
  return { ...runner(p, { raw: amount, now, quote: kept, trend }), baselinePnl: pnl, fullQuote, sold, initialQuote: kept };
}

export async function sampleTokenRunner(row, { now, quote, candles }) {
  const next = { ...row };
  if (now >= row.expiresAt) next.reason ??= 'batas waktu';
  const readTrend = !next.reason && bucket(now) - row.candleAt > CANDLE_SEC && now - row.trendCheckedAt >= 60_000;
  const [value, data] = await Promise.all([
    quote(row.mint, row.raw), readTrend ? candles(row.pool, Math.floor(now / 1000)) : null,
  ]);
  if (readTrend) next.trendCheckedAt = now;
  const candles5m = recentCandles(data, now);
  if (candles5m && candles5m.at(-1).timestamp > row.candleAt) {
    const latest = candles5m.at(-1);
    if (latest.close < row.swingLow) next.reason ??= 'swing low 5 menit ditembus';
    next.swingLow = Math.max(row.swingLow, Math.min(latest.low, candles5m.at(-2).low));
    next.candleAt = latest.timestamp;
  }
  if (!usableQuote(value)) {
    next.quoteMissingSince ??= now;
    const alert = !row.routeAlerted && (next.reason || now - next.quoteMissingSince >= 30_000);
    if (alert) next.routeAlerted = true;
    return { next, alert: Boolean(alert) };
  }
  delete next.quoteMissingSince;
  next.quote = value;
  next.quoteAt = now;
  next.peak = Math.max(row.peak, value);
  next.maxDrawdownSol = Math.max(row.maxDrawdownSol, next.peak - value);
  if (value <= next.peak * (1 - TRAIL)) next.reason ??= 'trailing 10%';
  if (!next.reason) return { next };
  const deltaSol = row.sold + value - row.fullQuote - row.costSol;
  return { closed: { ...next, closedAt: now, deltaSol, pnl: row.baselinePnl + deltaSol } };
}
