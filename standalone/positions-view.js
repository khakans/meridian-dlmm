import { isActivePaperVariant } from './entry-plans.js';

const PAGE_SIZE = 2;
const MARK_MAX_AGE = 180_000;
const wib = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'medium' });
const time = value => typeof value === 'number' ? value : Date.parse(value);
const stamp = value => time(value) > 0 ? wib.format(time(value)) + ' WIB' : '—';
const safe = value => String(value ?? '').replace(/[<>&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
const amount = (value, unit, signed = false) => Number.isFinite(value)
  ? `${signed && value > 0 ? '+' : ''}${value.toFixed(unit === 'SOL' ? 4 : 2)}${unit === '%' ? '' : ' '}${unit}`
  : '—';

function elapsed(start, end) {
  if (!(time(start) > 0 && time(end) >= time(start))) return '—';
  const minutes = Math.floor((time(end) - time(start)) / 60_000);
  if (minutes < 1) return '≤1 mnt';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return [days && `${days} hari`, hours && `${hours} jam`, `${minutes % 60} mnt`].filter(Boolean).join(' ');
}

function historyPage(db, shadow, tab, requestedPage) {
  const where = shadow
    ? `kind = ? AND (json_extract(value, '$.variant') LIKE 'discovery/volatility/%' OR json_extract(value, '$.variant') LIKE 'convergence/%')`
    : `(kind = 'live-close' OR (kind = 'live-close-recovered' AND NOT EXISTS (
        SELECT 1 FROM history p WHERE p.kind = 'live-close' AND p.id = h.id
      )) OR (kind = 'decision' AND
        json_extract(value, '$.type') = 'close' AND json_extract(value, '$.position') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM history p WHERE p.kind IN ('live-close', 'live-close-recovered') AND p.id = json_extract(h.value, '$.position'))
      ))`;
  const args = shadow ? [tab === 'cancelled' ? 'paper-cancel' : 'paper-close'] : [];
  const total = db.prepare(`SELECT count(*) AS total FROM history h WHERE ${where}`).get(...args).total;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const rows = db.prepare(`SELECT kind, at, value FROM history h WHERE ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, PAGE_SIZE, page * PAGE_SIZE)
    .map(row => ({ ...JSON.parse(row.value), kind: row.kind, historyAt: row.at }));
  return { rows, total, page, pages };
}

function paperLines(p, tab, now, research) {
  const candidate = research[p.source === 'convergence' ? `convergence:${p.mint}` : p.mint];
  const pair = p.pair ?? (candidate?.pool === p.pool ? candidate?.pair : null);
  const lines = [`• ${safe(pair) || 'Pair belum tercatat'} · ${safe(p.variant)}`];
  const open = tab === 'open';
  const end = open ? now : p.closedAt ?? p.historyAt;
  const fresh = mark => Number.isFinite(mark?.pnl) && mark.at <= now && now - mark.at <= MARK_MAX_AGE;
  const indicative = open && fresh(p.indicativeMark);
  const mark = indicative ? p.indicativeMark : p.mark;
  const pnl = open ? mark?.pnl : p.accountingVersion ? p.pnl : null;
  const markLabel = indicative ? 'estimasi harga bin, tanpa quote jual'
    : p.markIssue || !fresh(mark) ? 'nilai terakhir, belum diperbarui'
    : mark.at === p.openedAt ? 'estimasi biaya awal' : 'quote jual';
  const pct = Number.isFinite(pnl) && p.capital > 0 ? pnl / p.capital * 100 : null;
  const status = open ? (p.exit ? 'Menunggu quote keluar' : p.filledAt ? 'Terisi' : 'Menunggu fill')
    : tab === 'closed' ? 'Ditutup' : 'Batal sebelum fill';
  lines.push(`Status ${status} · PnL ${open ? 'terbuka' : 'terealisasi'} ${amount(pnl, 'SOL', true)}${pct == null ? '' : ` (${amount(pct, '%', true)})`}`);
  if (!open && !p.accountingVersion) lines.push('PnL historis belum memakai pencatatan net.');
  if (open) lines.push(`Mark ${stamp(mark?.at)} · ${mark ? markLabel : 'belum ada valuasi'}`,
    ...(p.markIssue && !indicative ? [safe(p.markIssue)] : []));
  lines.push(`Dibuka ${stamp(p.openedAt)} · Umur ${elapsed(p.openedAt, end)}`);
  if (p.filledAt) lines.push(`Fill ${stamp(p.filledAt)}`);
  if (!open) lines.push(`Selesai ${stamp(end)}`);
  if (p.capital != null || p.costSol != null) lines.push(`Modal ${amount(p.capital, 'SOL')} · Biaya simulasi ${amount(p.costSol, 'SOL')}`);
  if (p.feeSol != null || p.quotedSol != null) lines.push(`Fee LP ${amount(p.feeSol, 'SOL')}${p.feeTokens > 0 ? ` + ${p.feeTokens.toPrecision(5)} token` : ''} · Quote keluar ${amount(p.quotedSol, 'SOL')}`);
  if (p.lower != null && p.upper != null) lines.push(`Range bin ${p.lower}–${p.upper}${p.entryBin == null ? '' : ` · Entry bin ${p.entryBin}`}`);
  const reason = p.reason ?? p.exit?.reason ?? p.manualExit ?? p.hardLowerExit;
  if (reason) lines.push(`Alasan ${safe(reason)}`);
  if (p.mint) lines.push(`Mint ${safe(p.mint)}`);
  if (p.pool) lines.push(`Pool ${safe(p.pool)}`);
  return lines;
}

function liveLines(p, tab, now, solMode, tracked, settlement) {
  const open = tab === 'open';
  const end = open ? now : p.historyAt;
  const minutes = open ? p.age_minutes : p.minutes_held ?? p.metrics?.minutes_held;
  const approximate = Number.isFinite(minutes) && minutes >= 0;
  const knownStart = p.opened_at ?? p.deployed_at ?? p.metrics?.deployed_at ?? tracked?.deployed_at;
  const start = knownStart ?? (approximate ? end - minutes * 60_000 : null);
  const unit = open && solMode ? 'SOL' : 'USD';
  const pnl = open || p.kind === 'live-close' ? p.pnl_usd : null;
  const pct = open || p.kind === 'live-close' ? p.pnl_pct : null;
  const lines = [
    `• ${safe(p.pair ?? p.pool_name) || 'Pair belum tercatat'}`,
    `PnL ${open ? 'terbuka' : 'terealisasi'} ${amount(pnl, unit, true)}${Number.isFinite(pct) ? ` (${amount(pct, '%', true)})` : ''}`,
    `Dibuka ${!knownStart && approximate ? '≈ ' : ''}${stamp(start)} · Umur ${elapsed(start, end)}`,
  ];
  if (open) {
    if (solMode && Number.isFinite(p.pnl_true_usd)) lines.push(`Setara ${amount(p.pnl_true_usd, 'USD', true)}`);
    lines.push(`Nilai posisi ${amount(p.total_value_usd, unit)} · Fee belum diklaim ${amount(p.unclaimed_fees_usd, unit)}`);
    lines.push(`Status range ${p.in_range == null ? '—' : p.in_range ? 'di dalam' : 'di luar'}${p.minutes_out_of_range > 0 ? ` (${p.minutes_out_of_range} mnt)` : ''}`);
  } else {
    lines.push(`Ditutup ${stamp(end)}`, `Nilai awal ${amount(p.initial_value_usd, 'USD')} · Nilai akhir ${amount(p.final_value_usd, 'USD')}`);
    lines.push(`Fee LP ${amount(p.fees_earned_usd ?? p.metrics?.fees_usd, 'USD')}`);
    if (p.close_reason ?? p.reason) lines.push(`Alasan ${safe(p.close_reason ?? p.reason)}`);
  }
  const lower = p.lower_bin ?? p.bin_range?.min;
  const upper = p.upper_bin ?? p.bin_range?.max;
  if (lower != null && upper != null) lines.push(`Range bin ${lower}–${upper}${p.active_bin == null ? '' : ` · Aktif ${p.active_bin}`}`);
  const capital = p.amount_sol ?? tracked?.amount_sol;
  const strategy = p.strategy ?? tracked?.strategy;
  if (capital != null) lines.push(`Modal awal ${amount(capital, 'SOL')}`);
  if (typeof strategy === 'string') lines.push(`Strategi ${safe(strategy)}`);
  const mint = p.base_mint ?? p.metrics?.base_mint;
  if (mint) lines.push(`Mint ${safe(mint)}`);
  if (p.pool) lines.push(`Pool ${safe(p.pool)}`);
  if (p.position) lines.push(`Position ${safe(p.position)}`);
  const closeTx = (p.close_txs ?? p.metrics?.close_txs)?.at(-1);
  if (closeTx) lines.push('Transaksi tutup', `Tx ${safe(closeTx)}`);
  if (settlement) lines.push(`Settlement ${safe(settlement.status)} · ${stamp(settlement.updatedAt)}`,
    `PnL net aktual ${amount(settlement.netSol, 'SOL', true)}`);
  if (Number.isFinite(settlement?.dustSol)) lines.push(`Sisa token di wallet ≈ ${settlement.dustSol.toFixed(8)} SOL`);
  if (settlement?.signature) lines.push(`Tx ${safe(settlement.signature)}`);
  return lines;
}

export async function openPositions({ store, readBook }) {
  if (store.database.mode === 'shadow') {
    return Object.values(store.data.paper?.open ?? {}).filter(p => isActivePaperVariant(p.variant))
      .sort((a, b) => b.openedAt - a.openedAt);
  }
  const book = await readBook().catch(() => null);
  if (book?.error || !Array.isArray(book?.positions)) return null;
  return book.positions.slice().sort((a, b) => (a.age_minutes ?? Infinity) - (b.age_minutes ?? Infinity));
}

export function positionTarget(p) {
  return { id: p.position ?? p.id, label: safe(p.pair || p.mint?.slice(0, 8) || p.position?.slice(0, 8)) };
}

export async function positionsPage({ store, tab, page, readBook, getTracked, getSettlements, solMode, now = Date.now() }) {
  const shadow = store.database.mode === 'shadow';
  const tabs = shadow ? ['open', 'closed', 'cancelled'] : ['open', 'closed'];
  if (!tabs.includes(tab)) { tab = 'open'; page = 0; }
  const labels = { open: 'Terbuka', closed: 'Riwayat tutup', cancelled: 'Batal' };
  const header = `📋 Positions · ${shadow ? 'SHADOW' : 'LIVE'} · ${labels[tab]}`;
  let result;
  if (tab === 'open') {
    const positions = await openPositions({ store, readBook });
    if (!positions) {
      return { text: `${header}\nData posisi on-chain belum tersedia. Coba Muat ulang.`, tab, tabs, page: 0, pages: 1 };
    }
    const pages = Math.max(1, Math.ceil(positions.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    result = { rows: positions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), total: positions.length, page, pages };
  } else {
    result = historyPage(store.database.db, shadow, tab, page);
  }
  const settlements = !shadow && tab === 'closed' ? new Map(getSettlements().map(row => [row.id, row])) : new Map();
  const lines = [header, `${result.total} posisi · Halaman ${result.page + 1}/${result.pages}`];
  if (shadow) lines.push('PnL simulasi dalam SOL');
  if (!result.rows.length) lines.push('', 'Belum ada posisi.');
  for (const p of result.rows) {
    lines.push('', ...(shadow
      ? paperLines(p, tab, now, store.data.research ?? {})
      : liveLines(p, tab, now, solMode, tab === 'open' ? getTracked(p.position) : null, settlements.get(p.position))));
  }
  return { text: lines.join('\n'), tab, tabs, page: result.page, pages: result.pages, total: result.total,
    targets: tab === 'open' ? result.rows.map(positionTarget) : [] };
}
