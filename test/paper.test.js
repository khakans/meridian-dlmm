import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config.js';
import { paperBins, paperCloseRule, paperInventory, startPaper } from '../standalone/paper.js';

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

test('quote-only bins convert inventory as price crosses and support absolute Fib ranges', () => {
  const active = { binId: 100, price: 1 };
  const range = paperBins({ range: 'volatility', binsBelow: 35 }, active, 100);
  assert.deepEqual(range, { lower: 65, upper: 99, ratio: 1.01 });
  const position = { ...range, shape: 'spot', capital: 1, entryBin: 100, entryPrice: 1 };
  assert.deepEqual(paperInventory(position, 100), { sol: 1, tokens: 0 });
  assert.ok(paperInventory(position, 80).sol < 1);
  assert.equal(paperInventory(position, 64).sol, 0);
  assert.ok(paperInventory(position, 64).tokens > 1);
  assert.equal(paperBins({ range: 'fibonacci', lower: 0.5, upper: 1.2 }, active, 100), null);
  assert.ok(paperBins({ range: 'fibonacci', lower: 0.5, upper: 0.8 }, active, 100).upper < 100);
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
