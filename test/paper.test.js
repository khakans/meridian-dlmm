import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { config } from '../config.js';
import { mirrorExitReason, paperBins, paperCloseRule, paperInventory, prepareMirrorPosition, startPaper } from '../standalone/paper.js';
import { markPaperBins, recommendPaperVariant, seedPaperBins } from '../standalone/paper-accounting.js';
import { paperPnlLines, paperRealizedLine, summarizePaper } from '../standalone/pnl-summary.js';
import { lowerRangeStop } from '../exit-rules.js';
import { entryCreatedTokenAccounts, settlementComplete, tokenDelta } from '../standalone/settlement.js';
import { meetsSettlementMinimum } from '../tools/wallet.js';
import { positionsPage } from '../standalone/positions-view.js';
import { estimateNetExitPct, isRetryableEntryError, netWalletSol, positionWrites, reconcilePositionWrites, sendPositionWrite, simulateLegacy } from '../standalone/position-journal.js';
import { DLMM_PROGRAM, recoverablePositionRent } from '../standalone/events.js';

test('settlement only attributes the closed mint balance change to the specified wallet', () => {
  const token = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount } });
  const meta = { preTokenBalances: [token('wallet', 'mint', '100')],
    postTokenBalances: [token('wallet', 'mint', '160'), token('other', 'mint', '999'), token('wallet', 'other', '42')] };
  assert.equal(tokenDelta(meta, 'mint', 'wallet'), 60n);
  assert.equal(tokenDelta({ ...meta, postTokenBalances: [token(undefined, 'mint', '160')] }, 'mint', 'wallet'), null);
});

test('hard lower-range stop measures price beyond the lower bin, not position PnL', () => {
  assert.equal(lowerRangeStop(100, 100, 100, 2), null);
  assert.equal(lowerRangeStop(98, 100, 100, 2), null);
  assert.match(lowerRangeStop(97, 100, 100, 2), /2\.94% below lower bound/);
  assert.equal(lowerRangeStop(97, null, 100, 2), null);
});
import { emptyMonitor, openModeDatabase } from '../standalone/database.js';

test('settlement only considers new token accounts from the matching entry wallet and mint', () => {
  const tx = { transaction: { message: { staticAccountKeys: ['wallet', 'new', 'existing', 'other'] } },
    meta: { preBalances: [10, 0, 5, 0], postBalances: [5, 5, 5, 5],
      postTokenBalances: [{ owner: 'wallet', mint: 'mint', accountIndex: 1 },
        { owner: 'wallet', mint: 'mint', accountIndex: 2 }, { owner: 'other', mint: 'mint', accountIndex: 3 }] } };
  assert.deepEqual(entryCreatedTokenAccounts([tx], 'mint', 'wallet'), ['new']);
  assert.deepEqual(entryCreatedTokenAccounts([tx], 'different', 'wallet'), []);
});

test('positive gross SOL return can become negative after known entry overhead', () => {
  assert.ok(estimateNetExitPct(0.2, 0.18, 0.0015) < 0);
  assert.ok(estimateNetExitPct(2, 0.18, 0.0015) > 0);
  assert.equal(estimateNetExitPct(2, 0.18, null), null);
});

test('LP rent only counts a valid position owned by the trading wallet', async () => {
  const positions = [{ position: Keypair.generate().publicKey.toBase58(), pool: 'pool' }];
  const rpc = (_, fn) => fn({ getMultipleAccountsInfo: async () => [
    { owner: DLMM_PROGRAM, lamports: 41_899_840, data: Buffer.alloc(0) },
  ] });
  const coder = owner => async () => ({ accounts: { decode: () => ({ owner, lbPair: 'pool' }) } });
  assert.equal(await recoverablePositionRent(positions, 'wallet', rpc, coder('wallet')), 0.04189984);
  await assert.rejects(recoverablePositionRent(positions, 'wallet', rpc, coder('another')), /ownership mismatch/);
  await assert.rejects(recoverablePositionRent([...positions, ...positions], 'wallet', rpc, coder('wallet')), /Duplicate/);
});

test('temporary entry failures are separated from unrelated and post-submit failures', () => {
  assert.equal(isRetryableEntryError('Transaction simulation rejected: {"InstructionError":[6,{"Custom":6004}]}'), true);
  assert.equal(isRetryableEntryError('Transaction simulation rejected: "BlockhashNotFound"'), true);
  assert.equal(isRetryableEntryError('Active bin changed before entry'), true);
  assert.equal(isRetryableEntryError('Transaction failed on-chain; reconciling final status'), false);
  assert.equal(isRetryableEntryError('Transaction simulation rejected: {"InstructionError":[6,{"Custom":6005}]}'), false);
});

test('settlement bounds executable slippage and treats recorded dust as complete', () => {
  const order = { inputMint: 'token', outputMint: 'sol', inAmount: '6052117', outAmount: '52524',
    otherAmountThreshold: '51998' };
  const minimum = 52506 * 0.99 / 1e9;
  assert.equal(meetsSettlementMinimum(order, 'token', 'sol', '6052117', minimum), true);
  assert.equal(meetsSettlementMinimum({ ...order, otherAmountThreshold: '51121' }, 'token', 'sol', '6052117', minimum), false);
  assert.equal(meetsSettlementMinimum({ ...order, inAmount: '1' }, 'token', 'sol', '6052117', minimum), false);
  assert.equal(settlementComplete({ status: 'dust_remaining' }), true);
  assert.equal(settlementComplete({ status: 'awaiting_quote' }), false);
});

test('position signature survives a timeout and can be reconciled after reopening SQLite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-journal-'));
  let db = openModeDatabase('live', dir);
  const previous = process.env.DRY_RUN;
  process.env.DRY_RUN = 'false';
  try {
    const payer = Keypair.generate();
    const position = Keypair.generate().publicKey;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: position, lamports: 1 }));
    const blockhash = Keypair.generate().publicKey.toBase58();
    const freshBlockhash = Keypair.generate().publicKey.toBase58();
    let refreshes = 0;
    let expire = false;
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: expire && ++refreshes > 1 ? freshBlockhash : blockhash, lastValidBlockHeight: 100 }),
      simulateTransaction: async (candidate, options) => {
        assert.equal(options.sigVerify, false);
        assert.ok(candidate.signatures.every(sig => sig.every(byte => byte === 0)));
        return { value: { err: expire && candidate.message.recentBlockhash === blockhash ? 'BlockhashNotFound' : null } };
      },
      sendRawTransaction: async () => {
        assert.equal(positionWrites(position, db)[0].status, 'pending');
        throw Error('timeout after send');
      },
    };
    assert.equal((await simulateLegacy(connection, tx, payer.publicKey, blockhash)).err, null);
    await assert.rejects(sendPositionWrite(connection, tx, [payer], position, 'entry', db,
      () => { throw Error('entry stopped'); }), /entry stopped/);
    assert.deepEqual(positionWrites(position, db), []);
    expire = true;
    await assert.rejects(sendPositionWrite(connection, tx, [payer], position, 'entry', db), /timeout after send/);
    assert.equal(refreshes, 2);
    assert.equal(positionWrites(position, db)[0].blockhash, freshBlockhash);
    db.db.close();
    db = openModeDatabase('live', dir);
    const signature = positionWrites(position, db)[0].signature;
    const rpc = (_, fn) => fn({
      getSignatureStatuses: async ([value]) => {
        assert.equal(value, signature);
        return { value: [null] };
      },
      getBlockHeight: async () => 101,
      getTransaction: async value => {
        assert.equal(value, signature);
        return { meta: { err: null } };
      },
    });
    assert.equal((await reconcilePositionWrites(position, db, rpc))[0].status, 'confirmed');
  } finally {
    if (previous == null) delete process.env.DRY_RUN; else process.env.DRY_RUN = previous;
    db.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settlement net SOL includes wallet cash changes and failed transaction fees', () => {
  const tx = (pre, post, err = null) => ({ transaction: { message: { staticAccountKeys: ['wallet', 'other'] } },
    meta: { preBalances: [pre, 500], postBalances: [post, 500], err } });
  assert.equal(netWalletSol([
    tx(1_000_000_000, 799_995_000), tx(799_995_000, 949_990_000),
    tx(949_990_000, 949_985_000, 'failed swap'), tx(949_985_000, 1_019_980_000),
  ], 'wallet'), 0.01998);
  assert.equal(netWalletSol([tx(100, 200), null], 'wallet'), null);
});

test('Shadow All includes historical bankrolls while Mirror reports separately', () => {
  const closed = [
    { variant: 'discovery/volatility/spot', closedAt: 200, pnl: 0.7, accountingVersion: 1 },
    { variant: 'discovery/volatility/mirror', closedAt: 250, pnl: 0.004, accountingVersion: 1, mirror: true },
  ];
  assert.equal(paperRealizedLine(summarizePaper({ closed }, 100, 300), 'All'), 'PnL Shadow (All) · terealisasi +0.7040 SOL');
  assert.equal(paperPnlLines(summarizePaper({ closed: closed.filter(p => p.mirror) }, 100, 300), false,
    'discovery/volatility/mirror', 'Mirror')[0], 'PnL Shadow (Mirror) · terealisasi +0.0040 SOL');
  assert.equal(paperRealizedLine(summarizePaper({ closed }, 225, 300), 'All'), 'PnL Shadow (All) · terealisasi +0.0040 SOL');
});

test('Convergence baseline distinguishes no positions, missing valuation, and measured zero', () => {
  const line = variants => paperPnlLines({ variants }, false)[1];
  assert.match(line([]), /Convergence baseline.*terbuka 0 posisi · terealisasi belum ada posisi selesai/);
  const group = { variant: 'convergence/baseline', open: 1, marked: 0 };
  assert.match(line([group]), /menunggu valuasi \(1 posisi\)/);
  assert.match(line([{ ...group, marked: 1, openPnl: 0, closed: 1, realized: 0 }]), /terbuka \+0\.0000 SOL · terealisasi \+0\.0000 SOL/);
});

test('mirror uses the planned on-chain range and replay yields the same confirmed exits', () => {
  const now = Date.UTC(2026, 10, 8);
  const bins = new Map(Array.from({ length: 36 }, (_, i) => [65 + i, {
    supply: 0n, xAmount: 0n, yAmount: 0n, pricePerToken: 1,
    feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: 0n,
  }]));
  const model = prepareMirrorPosition({ source: 'discovery', mint: 'mint', pool: 'pool', shape: 'spot',
    capital: 0.2, decimals: 6, binStep: 100, binsBelow: 35, entry: { binId: 100, price: 1, bins } }, now);
  assert.deepEqual([model.lower, model.upper, model.entryBin, model.filledAt], [65, 100, 100, now]);
  assert.equal(model.rangeReached, true);
  assert.equal(model.mark.pnl, -config.research.mirrorRoundTripCostSol);
  const live = { id: 'live', openedAt: now, lower: 65, upper: 100, rangeReached: true };
  const marks = Array.from({ length: Math.max(1, config.pnl.confirmTicks) }, (_, i) => ({
    binId: 95, pnl: config.management.takeProfitPct + 1, at: now + i * 60_000,
  }));
  const replay = position => marks.map(({ binId, pnl, at }) => mirrorExitReason(position, { binId }, pnl, at));
  const paperDecisions = replay(model);
  assert.deepEqual(paperDecisions, replay(live));
  assert.equal(paperDecisions.at(-1), 'take profit');
});

test('position pages preserve mode separation, history past a reset, and unknown PnL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-positions-'));
  const shadow = openModeDatabase('shadow', dir);
  const live = openModeDatabase('live', dir);
  try {
    const now = Date.UTC(2026, 10, 8);
    const paper = { variant: 'discovery/volatility/spot', pair: 'MEME/SOL', capital: 0.1,
      openedAt: now - 600_000, closedAt: now - 300_000, pnl: 0.025, accountingVersion: 1 };
    for (let i = 0; i < 3; i++) shadow.append('paper-close', i, paper.closedAt + i, paper);
    shadow.append('paper-close', 'retired', now, { ...paper, variant: 'discovery/fibonacci/spot' });
    live.append('live-close', 'priced', now - 60_000, { position: 'priced', pool_name: 'LIVE/SOL', pnl_usd: 3 });
    live.append('decision', 'duplicate', now, { type: 'close', position: 'priced' });
    live.append('decision', 'unknown', now, { type: 'close', position: 'unknown', pool_name: 'OTHER/SOL' });
    const data = { pnlResetAt: { shadow: now }, paper: { open: { stale: { ...paper, mark: { at: now - 181_000, pnl: 0.08 } } } } };
    const view = (database, tab, page = 0) => positionsPage({
      store: { database, data }, tab, page, now, getSettlements: () => [],
      readBook: async () => ({ error: 'offline' }),
    });
    const lastMark = await view(shadow, 'open');
    assert.match(lastMark.text, /PnL terbuka \+0\.0800 SOL/);
    assert.match(lastMark.text, /nilai terakhir, belum diperbarui/);
    data.paper.open.stale.indicativeMark = { at: now, pnl: 0.01 };
    const indicative = await view(shadow, 'open');
    assert.match(indicative.text, /PnL terbuka \+0\.0100 SOL/);
    assert.match(indicative.text, /estimasi harga bin, tanpa quote jual/);
    const history = await view(shadow, 'closed', 1);
    assert.match(history.text, /3 posisi · Halaman 2\/2/);
    assert.match(history.text, /MEME\/SOL.*\n.*\+0\.0250 SOL.*\+25\.00%/);
    assert.match(history.text, /WIB/);
    const liveHistory = await view(live, 'closed');
    assert.match(liveHistory.text, /2 posisi/);
    assert.match(liveHistory.text, /OTHER\/SOL\nPnL LP sebelum settlement —/);
    assert.match(liveHistory.text, /LIVE\/SOL\nPnL LP sebelum settlement \+3\.00 USD/);
    assert.doesNotMatch(liveHistory.text, /SHADOW|MEME/);
    assert.match((await view(live, 'open')).text, /on-chain belum tersedia/);
  } finally {
    shadow.db.close();
    live.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('paper entry checks exit quote and manual close persists while settlement is unavailable', async () => {
  const before = config.standalone.shadow;
  const previousLowerStop = config.management.outOfRangeBelowStopPct;
  config.standalone.shadow = true;
  config.management.outOfRangeBelowStopPct = 0;
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
    quoteAvailable = false;
    const lastMark = position.mark;
    await run();
    assert.equal(position.mark, lastMark);
    assert.equal(position.markIssue, 'Quote jual belum tersedia');
    assert.ok(Number.isFinite(position.indicativeMark?.pnl));
    position.manualExit = 'manual force close';
    await run();
    assert.ok(position.exit?.inventory.tokens > 0);
    assert.equal(position.exit.reason, 'manual force close');
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
    config.management.outOfRangeBelowStopPct = previousLowerStop;
  }
});
