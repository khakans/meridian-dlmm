import { ENTRY_SHAPES, isActivePaperVariant, shapeLabel } from './entry-plans.js';
import { longRunSpotReady } from './paper-long-run.js';

export const signed = value => `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;

export function narrowRangeLines(paper, from, detailed) {
  const open = Object.values(paper?.open ?? {}).filter(p => p.rangeTrial).length;
  const rows = (paper?.closed ?? []).filter(p => p.closedAt >= from && Number.isFinite(p.pnl) && p.capital > 0);
  const baseline = new Map(rows.filter(p => p.mirror).map(p => [p.id, p]));
  const closed = rows.filter(p => p.rangeTrial);
  const matched = closed.filter(p => baseline.has(p.rangeTrial));
  if (!open && !closed.length) return [];
  const lines = [`Range sempit Shadow · ${open} aktif · ${matched.length} pasangan selesai${closed.length > matched.length ? ` · ${closed.length - matched.length} menunggu pembanding` : ''}`];
  if (!matched.length) return lines;
  const controls = matched.map(p => baseline.get(p.rangeTrial));
  const delta = matched.reduce((sum, p, i) => sum + p.pnl - controls[i].pnl, 0);
  lines[0] += ` · Δ net ${signed(delta)} SOL vs range standar`;
  if (detailed) {
    for (const [label, group] of [['Sempit', matched], ['Standar', controls]]) {
      const returns = group.map(p => 100 * p.pnl / p.capital).sort((a, b) => a - b);
      const mid = Math.floor(returns.length / 2);
      const median = returns.length % 2 ? returns[mid] : (returns[mid - 1] + returns[mid]) / 2;
      lines.push(`• ${label} · median ${median.toFixed(2)}% · terburuk ${returns[0].toFixed(2)}% · ≥9% ${returns.filter(v => v >= 9).length}/${group.length} · OOR bawah ${group.filter(p => p.wasBelowRange).length}`);
    }
  }
  return lines;
}

export function shapeTrialLines(closed = [], from) {
  const cohorts = new Map();
  for (const p of closed) {
    if (!p.shapeTrial || p.closedAt < from || !Number.isFinite(p.pnl) || !ENTRY_SHAPES.includes(p.shape)) continue;
    if (!cohorts.has(p.shapeTrial)) cohorts.set(p.shapeTrial, new Map());
    cohorts.get(p.shapeTrial).set(p.shape, p);
  }
  const mirrors = new Map(closed.filter(p => p.mirror && p.closedAt >= from && Number.isFinite(p.pnl)).map(p => [p.id, p]));
  const complete = [...cohorts.entries()].filter(([id, group]) => mirrors.has(id) && group.size === ENTRY_SHAPES.length);
  if (!complete.length) return cohorts.size ? ['Auto Shape · menunggu Auto dan ketiga shape pembanding selesai'] : [];
  const summary = (label, positions) => {
    const pnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const inRange = positions.reduce((sum, p) => sum + (p.inRangeMs ?? 0), 0);
    const observed = positions.reduce((sum, p) => sum + (p.observedMs ?? 0), 0);
    const drawdowns = positions.map(p => p.drawdownPct).filter(Number.isFinite);
    return `• ${label} · net ${signed(pnl)} SOL · drawdown maks ${drawdowns.length ? Math.max(...drawdowns).toFixed(1) + '%' : '—'} · in range ${observed ? (100 * inRange / observed).toFixed(0) + '%' : '—'}`;
  };
  return [`Auto Shape · ${complete.length}/20 entry Shadow yang sama`,
    summary('Auto', complete.map(([id]) => mirrors.get(id))),
    ...ENTRY_SHAPES.map(shape => summary(shapeLabel(shape), complete.map(([, group]) => group.get(shape))))];
}

export function rebalanceTrialLines(paper, from, detailed) {
  const rows = (paper?.closed ?? []).filter(p => p.closedAt >= from && Number.isFinite(p.pnl));
  const baselines = new Map(rows.filter(p => p.rebalancePair && p.mirror).map(p => [p.rebalancePair, p]));
  const pairs = rows.filter(p => p.rebalanceTrial && baselines.has(p.rebalancePair));
  const open = Object.values(paper?.open ?? {}).filter(p => p.rebalanceTrial);
  const lines = [];
  if (open.length || pairs.length) {
    const delta = pairs.reduce((sum, p) => sum + p.pnl - baselines.get(p.rebalancePair).pnl, 0);
    lines.push(`Auto Rebalance · ${open.length} terbuka · ${pairs.length} pembanding selesai${pairs.length ? ` · Δ net ${signed(delta)} SOL (${pairs.filter(p => p.rebalances?.length).length} berubah)` : ''}`);
  }
  for (const p of open.slice(0, 4)) {
    const latest = p.rebalances?.at(-1);
    lines.push(`• ${p.pair ?? p.mint.slice(0, 8)} · ${shapeLabel(p.shape, p.shapeMode, p.rebalances)}${latest ? ` · ${latest.reason} · biaya simulasi ${latest.costSol.toFixed(5)} SOL` : ''}`);
  }
  if (detailed) {
    const groups = ['pass', 'reject', 'missing'].map(status => rows.filter(p => p.mirror && p.screenTrial?.status === status));
    if (groups.some(group => group.length)) {
      const label = (i, name) => `${name} ${groups[i].length}${groups[i].length ? ` (${signed(groups[i].reduce((sum, p) => sum + p.pnl, 0))} SOL)` : ''}`;
      lines.push(`Uji screening Shadow · ${label(0, 'lolos')} · ${label(1, 'tertahan')} · ${groups[2].length} data kurang`);
    }
  }
  return lines;
}

export function tokenRunnerLines(paper, from, now, detailed) {
  const baseline = p => !p.longRunArm || p.longRunArm === 'baseline';
  const open = Object.values(paper?.tokenRunners?.open ?? {}).filter(baseline);
  const closed = (paper?.tokenRunners?.closed ?? []).filter(p => baseline(p) && p.closedAt >= from && p.closedAt <= now);
  if (!open.length && !closed.length) return [];
  const waiting = open.filter(p => p.quoteMissingSince != null).length;
  const delta = closed.reduce((sum, p) => sum + p.deltaSol, 0);
  const lines = [`Sisa token Shadow · ${open.length} terbuka · ${closed.length} selesai${waiting ? ` · ${waiting} tunggu quote` : ''}${closed.length ? ` · Δ net ${signed(delta)} SOL vs langsung jual` : ''}`];
  if (detailed) {
    if (closed.length) {
      const worst = Math.max(...closed.map(p => p.maxDrawdownSol ?? 0));
      lines.push(`Penurunan terbesar sisa token dari puncak quote · ${worst.toFixed(5)} SOL`);
    }
    for (const p of open) {
      const fresh = p.quoteMissingSince == null && now - p.quoteAt <= 30_000;
      const mark = fresh ? `Δ ${signed(p.sold + p.quote - p.fullQuote - p.costSol)} SOL` : 'menunggu quote';
      lines.push(`• ${p.pair ?? p.mint.slice(0, 8)} · ${mark}${p.reason ? ` · exit ${p.reason}` : ''}`);
    }
  }
  return lines;
}

export function longRunLines(paper, from, detailed) {
  const state = paper?.longRun;
  if (!state) return [];
  const open = Object.values(state.open);
  const closed = state.closed.filter(p => p.closedAt >= from);
  const delta = closed.reduce((n, p) => n + p.deltaSol, 0);
  const lines = [`Long Run Shadow · ${open.length} uji aktif · ${state.matched} pembanding selesai · ${state.extended} pernah diperpanjang${closed.length ? ` · Δ net ${signed(delta)} SOL vs hold standar` : ''}`];
  if (!detailed) return lines;
  lines.push(`LP + spot · ${longRunSpotReady(state) ? 'bisa diuji pada entry yang memenuhi syarat' : `tahap 2 setelah ${state.matched}/20 pembanding`}`);
  const summarize = (label, rows, arm) => {
    const values = rows.map(r => r.arms[arm]);
    const sum = key => values.reduce((n, p) => n + p[key], 0);
    const hours = sum('minutes') / 60;
    return `${label} · fee LP ${signed(sum('lpFeeSol'))} SOL · spot ${signed(sum('spotPnl'))} SOL · net ${signed(sum('pnl'))} SOL · DD maks ${Math.max(...values.map(p => p.drawdownSol)).toFixed(4)} SOL · ${hours > 0 ? signed(sum('pnl') / hours) + ' SOL/jam' : '—'}`;
  };
  if (closed.length) lines.push(summarize('Standar', closed, 'baseline'), summarize('Hold adaptif', closed, 'adaptive'));
  const spot = closed.filter(p => p.arms.spot);
  if (spot.length) {
    const delta = spot.reduce((n, p) => n + p.arms.spot.pnl - p.arms.adaptive.pnl, 0);
    lines.push(`LP + spot · ${spot.length} pembanding · Δ net ${signed(delta)} SOL vs adaptif`,
      summarize('Adaptif pembanding', spot, 'adaptive'), summarize('Adaptif + spot', spot, 'spot'));
  }
  for (const c of open.slice(0, 4)) {
    const p = paper.open[c.arms.adaptive.lpId];
    if (p?.longHold?.extensions) lines.push(`• ${c.pair ?? c.mint.slice(0, 8)} · ${p.longHold.extensions} perpanjangan hold`);
  }
  return lines;
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
