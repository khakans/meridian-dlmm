import { isActivePaperVariant } from './entry-plans.js';

export const signed = value => `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;

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
    if (Number.isFinite(p.mark?.pnl) && p.mark.at <= to && to - p.mark.at <= 180_000) {
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

export function paperPnlLines(summary, detailed) {
  const primary = ["convergence/baseline", "discovery/volatility/spot"];
  const active = summary.variants.filter(g => isActivePaperVariant(g.variant));
  const settled = active.filter(g => g.closed || g.cancelled);
  const total = settled.reduce((sum, g) => sum + g.realized, 0);
  const all = `PnL Shadow (All) · terealisasi ${settled.length ? `${signed(total)} SOL` : "—"}`;
  const groups = [
    ...primary.map(variant => active.find(g => g.variant === variant) ?? { variant }),
    ...(detailed ? active.filter(g => !primary.includes(g.variant)).slice(0, 8) : []),
  ];
  const lines = groups.map(g => {
    const label = g.variant === "convergence/baseline" ? "Convergence" : g.variant.replace(/^discovery\/volatility\//, "Discovery ");
    const open = !g.open ? "—" : !g.marked ? "menunggu valuasi" :
      `${signed(g.openPnl)} SOL${g.marked < g.open ? ` (${g.marked}/${g.open})` : ""}`;
    const realized = g.closed || g.cancelled ? `${signed(g.realized)} SOL` : "—";
    return `PnL Shadow (${label}) · terbuka ${open} · terealisasi ${realized}`;
  });
  return [all, ...lines];
}
