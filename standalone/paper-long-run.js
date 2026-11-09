const MINUTE = 60_000;
const WINDOW = 60 * MINUTE;
const MAX_GAP = 150_000;
const FEE_PER_HALF_HOUR = 0.00015;

export function observeHold(p, { now, activeBin, feeSol, feeTokens, valued }) {
  const h = p.longHold;
  if (!h || h.ended) return;
  h.samples = h.samples.filter(row => now - row.at <= WINDOW + MAX_GAP && row.at < now);
  if (valued) h.samples.push({ at: now, inRange: activeBin >= p.lower && activeBin <= p.upper, feeSol, feeTokens });
}

export function holdEvidence(p, now, feeTokenPrice, pnl) {
  const rows = p.longHold.samples;
  if (!(pnl > 0) || !rows.at(-1)?.inRange || rows.at(-1).at !== now) return null;
  let coverage = 0, inRange = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (b.at - a.at > MAX_GAP) continue;
    const duration = Math.max(0, b.at - Math.max(now - WINDOW, a.at));
    coverage += duration;
    if (a.inRange && b.inRange) inRange += duration;
  }
  if (coverage < WINDOW * 0.90 || inRange < WINDOW * 0.70) return null;
  const nearest = target => rows.findLast(row => row.at <= target && target - row.at <= MAX_GAP);
  const [first, middle, last] = [nearest(now - WINDOW), nearest(now - WINDOW / 2), rows.at(-1)];
  if (!first || !middle) return null;
  const floor = FEE_PER_HALF_HOUR * p.capital / 0.15;
  const fees = (a, b) => {
    const sol = b.feeSol - a.feeSol, tokens = b.feeTokens - a.feeTokens;
    return sol >= 0 && tokens >= 0 ? sol + tokens * feeTokenPrice : NaN;
  };
  const firstHalf = fees(first, middle), lastHalf = fees(middle, last);
  return firstHalf >= floor && lastHalf >= floor ? { firstHalf, lastHalf, inRangePct: 100 * inRange / WINDOW } : null;
}

export function applyHoldCheck(p, now, evidence) {
  const hold = p.longHold;
  if (hold.ended || now < hold.checkAt) return;
  if (!evidence) {
    hold.ended = true;
    hold.until = now;
  } else {
    if (now >= hold.until) {
      hold.until = now + 30 * MINUTE;
      hold.extensions++;
    }
    hold.checkAt = Math.min(hold.until, now + 15 * MINUTE);
    hold.evidence = evidence;
  }
  p.maxHoldMinutes = (hold.until - p.openedAt) / MINUTE;
}

export function prepareLongHold(mirror, arm, baseMinutes) {
  const until = mirror.openedAt + baseMinutes * MINUTE;
  return { ...mirror, id: `${mirror.id}:${arm}`, mirror: false, variant: `long-run/${arm}`,
    longRunArm: arm, maxHoldMinutes: baseMinutes, shapeComparison: false, screenTrial: undefined, rebalancePair: undefined,
    longHold: { until, checkAt: until, extensions: 0, samples: [] } };
}

export function longRunState(paper) {
  return paper.longRun ??= { open: {}, closed: [], matched: 0, extended: 0, realized: {} };
}

export function canEnrollLongRun(paper, capital, bankroll, maxPositions) {
  const state = longRunState(paper);
  const open = Object.values(state.open);
  const available = bankroll + Math.min(0, ...Object.values(state.realized));
  return open.length < maxPositions && open.reduce((n, c) => n + c.capital, capital) <= available + 1e-9;
}

export function longRunSpotReady(experiment) {
  return experiment.matched >= 20;
}

export function updateLongRun(paper, now) {
  const state = longRunState(paper);
  if (!Object.keys(state.open).length) return;
  const lpClosed = new Map(paper.closed.map(p => [p.id, p]));
  const runnerClosed = new Map((paper.tokenRunners?.closed ?? []).map(p => [p.id, p]));
  const runners = paper.tokenRunners?.open ?? {};
  for (const cohort of Object.values(state.open)) {
    const results = {};
    for (const [key, arm] of Object.entries(cohort.arms)) {
      const lp = lpClosed.get(arm.lpId);
      const open = paper.open[arm.lpId];
      const ids = [arm.entrySpotId, lp?.exitRunnerId].filter(Boolean);
      const closedLegs = ids.map(id => runnerClosed.get(id)).filter(Boolean);
      let marked = lp?.pnl ?? (open?.mark && !open.markIssue && now - open.mark.at <= MAX_GAP ? open.mark.pnl : null);
      for (const id of ids) {
        const done = runnerClosed.get(id);
        const leg = runners[id];
        if (done) { if (marked != null) marked += done.deltaSol; }
        else if (leg && leg.quoteMissingSince == null && now - leg.quoteAt <= 30_000) {
          if (marked != null) marked += leg.sold + leg.quote - leg.fullQuote - leg.costSol;
        } else marked = null;
      }
      if (Number.isFinite(marked)) {
        arm.peak = Math.max(arm.peak ?? 0, marked);
        arm.drawdownSol = Math.max(arm.drawdownSol ?? 0, arm.peak - marked);
      }
      if (!lp || closedLegs.length !== ids.length) continue;
      const spotPnl = closedLegs.reduce((sum, p) => sum + p.deltaSol, 0);
      const closedAt = Math.max(lp.closedAt, ...closedLegs.map(p => p.closedAt));
      results[key] = { pnl: lp.pnl + spotPnl, lpPnl: lp.pnl, spotPnl, lpFeeSol: lp.feeValueSol,
        drawdownSol: arm.drawdownSol ?? 0, minutes: (closedAt - cohort.openedAt) / MINUTE,
        extensions: lp.longRunExtensions ?? 0, closedAt };
    }
    if (Object.keys(results).length !== Object.keys(cohort.arms).length) continue;
    state.closed.push({ id: cohort.id, mint: cohort.mint, pair: cohort.pair, capital: cohort.capital,
      closedAt: Math.max(...Object.values(results).map(r => r.closedAt)), arms: results,
      deltaSol: results.adaptive.pnl - results.baseline.pnl });
    for (const [arm, result] of Object.entries(results)) state.realized[arm] = (state.realized[arm] ?? 0) + result.pnl;
    state.matched++;
    if (results.adaptive.extensions > 0) state.extended++;
    delete state.open[cohort.id];
  }
}
