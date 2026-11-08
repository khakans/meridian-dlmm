import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { REPO_ROOT } from '../repo-root.js';

export const emptyMonitor = () => ({
  version: 1, wallets: {}, pending: {}, seen: {}, events: [], signals: {}, attempts: {}, paused: false,
});

function readLegacy(root, filename, fallback) {
  const file = path.join(root, filename);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

export function openModeDatabase(mode, root = REPO_ROOT) {
  if (!['shadow', 'live'].includes(mode)) throw Error('Invalid SQLite mode');
  const dir = path.join(root, '.meridian-data');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, `${mode}.sqlite`));
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
    CREATE TABLE IF NOT EXISTS history (
      kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
      pnl REAL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(kind,id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS history_time ON history(kind, at);
  `);
  const select = db.prepare('SELECT value FROM documents WHERE key=?');
  const upsert = db.prepare('INSERT INTO documents VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const insert = db.prepare('INSERT OR IGNORE INTO history VALUES (?,?,?,?,?)');
  const get = (key, fallback = null) => {
    const row = select.get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const put = (key, value) => upsert.run(key, JSON.stringify(value));
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function append(kind, id, at, value, pnl = null) {
    insert.run(kind, String(id), Number.isSafeInteger(at) ? at : 0, Number.isFinite(pnl) ? pnl : null, JSON.stringify(value));
  }
  function saveMonitor(state, known = new Set()) {
    const added = [];
    transaction(() => {
      put('monitor', state);
      for (const [kind, rows] of [['paper-close', state.paper?.closed], ['paper-cancel', state.paper?.cancelled]]) {
        for (const row of rows ?? []) {
          const id = row.id ?? `${row.mint}:${row.variant}:${row.closedAt ?? row.at}`;
          const key = `${kind}:${id}`;
          if (known.has(key)) continue;
          append(kind, id, row.closedAt ?? row.at, row, row.pnl);
          added.push(key);
        }
      }
      for (const [kind, rows] of [
        ['signal', Object.values(state.signals).filter(row => row.done)],
        ['entry-attempt', Object.values(state.attempts).filter(row => row.status !== 'submitting')],
      ]) {
        for (const row of rows) {
          const at = row.closedAt ?? row.at ?? row.createdAt;
          const id = `${row.mint}:${row.createdAt ?? row.at}:${row.status ?? 'done'}`;
          const key = `${kind}:${id}`;
          if (known.has(key)) continue;
          append(kind, id, at, row);
          added.push(key);
        }
      }
    });
    for (const key of added) known.add(key);
  }

  try {
    transaction(() => {
      if (get('migration-v1')) return;
      const previous = readLegacy(root, 'wallet-monitor-state.json', emptyMonitor());
      if (previous.version !== 1 || !previous.wallets || !previous.attempts || !Array.isArray(previous.events)) {
        throw Error('Invalid legacy monitor; SQLite migration refused');
      }
      const monitor = emptyMonitor();
      if (mode === 'shadow') {
        Object.assign(monitor, { paper: previous.paper, research: previous.research });
        put('overnight', readLegacy(root, 'pnl-overnight.json', null));
      }
      // Never replay signals or pending transactions from the formerly shared monitor.
      monitor.attempts = Object.fromEntries(Object.entries(previous.attempts).filter(([, a]) =>
        mode === 'live' ? ['entered', 'submitting'].includes(a.status) : a.status === 'proposed'));
      if (previous.pnlResetAt?.[mode]) monitor.pnlResetAt = { [mode]: previous.pnlResetAt[mode] };
      put('monitor', monitor);
      if (mode === 'live') {
        for (const [key, file, fallback] of [
          ['positions', 'state.json', { positions: {}, recentEvents: [], lastUpdated: null }],
          ['performance', 'lessons.json', { lessons: [], performance: [] }],
          ['decisions', 'decision-log.json', { decisions: [] }],
          ['pool-memory', 'pool-memory.json', {}],
        ]) put(key, readLegacy(root, file, fallback));
        for (const [i, row] of (get('performance').performance ?? []).entries()) {
          append('live-close', row.position ?? `legacy-${i}`, Date.parse(row.recorded_at), row, row.pnl_usd);
        }
        for (const [i, row] of (get('decisions').decisions ?? []).entries()) {
          append('decision', row.id ?? `legacy-${i}`, Date.parse(row.ts), row);
        }
      } else {
        for (const [kind, rows] of [['paper-close', monitor.paper?.closed], ['paper-cancel', monitor.paper?.cancelled]]) {
          for (const row of rows ?? []) append(kind, row.id ?? `${row.mint}:${row.variant}:${row.closedAt ?? row.at}`, row.closedAt ?? row.at, row, row.pnl);
        }
      }
      put('migration-v1', { at: Date.now(), mode });
    });
    if (get('migration-v1')?.mode !== mode) throw Error('SQLite database mode mismatch');
  } catch (error) { db.close(); throw error; }
  return { mode, db, get, put, append, transaction, saveMonitor };
}

let selected;
export function modeDatabase() {
  return selected ??= openModeDatabase(config.standalone.shadow || process.env.DRY_RUN === 'true' ? 'shadow' : 'live');
}
