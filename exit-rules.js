// Deterministic exit and sizing rules for the standalone runtime.

import { config } from "./config.js";
import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";

export function lowerRangeStop(activeBin, lowerBin, binStep, threshold, narrow = false) {
  if (!Number.isSafeInteger(activeBin) || !Number.isSafeInteger(lowerBin) || activeBin >= lowerBin) return null;
  if (narrow) return "narrow range lower bound breached";
  if (!(threshold > 0) || !(binStep > 0)) return null;
  const drop = -100 * Math.expm1((activeBin - lowerBin) * Math.log1p(binStep / 10_000));
  return drop >= threshold ? `Below-range hard exit (${drop.toFixed(2)}% below lower bound)` : null;
}

export function narrowNetLossStop(narrow, pnlPct) {
  return narrow && Number.isFinite(pnlPct) && pnlPct <= -3 + 1e-9 ? "narrow range stop loss (3% estimated net)" : null;
}

/**
 * Rule-based close decision for a position (stop loss, take profit, range
 * exhaustion, low yield). Returns { action: "CLOSE", rule, reason } or null.
 */
export function getDeterministicCloseRule(position, managementConfig, chronosCtx = null) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    // Only treat <= -90% PnL as a pricing glitch when remaining value still exceeds 25% of initial deposit
    // Match units cleanly: solMode compares SOL (amount_sol), USD mode compares USD (initial_value_usd)
    const isSolMode = Boolean(managementConfig?.solMode);
    const depositRef = isSolMode
      ? Number(tracked?.amount_sol ?? 0)
      : Number(tracked?.initial_value_usd ?? 0);
    const currentVal = isSolMode
      ? Number(position.total_value_usd ?? 0)
      : Number(position.total_value_true_usd ?? position.total_value_usd ?? 0);
    if (depositRef > 0 && currentVal > depositRef * 0.25) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has >25% value (${currentVal}) — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  const oorAboveLimit = managementConfig.outOfRangeAboveWaitMinutes ?? managementConfig.outOfRangeWaitMinutes ?? 60;
  let oorBelowLimit = managementConfig.outOfRangeBelowWaitMinutes ?? managementConfig.outOfRangeWaitMinutes ?? 240;
  if (chronosCtx?.oor_below_outlook === "WEAK_STRUCTURAL_BREAKDOWN") {
    oorBelowLimit = managementConfig.outOfRangeBelowEarlyCutMinutes ?? 90;
  } else if (
    chronosCtx?.oor_below_outlook === "STRONG_REBOUND_PROBABILITY" &&
    (position.pnl_pct == null || position.pnl_pct > -25)
  ) {
    oorBelowLimit = (managementConfig.outOfRangeBelowWaitMinutes ?? 240) + 90;
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= oorAboveLimit
  ) {
    return { action: "CLOSE", rule: 4, reason: `OOR above (${oorAboveLimit}m)` };
  }
  if (
    !(managementConfig.outOfRangeBelowStopPct > 0) &&
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= oorBelowLimit
  ) {
    return { action: "CLOSE", rule: 4, reason: `OOR below (${oorBelowLimit}m)` };
  }
  if (
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= 0 &&
    managementConfig.minFeePerTvl24h > 0 &&
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

/**
 * Volatility-scaled bins below active bin, clamped to the configured range.
 * Throws on unknown volatility — never deploy a blind fixed range.
 */
export function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}
