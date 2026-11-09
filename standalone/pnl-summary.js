import { ENTRY_SHAPES, isActivePaperVariant } from './entry-plans.js';

export const signed = value => `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;

export function shapeTrialLines(closed = [], from) {
  const cohorts = new Map();
  for (const p of closed) {
    if (!p.shapeTrial || p.closedAt < from || !Number.isFinite(p.pnl) || !ENTRY_SHAPES.includes(p.shape)) continue;
    if (!cohorts.has(p.shapeTrial)) cohorts.set(p.shapeTrial, new Map());
    cohorts.get(p.shapeTrial).set(p.shape, p);
  }
  const complete = [...cohorts.values()].filter(group => group.size === ENTRY_SHAPES.length);
  if (!complete.length) return cohorts.size ? ['Auto Shape · menunggu ketiga shape selesai pada entry yang sama'] : [];
  return [`Auto Shape · ${complete.length} entry pembanding Shadow`, ...ENTRY_SHAPES.map(shape => {
    const positions = complete.map(group => group.get(shape));
    const pnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const inRange = positions.reduce((sum, p) => sum + (p.inRangeMs ?? 0), 0);
    const observed = positions.reduce((sum, p) => sum + (p.observedMs ?? 0), 0);
    const drawdown = Math.max(...positions.map(p => p.drawdownPct ?? 0));
    return `• ${shape} · net ${signed(pnl)} SOL · drawdown maks ${drawdown.toFixed(1)}% · in range ${observed ? (100 * inRange / observed).toFixed(0) + '%' : '—'}`;
  })];
}

export function summarizePaper(paper, from, to = Date.now()) {
  const groups = new Map();
  const get = variant => {
    if (!groups.has(variant)) groups.set(variant, { variant, open: 0, marked: 0, openPnl: 0,
      closed: 0, wins: 0, realized: 0, cancelled: 0, cancellationCost: 0 });
    return groups.get(variant);
  };
  for (const p of Object.values(paper?.open ?? {})) {
    if (!p.binSeed || !p.variant) continue;
    const g = get(p.variant);
    g.open++;
    if (!p.markIssue && Number.isFinite(p.mark?.pnl) && p.mark.at <= to && to - p.mark.at <= 180_000) {
      g.marked++;
      g.openPnl += p.mark.pnl;
    }
  }
  const mints = new Set();
  for (const p of paper?.closed ?? []) {
    if (!p.accountingVersion || !p.variant || p.closedAt < from || p.closedAt >= to || !Number.isFinite(p.pnl)) continue;
    const g = get(p.variant);
    mints.add(p.mint);
    g.closed++;
    g.wins += Number(p.pnl > 0);
    g.realized += p.pnl;
  }
  for (const p of paper?.cancelled ?? []) {
    if (!p.accountingVersion || !p.variant || p.closedAt < from || p.closedAt >= to || !Number.isFinite(p.pnl)) continue;
    const g = get(p.variant);
    g.cancelled++;
    g.cancellationCost += p.pnl;
    g.realized += p.pnl;
  }
  return { uniqueClosedMints: mints.size, variants: [...groups.values()].sort((a,b) => a.variant.localeCompare(b.variant)) };
}

export function paperRealizedLine(summary, label) {
  const settled = summary.variants.filter(g => isActivePaperVariant(g.variant) && (g.closed || g.cancelled));
  const total = settled.reduce((sum, g) => sum + g.realized, 0);
  return `PnL Shadow (${label}) · terealisasi ${settled.length ? `${signed(total)} SOL` : "—"}`;
}

export function paperPnlLines(summary, detailed, discoveryVariant = "discovery/volatility/spot", totalLabel = "All") {
  const primary = ["convergence/baseline", discoveryVariant];
  const active = summary.variants.filter(g => isActivePaperVariant(g.variant));
  const groups = [
    ...primary.map(variant => active.find(g => g.variant === variant) ?? { variant }),
    ...(detailed ? active.filter(g => !primary.includes(g.variant)).slice(0, 8) : []),
  ];
  const lines = groups.map(g => {
    const label = g.variant === "convergence/baseline" ? "Convergence baseline" : g.variant.replace(/^discovery\/volatility\//, "Discovery ");
    const open = !g.open ? "0 posisi" : !g.marked ? `menunggu valuasi (${g.open} posisi)` :
      `${signed(g.openPnl)} SOL${g.marked < g.open ? ` (${g.marked}/${g.open})` : ""}`;
    const realized = g.closed || g.cancelled ? `${signed(g.realized)} SOL` : "belum ada posisi selesai";
    return `PnL Shadow (${label}) · terbuka ${open} · terealisasi ${realized}`;
  });
  return [paperRealizedLine(summary, totalLabel), ...lines];
}
