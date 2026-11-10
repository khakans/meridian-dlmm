import { holdCandleHealth, lastClosedCandle } from './entry-plans.js';
import { holdEvidence, observeHold } from './paper-long-run.js';

const MINUTE = 60_000;
const CANDLE_MS = 5 * MINUTE;

export function evaluateLiveHold(state, { now, baseMinutes, capital, mark, candles, canDecide = true }) {
  const hold = state.liveHold ??= {
    reviewAt: Math.max(now, state.openedAt + baseMinutes * MINUTE), samples: [], extensions: 0,
  };
  hold.until ??= hold.reviewAt;
  const position = { lower: state.lower, upper: state.upper, capital, longHold: hold };
  const valid = mark && Number.isSafeInteger(mark.activeBin) && mark.price > 0 &&
    [mark.pnlPct, mark.feeSol, mark.feeTokens, mark.feeTokenPrice, mark.exitRatio].every(Number.isFinite);
  observeHold(position, { now, activeBin: mark?.activeBin, feeSol: mark?.feeSol, feeTokens: mark?.feeTokens, valued: valid });
  if (!canDecide || now < hold.reviewAt) return null;
  if (now >= hold.until + 2 * CANDLE_MS) return 'adaptive hold expired without fresh productive evidence';

  const candle = lastClosedCandle(now);
  if (hold.lastCandle === candle || !valid) return null;
  const health = holdCandleHealth(candles, { now, binStep: mark.binStep, price: mark.price });
  if (health == null) return null;
  const evidence = health && mark.exitRatio >= 0.98 &&
    holdEvidence(position, now, mark.feeTokenPrice, mark.pnlPct);
  const consecutive = hold.lastCandle === candle - CANDLE_MS / 1000;
  hold.lastCandle = candle;
  if (!evidence) {
    hold.weak = consecutive ? (hold.weak ?? 0) + 1 : 1;
    return hold.weak >= 2 ? 'adaptive hold: two candles without productive evidence' : null;
  }

  hold.weak = 0;
  if (now >= hold.until) {
    hold.until = now + 30 * MINUTE;
    hold.extensions++;
  }
  return null;
}
