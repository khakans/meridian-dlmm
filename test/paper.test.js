import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { config } from '../config.js';
import { entryRange, mirrorExitReason, paperBins, paperCloseRule, paperInventory, prepareMirrorPosition, prepareShapeTrials, startPaper } from '../standalone/paper.js';
import { markPaperBins, recommendPaperVariant, seedPaperBins } from '../standalone/paper-accounting.js';
import { longRunLines, paperPnlLines, paperRealizedLine, shapeTrialLines, summarizePaper, tokenRunnerLines } from '../standalone/pnl-summary.js';
import { chooseEntryPair, chooseEntryShape, pairModeLabel, resolveEntryShape, scoreShadowScreen, shapeLabel } from '../standalone/entry-plans.js';
import { assessRebalance, prepareRebalanceTrial, rebalanceDue, REBALANCE_CHECK_MS } from '../standalone/paper-rebalance.js';
import { prepareEntrySpot, prepareTokenRunner, sampleTokenRunner } from '../standalone/paper-token-runner.js';
import { applyHoldCheck, canEnrollLongRun, holdEvidence, longRunSpotReady, longRunState, observeHold, prepareLongHold, updateLongRun } from '../standalone/paper-long-run.js';
import { WalletMonitor } from '../standalone/monitor.js';
import { lowerRangeStop } from '../exit-rules.js';
import { entryCreatedTokenAccounts, settlementCashCosts, settlementComplete, tokenDelta } from '../standalone/settlement.js';
import { meetsSettlementMinimum } from '../tools/wallet.js';
import { positionsPage, readLiveReportBook } from '../standalone/positions-view.js';
import { estimateNetExitPct, isRetryableEntryError, netWalletSol, positionWrites, reconcilePositionWrites, sendPositionWrite, simulateLegacy } from '../standalone/position-journal.js';
import { DLMM_PROGRAM, recoverablePositionRent } from '../standalone/events.js';
import { recentSignalCounts } from '../standalone/store.js';

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

test('auto shape distinguishes calm, wide, mixed and unsafe pair conditions', async () => {
  const now = 1_794_200_400;
  const price = bin => 1.01 ** bin;
  const data = (closes, volumes = closes.map(() => 1000)) => closes.map((c, i) => {
    const open = price(closes[i - 1] ?? 0), close = price(c);
    return { timestamp: now - (6 - i) * 300, open, close,
      high: Math.max(open, close) * 1.001, low: Math.min(open, close) / 1.001, volume: volumes[i] };
  });
  const options = { now, binStep: 100, binsBelow: 40, price: 1,
    feeRatio: 0.2, minFeeRatio: 0.05, exitRatio: 0.99, minExitRatio: 0.97 };
  assert.equal(chooseEntryShape(data([2, 0, 2, 0, 2, 0]), options).shape, 'curve');
  const wide = data([8, -3, 8, -3, -2, 0]);
  assert.equal(chooseEntryShape(wide, options).shape, 'bid_ask');
  assert.equal(chooseEntryShape(wide, { ...options, exitRatio: 0.975 }).shape, 'spot');
  assert.equal(chooseEntryShape(data([1, 2, 3, 4, 5, 6]), { ...options, price: price(6) }).shape, 'spot');
  assert.match(chooseEntryShape(data([0, -1, -2, -4, -6, -8]), options).reason, /turun tajam/);
  assert.match(chooseEntryShape(data([1, 0, 1, 0, 1, 0], [1000, 1000, 1000, 10, 10, 10]), options).reason, /volume/);
  assert.equal(chooseEntryShape(wide, { ...options, price: price(-5) }).shape, null);
  assert.equal(chooseEntryShape(wide, { ...options, now: now + 900 }).shape, null);
  assert.equal(chooseEntryShape(wide.slice(1), options).shape, null);
  assert.equal(chooseEntryShape(wide, { ...options, exitRatio: 0.96 }).shape, null);
  assert.deepEqual(await resolveEntryShape('spot'), { shape: 'spot', reason: 'manual' });
});

test('Pair Mode picks each funded side, rejects unsafe Auto signals and preserves the manual routes', () => {
  const now = 1_794_200_400;
  const price = bin => 1.01 ** bin;
  const candles = (values, volume = 1000) => values.map((bin, i) => {
    const open = price(values[i - 1] ?? 0), close = price(bin);
    return { timestamp: now - (6 - i) * 300, open, close,
      high: Math.max(open, close) * 1.001, low: Math.min(open, close) / 1.001,
      volume: i < 3 ? 1000 : volume };
  });
  const plan = (data, bin = 0, time = now) => chooseEntryPair('auto', data, { now: time, price: price(bin), binStep: 100 });
  const calm = candles([1, 0, 1, 0, 1, 0]);
  const dual = plan(calm);
  const single = plan(candles([4, 0, 5, 1, 5, 3]), 3);
  assert.equal(dual.side, 'dual');
  assert.equal(single.side, 'single');
  assert.equal(pairModeLabel('auto', dual.side), 'Auto (Dual)');
  assert.deepEqual(entryRange(55, 35, dual.side === 'dual'), { binsBelow: 35, binsAbove: 20 });
  assert.deepEqual(entryRange(55, 35, single.side === 'dual'), { binsBelow: 55, binsAbove: 0 });
  assert.match(plan(calm, -2).reason, /menembus support/);
  assert.match(plan(candles([0, -1, -2, -4, -6, -8]), -8).reason, /turun tajam/);
  assert.match(plan(candles([1, 0, 1, 0, 1, 0], 10)).reason, /volume/);
  for (const incomplete of [plan(calm.slice(1)), plan(calm, 0, now + 900), plan(null)]) {
    assert.equal(incomplete.side, null);
  }
  assert.deepEqual(chooseEntryPair('single'), { side: 'single', reason: 'manual' });
  assert.deepEqual(chooseEntryPair('dual'), { side: 'dual', reason: 'manual' });
});

test('auto rebalance needs three checks, sufficient observed fees and a 30 minute cooldown', () => {
  const q = 1n << 64n, openedAt = 1_800_000_000_000, interval = REBALANCE_CHECK_MS;
  const snapshot = (a, b) => new Map([a, b, 0n].map((fee, i) => [i + 1, {
    supply: 10_000_000_000n * q, yAmount: 10_000_000_000n, xAmount: 0n, pricePerToken: 1,
    feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: fee,
  }]));
  const mirror = { id: 'mirror', lower: 1, upper: 3, shape: 'spot', shapeMode: 'auto', capital: 0.30, decimals: 6,
    openedAt, costSol: 0.001, mirror: true };
  mirror.binSeed = seedPaperBins(mirror, snapshot(0n, 0n));
  const trial = prepareRebalanceTrial(mirror);
  const assess = (n, bins, shape = 'curve') => assessRebalance(trial, {
    now: openedAt + n * interval, active: { binId: 3 }, bins, plan: { shape, reason: 'test' }, quotePrice: 1,
  });
  assert.equal(assess(0.99, snapshot(0n, 0n)), false);
  assert.equal(assess(1, snapshot(0n, 0n)), false);
  assert.equal(assess(2, snapshot(0n, 0n)), false);
  assert.equal(assess(3, snapshot(0n, 0n)), false);
  assert.equal(trial.costSol, 0.001);
  assert.equal(assess(5, snapshot(0n, 0n)), false);
  assert.equal(trial.rebalanceCheck.checks, 1);
  assert.equal(assess(6, snapshot(0n, q / 100n)), false);
  trial.exitSignal = 'take profit';
  const bins = snapshot(0n, q / 50n);
  assert.equal(assess(7, bins), false);
  delete trial.exitSignal;
  assert.equal(assess(7, bins), true);
  assert.equal(shapeLabel(trial.shape, trial.shapeMode, trial.rebalances), 'Auto (Spot → Curve)');
  assert.equal(shapeLabel(mirror.shape, mirror.shapeMode), 'Auto (Spot)');
  assert.equal(shapeLabel('spot'), 'Spot');
  const before = markPaperBins(mirror, 3, bins);
  const after = markPaperBins(trial, 3, bins);
  assert.ok(Math.abs(before.sol - after.sol - trial.rebalanceIdleSol) < 1e-9);
  assert.equal(before.feeSol, after.feeSol + trial.rebalanceFeeSol);
  assert.equal(before.tokens, after.tokens);
  assert.equal(trial.costSol, 0.0011);
  assert.equal(rebalanceDue(trial, openedAt + 17 * interval - 1), false);
  assert.equal(rebalanceDue(trial, openedAt + 17 * interval), true);
});

test('Shadow screening requires two completed 5 minute candles and a fee estimate', () => {
  const now = 1_794_200_400;
  const candles = [{ timestamp: now - 600, volume: 500 }, { timestamp: now - 300, volume: 600 },
    { timestamp: now, volume: 10 }];
  assert.equal(scoreShadowScreen(candles, { fee_active_tvl_ratio: 0.31 }, 0.10, now).status, 'pass');
  assert.equal(scoreShadowScreen(candles, { fee_active_tvl_ratio: 0.29 }, 0.10, now).status, 'reject');
  assert.equal(scoreShadowScreen(candles.slice(1), { fee_active_tvl_ratio: 0.31 }, 0.10, now).status, 'missing');
  assert.equal(scoreShadowScreen(candles, { fee_active_tvl_ratio: null }, 0.10, now).status, 'missing');
});

function risingCandles(now) {
  const end = Math.floor(now / 300_000) * 300;
  return [1, 1.1, 1.2, 1.3].map((close, i) => ({
    timestamp: end - (4 - i) * 300, close, low: close * 0.98, volume: 100 + i * 10,
  }));
}

test('Shadow token runner compares a profitable LP exit to the same-size full sell', async () => {
  const now = 1_800_000_000_000;
  const p = { id: 'mirror', pool: 'pool', mint: 'mint', mirror: true, exit: { reason: 'take profit' } };
  const args = { now, raw: 1000, sol: 0.02, fullQuote: 0.10, pnl: 0.02,
    quote: async (_mint, raw) => raw * 0.0001, candles: async () => risingCandles(now) };
  assert.equal(await prepareTokenRunner(p, { ...args, sol: 0.11 }), null);
  assert.equal(await prepareTokenRunner(p, { ...args, pnl: 0 }), null);
  assert.equal(await prepareTokenRunner({ ...p, exit: { reason: 'stop loss' } }, args), null);
  assert.equal(await prepareTokenRunner(p, { ...args, candles: async () => risingCandles(now).slice(1) }), null);
  const row = await prepareTokenRunner(p, args);
  assert.equal(row.raw, 180);
  assert.ok(Math.abs(row.initialQuote - 0.018) < 1e-9);
  const run = (r, value, at, candles = args.candles) => sampleTokenRunner(r, { now: at, quote: async () => value, candles });
  const { next: peak } = await run(row, 0.03, now + 15_000);
  assert.equal(peak.peak, 0.03);
  const { closed } = await run(peak, 0.027, now + 30_000);
  assert.equal(closed.reason, 'trailing 10%');
  assert.ok(Math.abs(closed.deltaSol - 0.00897) < 1e-9);
  assert.ok(Math.abs(closed.pnl - 0.02897) < 1e-9);

  const outage = await run(peak, null, row.expiresAt);
  assert.equal(outage.next.reason, 'batas waktu');
  assert.equal(outage.alert, true);
  assert.equal((await run(outage.next, null, row.expiresAt + 15_000)).alert, false);
  const recovered = await run(outage.next, 0.024, row.expiresAt + 30_000);
  assert.equal(recovered.closed.reason, 'batas waktu');
  assert.equal(recovered.closed.quote, 0.024);
  const structure = await run(row, 0.019, now + 300_000, async () => {
    const next = [...risingCandles(now).slice(1), { timestamp: now / 1000, close: 1.05, low: 1.01, volume: 130 }];
    return next;
  });
  assert.equal(structure.closed.reason, 'swing low 5 menit ditembus');
  const report = tokenRunnerLines({ tokenRunners: { open: { mirror: outage.next }, closed: [closed] } }, now, row.expiresAt, true);
  assert.match(report[0], /1 tunggu quote.*\+0\.0090 SOL vs langsung jual/);
  assert.match(report[1], /0\.00300 SOL/);
  assert.match(report[2], /menunggu quote.*batas waktu/);
});

test('paper lifecycle opens a token runner alongside the original LP result', async () => {
  const now = Date.now();
  const position = { id: 'mirror', mint: 'mint', pool: 'pool', mirror: true, decimals: 0, range: 'volatility',
    variant: 'discovery/volatility/mirror', capital: 0.10, costSol: 0.001, binSeed: [], openedAt: now - 60_000,
    filledAt: now - 60_000, exit: { at: now, reason: 'take profit', inventory: { sol: 0.02, tokens: 1000, feeSol: 0, feeTokens: 0 } } };
  const paper = { open: { mirror: position }, closed: [], realized: { [position.variant]: 0 } };
  let saved;
  const persisted = new Promise(resolve => { saved = resolve; });
  const stop = startPaper({ data: { paper }, save: saved }, () => {}, {
    schedule: () => null, quote: async (_mint, raw) => raw * 0.0001, candles: async () => risingCandles(now),
    admitResearch: false,
  });
  try {
    await persisted;
    assert.equal(paper.closed.length, 1);
    assert.equal(paper.tokenRunners.open.mirror.raw, 180);
    assert.equal(paper.tokenRunners.open.mirror.baselinePnl, paper.closed[0].pnl);
    assert.equal(paper.mirrorRealized, paper.closed[0].pnl);
  } finally { stop(); }
});

test('adaptive hold can renew past six hours and expires on missing or unproductive observations', () => {
  const minute = 60_000, openedAt = 1_800_000_000_000;
  const base = { id: 'lp', openedAt, lower: 1, upper: 20, capital: 0.15 };
  const p = prepareLongHold(base, 'adaptive', 240);
  for (let i = 179; i <= 390; i++) {
    const now = openedAt + i * minute;
    observeHold(p, { now, activeBin: 10, feeSol: i * 0.00001, feeTokens: 0, valued: true });
    if (now < p.longHold.checkAt) continue;
    const evidence = holdEvidence(p, now, 0, 0.002);
    assert.ok(evidence);
    applyHoldCheck(p, now, evidence);
    assert.equal(paperCloseRule(p, { binId: 10 }, 1.3, now), null);
  }
  assert.equal(p.maxHoldMinutes, 420);
  assert.equal(p.longHold.extensions, 6);
  const next = openedAt + 405 * minute;
  observeHold(p, { now: next, activeBin: 10, feeSol: 0, feeTokens: 0, valued: false });
  assert.equal(holdEvidence(p, next, 0, 0.002), null);
  applyHoldCheck(p, next, null);
  assert.equal(paperCloseRule(p, { binId: 10 }, 1.3, next), 'maximum hold time');
  assert.equal(paperCloseRule(p, { binId: 10 }, -100, next), 'stop loss');
  const flat = prepareLongHold(base, 'adaptive', 240);
  for (let i = 180; i <= 240; i++) observeHold(flat, {
    now: openedAt + i * minute, activeBin: i < 204 ? 21 : 10, feeSol: i * 0.00001, feeTokens: 0, valued: true,
  });
  assert.equal(holdEvidence(flat, openedAt + 240 * minute, 0, 0.002), null);
});

test('spot sleeve uses 15% of the same bankroll and requires an executable two-way quote', async () => {
  const now = 1_800_000_000_000;
  const capital = 0.15 * 0.15;
  const p = { id: 'lp:spot', mint: 'mint', pool: 'pool', longRunArm: 'spot' };
  const args = { now, capital, candles: risingCandles(now), minExitRatio: 0.97,
    buy: async (mint, lamports) => { assert.equal(mint, 'mint'); assert.equal(lamports, 22_500_000); return 12345; },
    sell: async (_mint, raw) => { assert.equal(raw, 12345); return 0.022; } };
  assert.equal(await prepareEntrySpot(p, { ...args, sell: async () => 0.020 }), null);
  assert.equal(await prepareEntrySpot(p, { ...args, candles: [] }), null);
  const row = await prepareEntrySpot(p, args);
  const { closed } = await sampleTokenRunner(row, { now: row.expiresAt, quote: async () => 0.025, candles: async () => [] });
  assert.equal(row.fullQuote, 0.0225);
  assert.ok(Math.abs(closed.deltaSol - 0.00244) < 1e-9);
  assert.equal(closed.reason, 'batas waktu');
});

test('Long Run reports wait for both LPs and the spot leg, then unlock phase two after 20 paired closes', () => {
  const now = 1_800_000_000_000, later = now + 60_000;
  const paper = { open: {}, closed: [], tokenRunners: { open: {}, closed: [] } };
  const state = longRunState(paper);
  state.matched = 19;
  const arms = { baseline: { lpId: 'lp' }, adaptive: { lpId: 'lp:adaptive' },
    spot: { lpId: 'lp:spot', entrySpotId: 'spot' } };
  state.open.lp = { id: 'lp', mint: 'mint', capital: 0.15, openedAt: now, arms };
  assert.equal(canEnrollLongRun(paper, 0.15, 1, 1), false);
  assert.equal(canEnrollLongRun(paper, 0.15, 0.20, 2), false);
  paper.closed = [{ id: 'lp', pnl: 0.001, closedAt: later, feeValueSol: 0.002 },
    { id: 'lp:adaptive', pnl: 0.002, closedAt: later, feeValueSol: 0.003, longRunExtensions: 1 },
    { id: 'lp:spot', pnl: 0.0015, closedAt: later, feeValueSol: 0.0025 }];
  updateLongRun(paper, later);
  assert.equal(state.matched, 19);
  assert.equal(longRunSpotReady(state), false);
  paper.tokenRunners.closed.push({ id: 'spot', deltaSol: 0.002, closedAt: later + 10_000 });
  updateLongRun(paper, later + 10_000);
  assert.equal(state.matched, 20);
  assert.equal(state.extended, 1);
  assert.equal(longRunSpotReady(state), true);
  assert.equal(state.closed[0].arms.spot.pnl, 0.0035);
  assert.match(longRunLines(paper, now, true).join('\n'), /LP \+ spot · 1 pembanding · Δ net \+0\.0015 SOL vs adaptif/);
  assert.equal(canEnrollLongRun(paper, 0.15, 1, 1), true);
});

test('settlement costs include failed transaction fees and remove refunded ATA rent', () => {
  const tx = (pre, post, fee, postTokenBalances = []) => ({
    transaction: { message: { staticAccountKeys: ['wallet'] } },
    meta: { loadedAddresses: { writable: ['ata'] }, preBalances: [1e9, pre],
      postBalances: [1e9, post], fee, postTokenBalances },
  });
  const entry = tx(0, 2_000_000, 5000, [{ accountIndex: 1, mint: 'mint', owner: 'wallet' }]);
  const failed = tx(2_000_000, 2_000_000, 5000);
  failed.meta.err = {};
  assert.deepEqual(settlementCashCosts([entry, failed], [entry], 'mint', 'wallet'),
    { networkFeeSol: 0.00001, retainedTokenRentSol: 0.002 });
  assert.deepEqual(settlementCashCosts([entry, failed, tx(2_000_000, 0, 5000)], [entry], 'mint', 'wallet'),
    { networkFeeSol: 0.000015, retainedTokenRentSol: 0 });
});

test('wallet reconciliation batches backfill and filters unrelated live logs', async () => {
  const wallets = Array.from({ length: 5 }, () => ({ address: Keypair.generate().publicKey.toBase58() }));
  const data = emptyMonitor();
  for (const w of wallets) data.wallets[w.address] = { baselineSlot: 1, reconciledAt: 0 };
  const callbacks = [];
  const monitor = new WalletMonitor({ data, save() {} }, { reconcileSec: 30, walletThreshold: 2 },
    { wallets: () => ({ wallets }), rpc: (_kind, call) => call({ getSignaturesForAddress: async () => [] }) });
  monitor.ws = { onLogs: (_key, handler) => callbacks.push(handler) };
  monitor.running = true;
  await monitor.reconcile();
  assert.deepEqual(monitor.coverage(), { total: 5, fresh: 4, stale: 1, errors: 0 });
  assert.equal(monitor.healthy(), false);
  await monitor.reconcile();
  assert.equal(monitor.healthy(), true);
  callbacks[0]({ signature: 'unrelated', logs: ['Program other invoke [1]'] }, { slot: 2 });
  callbacks[0]({ signature: 'lp', logs: [`Program ${DLMM_PROGRAM} invoke [1]`] }, { slot: 2 });
  assert.deepEqual(Object.values(data.pending).map(p => p.signature), ['lp']);
});

test('two-sided mirror keeps both halves in the LP across all three shapes', () => {
  const { binsBelow, binsAbove } = entryRange(55, 35, true);
  assert.deepEqual([binsBelow, binsAbove], [35, 20]);
  assert.deepEqual(entryRange(55, 35, false), { binsBelow: 55, binsAbove: 0 });
  const empty = { supply: 0n, xAmount: 0n, yAmount: 0n, pricePerToken: 1,
    feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: 0n };
  const bins = new Map(Array.from({ length: binsBelow + binsAbove + 1 }, (_, i) => [i - binsBelow, empty]));
  bins.set(0, { ...empty, supply: 1_000_000_000n, yAmount: 1_000_000_000n });
  const input = { source: 'discovery', mint: 'mint', pool: 'pool', shape: 'spot',
    capital: 0.2, decimals: 6, binStep: 100, binsBelow, binsAbove, entry: { binId: 0, price: 1, bins },
    pairEntry: { mode: 'auto', side: 'dual', reason: 'fixture' },
    dualSide: { rawX: '97001', solLamports: 100_000_000 } };
  const model = prepareMirrorPosition(input);
  for (const trial of prepareShapeTrials(input, model)) {
    assert.deepEqual(trial.pairEntry, input.pairEntry);
    assert.equal(trial.binSeed.reduce((n, seed) => n + BigInt(seed.x), 0n), 97001n);
    assert.equal(trial.binSeed.reduce((n, seed) => n + BigInt(seed.y), 0n), 100_000_000n);
    assert.ok(trial.binSeed.every(seed => seed.id <= 0 ? seed.x === '0' : seed.y === '0'));
    const inventory = markPaperBins(trial, 0, bins);
    assert.equal(inventory.sol, 0.1);
    assert.equal(inventory.tokens, 0.097001);
    assert.equal(markPaperBins(trial, 2, bins), null);
  }
});

test('mirror uses the planned on-chain range and replay yields the same confirmed exits', () => {
  const now = Date.UTC(2026, 10, 8);
  const bins = new Map(Array.from({ length: 36 }, (_, i) => [65 + i, {
    supply: 0n, xAmount: 0n, yAmount: 0n, pricePerToken: 1,
    feeAmountXPerTokenStored: 0n, feeAmountYPerTokenStored: 0n,
  }]));
  const input = { source: 'discovery', mint: 'mint', pool: 'pool', shape: 'spot',
    capital: 0.2, decimals: 6, binStep: 100, binsBelow: 35, entry: { binId: 100, price: 1, bins } };
  const model = prepareMirrorPosition(input, now);
  assert.deepEqual([model.lower, model.upper, model.entryBin, model.filledAt], [65, 100, 100, now]);
  assert.equal(model.rangeReached, true);
  assert.equal(model.mark.pnl, -config.research.mirrorRoundTripCostSol);
  const trials = prepareShapeTrials(input, model);
  assert.equal(new Set(trials.map(p => p.id)).size, 3);
  assert.ok(trials.every(p => p.lower === 65 && p.upper === 100 && p.openedAt === now && p.capital === 0.2 && !p.mirror));
  const weight = p => p.binSeed.map(b => Number(b.y));
  const [spot, curve, bidAsk] = trials.map(weight);
  assert.equal(spot[0], spot.at(-1));
  assert.ok(curve[0] < curve.at(-1));
  assert.ok(bidAsk[0] > bidAsk.at(-1));
  const history = trials.map(p => ({ ...p, closedAt: now + 60_000, pnl: 0.001, drawdownPct: 2, observedMs: 60_000, inRangeMs: 30_000 }));
  assert.match(shapeTrialLines(history.slice(1), now)[0], /menunggu/);
  const matched = shapeTrialLines([...history, { ...model, closedAt: now + 60_000, pnl: -0.001 }], now);
  assert.match(matched[0], /1\/20/);
  assert.match(matched[1], /Auto.*net -0\.0010 SOL/);
  assert.match(matched[2], /Spot.*net \+0\.0010 SOL.*2\.0%.*50%/);
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

test('live report includes recent on-chain positions while the index catches up', async () => {
  const now = 1_800_000_000_000;
  const row = (position, ago = 1000) => ({ position, pool: 'pool', pool_name: position + '-SOL',
    deployed_at: new Date(now - ago).toISOString() });
  const indexed = { position: 'indexed', pnl_usd: 2 };
  const tracked = [row('indexed'), row('fresh'), row('pending'), row('closed'), row('old', 600_000)];
  const calls = [];
  const book = await readLiveReportBook(async () => ({ wallet: 'owner', positions: [indexed] }), () => tracked, 'owner', {
    now: () => now,
    verify: async (id, owner, pool) => {
      assert.equal(owner, 'owner');
      assert.equal(pool, 'pool');
      calls.push(id);
      if (id === 'fresh') tracked.push(row('during'));
      if (id === 'pending') throw Error('RPC unavailable');
      if (id === 'closed') tracked.find(p => p.position === id).closed = true;
      return { shares: '10', xMint: 'mint', lower: 10, upper: 20, active: 15, inRange: true };
    },
  });
  assert.deepEqual(calls, ['fresh', 'pending', 'closed', 'during']);
  assert.equal(book.total_positions, 3);
  assert.deepEqual(book.positions.map(p => p.position), ['indexed', 'fresh', 'during']);
  assert.equal(book.positions[0].pnl_usd, 2);
  assert.equal(book.positions[1].awaitingIndex, true);
  assert.equal(book.positions[1].pnl_usd, null);
  assert.deepEqual(book.pendingEntries, [{ position: 'pending', pair: 'pending-SOL' }]);
  const partial = await readLiveReportBook(async () => ({ error: 'index down' }), () => [row('fresh')], 'owner', {
    now: () => now, verify: async () => ({ shares: '10' }),
  });
  assert.equal(partial.error, 'index down');
  assert.equal(partial.positions[0].position, 'fresh');
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
    state.paper.tokenRunners = { open: {}, closed: [{ id: 'paper1', closedAt: 200, pnl: 0.035, deltaSol: 0.005 }] };
    state.paper.longRun = { open: {}, closed: [{ id: 'paper1', closedAt: 210, deltaSol: 0.01 }] };
    shadow.saveMonitor(state);
    shadow.saveMonitor(state);
    shadow.saveMonitor({ ...state, paper: { closed: [] } });
    shadow.db.close();
    shadow = openModeDatabase('shadow', dir);
    assert.equal(shadow.get('monitor').paper.closed.length, 0);
    assert.equal(shadow.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-close'").get().n, 1);
    assert.equal(live.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-close'").get().n, 0);
    assert.deepEqual(shadow.db.prepare("SELECT pnl FROM history WHERE kind='paper-runner-close'").all().map(row => row.pnl), [0.005]);
    assert.equal(live.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-runner-close'").get().n, 0);
    assert.deepEqual(shadow.db.prepare("SELECT pnl FROM history WHERE kind='paper-long-run'").all().map(row => row.pnl), [0.01]);
    assert.equal(live.db.prepare("SELECT count(*) AS n FROM history WHERE kind='paper-long-run'").get().n, 0);
    assert.equal(shadow.db.prepare("SELECT count(*) AS n FROM history WHERE kind='pnl-reset'").get().n, 1);
    assert.equal(live.get('monitor').pnlResetAt.live, 20);
  } finally {
    if (shadow?.db.isOpen) shadow.db.close();
    if (live?.db.isOpen) live.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rolling signal counts include prior same-mint signals and live queue without double-counting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-signals-'));
  const now = 1_800_000_000_000, day = 86_400_000;
  let database;
  try {
    database = openModeDatabase('live', dir);
    const monitor = emptyMonitor();
    const first = { mint: 'mint', source: 'discovery', createdAt: now - 5000, done: true, closedAt: now - 4000 };
    const stale = { mint: 'stale', createdAt: now - day, done: true, closedAt: now - 1000 };
    monitor.signals = { mint: first, stale };
    database.saveMonitor(monitor);
    assert.deepEqual(recentSignalCounts({ database, data: monitor }, now), { discovery: 1, convergence: 0 });
    const second = { mint: 'mint', createdAt: now - 2000, done: false };
    monitor.signals.mint = second;
    database.saveMonitor(monitor);
    database.db.close();
    database = openModeDatabase('live', dir);
    const saved = database.get('monitor');
    assert.deepEqual(recentSignalCounts({ database, data: saved }, now), { discovery: 1, convergence: 1 });
    Object.assign(saved.signals.mint, { done: true, closedAt: now });
    database.saveMonitor(saved);
    assert.deepEqual(recentSignalCounts({ database, data: saved }, now), { discovery: 1, convergence: 1 });
    assert.deepEqual(recentSignalCounts({ database, data: saved }, now + day - 2500), { discovery: 0, convergence: 1 });
  } finally {
    if (database?.db.isOpen) database.db.close();
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
