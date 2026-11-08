import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { paperBins, paperCloseRule, paperInventory, startPaper } from '../standalone/paper.js';
import { markPaperBins, recommendPaperVariant, seedPaperBins } from '../standalone/paper-accounting.js';
import { summarizePaper } from '../standalone/pnl-summary.js';
import { emptyMonitor, openModeDatabase } from '../standalone/database.js';

test('SQLite migrates paper and live data separately and persists paper history once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sqlite-'));
  let shadow, live;
  try {
    const monitor = { ...emptyMonitor(), paper: { closed: [{ id: 'paper1', closedAt: 100, pnl: 0.03 }] },
      attempts: { a: { status: 'entered' }, b: { status: 'proposed' } }, pending: { stale: {} },
      pnlResetAt: { shadow: 10, live: 20 } };
    fs.writeFileSync(path.join(dir, 'wallet-monitor-state.json'), JSON.stringify(monitor));
    fs.writeFileSync(path.join(dir, 'lessons.json'), JSON.stringify({ lessons: [], performance: [{ position: 'live1', pnl_usd: 3 }] }));
    shadow = openModeDatabase('shadow', dir);
    live = openModeDatabase('live', dir);
    const state = shadow.get('monitor');
    assert.deepEqual(Object.keys(state.attempts), ['b']);
    assert.deepEqual(Object.keys(live.get('monitor').attempts), ['a']);
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.pnlResetAt, { shadow: 10 });
    assert.equal(live.get('monitor').paper, undefined);
    assert.equal(shadow.get('performance'), null);
    assert.equal(live.get('performance').performance[0].position, 'live1');
    shadow.saveMonitor(state);
    shadow.saveMonitor({ ...state, paper: { closed: [] } });
    shadow.db.close();
    shadow = openModeDatabase('shadow', dir);
    assert.equal(shadow.get('monitor').paper.closed.length, 0);
    assert.equal(shadow.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-close'").get().n, 1);
    assert.equal(live.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-close'").get().n, 0);
    assert.equal(shadow.db.prepare("SELECT count(*) AS n FROM history WHERE kind='pnl-reset'").get().n, 1);
    assert.equal(live.get('monitor').pnlResetAt.live, 20);
  } finally {
    if (shadow?.db.isOpen) shadow.db.close();
    if (live?.db.isOpen) live.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paper status separates variants, ignores stale marks and applies the realized reset cutoff', () => {
  const now = 1_800_000_000_000;
  const paper = {
    open: { a: { binSeed: [], variant: 'spot', mark: { at: now - 10, pnl: 0.1 } },
      b: { binSeed: [], variant: 'curve', mark: { at: now - 200_000, pnl: 0.2 } } },
    closed: [{ accountingVersion: 1, variant: 'spot', mint: 'x', closedAt: now - 20, pnl: 0.03 },
      { accountingVersion: 1, variant: 'curve', mint: 'x', closedAt: now - 30, pnl: 0.05 }],
    cancelled: [{ accountingVersion: 1, variant: 'spot', closedAt: now - 5, pnl: -0.001 }],
  };
  const { variants, uniqueClosedMints } = summarizePaper(paper, now - 25, now);
  assert.equal(uniqueClosedMints, 1);
  assert.equal(variants[0].marked, 0);
  assert.equal(variants[0].closed, 0);
  assert.equal(variants[1].openPnl, 0.1);
  assert.equal(variants[1].realized, 0.028999999999999998);
});

test('paper mark credits only fee growth after admission and rejects backwards counters', () => {
  const q = 1n << 64n;
  const p = { lower: 1, upper: 1, shape: 'spot', capital: 1, decimals: 6 };
  const bin = { supply: 10_000_000_000n * q, yAmount: 10_000_000_000n, xAmount: 0n,
    pricePerToken: '1', feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: q };
  p.binSeed = seedPaperBins(p, new Map([[1, bin]]));
  assert.equal(markPaperBins(p, 2, new Map([[1, bin]])).feeSol, 0);
  assert.equal(markPaperBins(p, 2, new Map([[1, { ...bin, feeAmountYPerTokenStored: 2n * q }]])).feeSol, 1);
  assert.equal(markPaperBins(p, 2, new Map([[1, { ...bin, feeAmountYPerTokenStored: 0n }]])), null);
});

test('parameter recommendation requires paired mints and an independent validation window', () => {
  const now = 1_800_000_000_000, day = 86_400_000;
  const rows = Array.from({ length: 30 }, (_, i) => {
    const openedAt = now - (i < 20 ? 4 : 2) * day;
    const base = { mint: String(i), openedAt, closedAt: openedAt + 1,
      source: 'convergence', outcome: 'settled', accountingVersion: 1 };
    return [{ ...base, variant: 'convergence/baseline', pnl: 0 },
      { ...base, variant: 'convergence/wider', pnl: 0.01 }];
  }).flat();
  assert.equal(recommendPaperVariant(rows, now).variant, 'convergence/wider');
  assert.equal(recommendPaperVariant(rows.slice(0, -2), now), null);
});

test('paper exits wait for initial range and buffer losing exits while honoring risk stops', () => {
  const minute = 60_000;
  const openedAt = 1_800_000_000_000;
  const p = { id: 'fixture', lower: 65, upper: 99, openedAt };
  const above = { binId: p.upper + config.management.outOfRangeBinsToClose + 1 };
  assert.equal(paperCloseRule(p, above, -0.2, openedAt + minute), null);
  const late = { id: 'late', lower: 65, upper: 99, openedAt };
  assert.equal(paperCloseRule(late, above, -0.2, openedAt + config.research.paperInitialRangeWaitMinutes * minute), 'entry range not reached');
  assert.equal(paperCloseRule(p, { binId: 90 }, -0.2, openedAt + 2 * minute), null);
  const lossAt = openedAt + 3 * minute;
  assert.equal(paperCloseRule(p, above, -0.2, lossAt), null);
  assert.equal(paperCloseRule({ ...p }, above, 0.1, lossAt + minute), 'pumped far above range');
  assert.equal(paperCloseRule({ ...p }, { binId: 60 }, config.management.stopLossPct - 1, lossAt + minute), 'stop loss');
  assert.equal(paperCloseRule(p, above, -0.2, lossAt + config.research.paperLossGraceMinutes * minute), 'pumped far above range');
});

test('quote-only bins convert inventory as price crosses and reject retired ranges', () => {
  const active = { binId: 100, price: 1 };
  const range = paperBins({ range: 'volatility', binsBelow: 35 }, active, 100);
  assert.deepEqual(range, { lower: 65, upper: 99, ratio: 1.01 });
  const position = { ...range, shape: 'spot', capital: 1, entryBin: 100, entryPrice: 1 };
  assert.deepEqual(paperInventory(position, 100), { sol: 1, tokens: 0 });
  assert.ok(paperInventory(position, 80).sol < 1);
  assert.equal(paperInventory(position, 64).sol, 0);
  assert.ok(paperInventory(position, 64).tokens > 1);
  assert.equal(paperBins({ range: 'retired', lower: 0.5, upper: 0.8 }, active, 100), null);
});

test('paper entry checks exit quote and persists an exit awaiting settlement', async () => {
  const before = config.standalone.shadow;
  config.standalone.shadow = true;
  const c = { at: Date.now(), mint: 'fixture', pool: 'fixture', decimals: 6, binStep: 100,
    plans: [{ range: 'volatility', shape: 'spot', binsBelow: 35 }] };
  const store = { data: { research: { fixture: c } }, save() {} };
  let active = { binId: 100, price: 1 };
  let quoteAvailable = false;
  let run;
  const messages = [];
  const stop = startPaper(store, async text => messages.push(text), {
    getBin: async () => active,
    snapshot: async (_pool, lower, upper) => {
      const q = 1n << 64n;
      return new Map(Array.from({ length: upper - lower + 1 }, (_, i) => [lower + i, {
        supply: 10_000_000_000n * q, pricePerToken: '1',
        yAmount: active.binId === 100 ? 10_000_000_000n : 0n,
        xAmount: active.binId === 100 ? 0n : 10_000_000n,
        feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: 0n,
      }]));
    },
    quote: async (_, amount) => {
      if (!quoteAvailable) throw Error('No route');
      return amount / 1e6 * active.price;
    },
    schedule: callback => { run = callback; return null; },
  });
  try {
    // The startup pass is asynchronous.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.data.paper.skipped, 1);
    assert.equal(Object.keys(store.data.paper.open).length, 0);
    quoteAvailable = true;
    await run();
    const [position] = Object.values(store.data.paper.open);
    assert.ok(position);
    active = { binId: 20, price: 0.3 };
    position.openedAt = Date.now() - (config.research.paperMaxHoldMinutes + 1) * 60_000;
    quoteAvailable = false;
    for (let i = 0; i < config.pnl.confirmTicks; i++) await run();
    assert.ok(position.exit?.inventory.tokens > 0);
    assert.equal(store.data.paper.closed.length, 0);
    quoteAvailable = true;
    await run();
    assert.equal(Object.keys(store.data.paper.open).length, 0);
    assert.equal(store.data.paper.closed.length, 1);
    assert.ok(store.data.paper.closed[0].pnl < 0);
    assert.equal(messages.length, 1);
  } finally {
    stop();
    config.standalone.shadow = before;
  }
});
