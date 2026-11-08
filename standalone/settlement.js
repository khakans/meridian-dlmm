import { config } from '../config.js';
import { modeDatabase } from './database.js';
import { readRpc } from './rpc.js';
import { netWalletSol, reconcilePositionWrites } from './position-journal.js';
import { PublicKey } from '@solana/web3.js';
import { getWalletBalances, quoteTokenToSol, swapToken } from '../tools/wallet.js';

const active = new Set(['closing', 'awaiting_balance', 'awaiting_quote', 'submitted']);
export const settlementRows = () => Object.values(modeDatabase().get('settlements', {}));

function save(row) {
  const db = modeDatabase();
  db.transaction(() => {
    const rows = db.get('settlements', {});
    rows[row.id] = row;
    db.put('settlements', rows);
    db.append('settlement', `${row.id}:${row.updatedAt}:${row.status}`, row.updatedAt, row);
    if (row.status === 'awaiting_balance' && row.closedAt) {
      db.append('live-close-recovered', row.id, row.closedAt, {
        position: row.id, pool: row.pool, pool_name: row.pool_name, base_mint: row.mint,
        deployed_at: row.deployed_at, close_txs: row.txs, close_reason: row.reason,
      });
    }
    if (row.status === 'swapped' || row.status === 'no_balance') {
      db.append('live-settlement', row.id, row.updatedAt, row, row.netSol);
    }
  });
  return row;
}

function update(row, status, fields = {}) {
  return save({ ...row, ...fields, status, updatedAt: Date.now() });
}

export function beginSettlement({ id, mint, wallet, baseline, pool, pool_name, deployed_at, reason }) {
  const prior = settlementRows().find(r => r.id === id);
  if (prior) return prior;
  if (baseline == null) throw Error('Wallet token baseline unavailable before close');
  return update({ id, mint, wallet, baseline, pool, pool_name, deployed_at, reason, tries: 0, nextAt: 0 }, 'closing');
}

export function confirmPositionClosed(id, txs) {
  const row = settlementRows().find(item => item.id === id);
  if (row?.status !== 'closing') return row;
  return update(row, 'awaiting_balance', { txs, nextAt: 0, closedAt: Date.now() });
}

export function tokenDelta(meta, mint, owner) {
  if (!Array.isArray(meta?.preTokenBalances) || !Array.isArray(meta?.postTokenBalances) || meta.err) return null;
  if ([...meta.preTokenBalances, ...meta.postTokenBalances].some(t => t.mint === mint && !t.owner)) return null;
  const sum = list => list.filter(t => t.mint === mint && t.owner === owner)
    .reduce((n, t) => n + BigInt(t.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

const readTransaction = signature => readRpc('monitor', c => c.getTransaction(signature,
  { maxSupportedTransactionVersion: 0, commitment: 'finalized' }));

async function finalizeSettlement(row, status) {
  const journal = await reconcilePositionWrites(row.id);
  const entry = journal.filter(item => item.stage === 'entry' && item.status === 'confirmed');
  const close = [...new Set([...(row.txs ?? []),
    ...journal.filter(item => item.stage === 'close' && item.status === 'confirmed').map(item => item.signature)])];
  const failed = journal.filter(item => item.status === 'failed').map(item => item.signature);
  const signatureList = [...new Set([...entry.map(item => item.signature), ...close, ...failed, ...(row.failedSwapSignatures ?? []),
    ...(status === 'swapped' ? [row.signature] : [])])];
  const txs = await Promise.all(signatureList.map(readTransaction));
  if (txs.some(tx => !tx?.meta)) return update(row, row.status, { nextAt: Date.now() + 30_000 });
  const netSol = entry.length && close.length ? netWalletSol(txs, row.wallet) : null;
  return update(row, status, { netSol, netSolSource: netSol == null ? 'entry or wallet metadata unavailable' : 'wallet transaction deltas' });
}

export async function advanceSettlement(row) {
  if (config.standalone.shadow || process.env.DRY_RUN === 'true' || !active.has(row.status)) return row;
  if (row.status === 'closing') {
    const journal = await reconcilePositionWrites(row.id);
    if (journal.some(item => item.status === 'pending')) {
      return update(row, 'closing', { retryClose: false, nextAt: Date.now() + 15_000 });
    }
    const account = await readRpc('monitor', c => c.getAccountInfo(new PublicKey(row.id), 'finalized'));
    const close = journal.filter(item => item.stage === 'close' && item.status === 'confirmed');
    if (account) {
      const stillOpen = await readRpc('monitor', c => c.getAccountInfo(new PublicKey(row.id), 'confirmed'));
      return update(row, 'closing', { retryClose: Boolean(stillOpen), nextAt: Date.now() + 30_000 });
    }
    if (!close.length) return update(row, 'review_required', { reason: 'account closed without journaled transaction' });
    return confirmPositionClosed(row.id, close.map(item => item.signature));
  }
  if (row.status === 'submitted') {
    if (!row.signature) return update(row, 'review_required');
    const status = await readRpc('monitor', c => c.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).catch(() => null);
    const sig = status?.value[0];
    const retrySwap = failed => update(row, 'awaiting_quote', { signature: null, nextAt: Date.now() + 60_000,
      failedSwapSignatures: failed ? [...(row.failedSwapSignatures ?? []), row.signature] : row.failedSwapSignatures });
    if (sig?.err && sig.confirmationStatus === 'finalized') return retrySwap(true);
    if (!sig?.err && ['confirmed', 'finalized'].includes(sig?.confirmationStatus)) return finalizeSettlement(row, 'swapped');
    if (status && !sig && Number.isSafeInteger(row.lastValidBlockHeight)) {
      const height = await readRpc('monitor', c => c.getBlockHeight('finalized'));
      if (height > row.lastValidBlockHeight) {
        const tx = await readTransaction(row.signature);
        if (!tx || tx.meta?.err) return retrySwap(Boolean(tx?.meta?.err));
        if (tx.meta) return finalizeSettlement(row, 'swapped');
      }
    }
    return update(row, 'submitted', { nextAt: Date.now() + 30_000 });
  }
  const attempts = row.tries + 1;
  const retry = (status, reason, delay = 60_000) => update(row, status, { tries: attempts, reason, nextAt: Date.now() + delay });
  let prepared = null;
  try {
    if (row.raw == null) {
      let delta = 0n;
      if (!row.txs?.length || row.baseline == null || !row.wallet) return update(row, 'review_required');
      const journal = await reconcilePositionWrites(row.id);
      const close = journal.filter(item => item.stage === 'close' && item.status === 'confirmed');
      for (const sig of new Set([...row.txs, ...close.map(item => item.signature)])) {
        const tx = await readTransaction(sig);
        const part = tokenDelta(tx?.meta, row.mint, row.wallet);
        if (part == null) return retry('awaiting_balance', 'close metadata pending');
        delta += part;
      }
      if (delta <= 0n) return finalizeSettlement(row, 'no_balance');
      row = update(row, 'awaiting_quote', { raw: String(delta) });
    }
    const balance = await getWalletBalances({ force: true });
    if (balance.error || balance.wallet !== row.wallet) return retry('awaiting_balance', 'wallet read unavailable');
    const token = balance.tokens.find(t => t.mint === row.mint);
    const surplus = BigInt(token?.raw_balance ?? 0) - BigInt(row.baseline);
    if (surplus < BigInt(row.raw) || !token) return retry('awaiting_balance', 'withdrawn tokens unavailable');
    // Check the exact amount attributable to the close before preparing a swap.
    const minimumOut = await quoteTokenToSol(row.mint, row.raw);
    const result = await swapToken({ input_mint: row.mint, output_mint: 'SOL',
      amount: Number(row.raw) / 10 ** token.decimals, raw_amount: row.raw, minimumOut,
      beforeExecute: (signature, lastValidBlockHeight) => {
        if (!signature) throw Error('Swap signature unavailable before submit');
        prepared = update(row, 'submitted', { signature, lastValidBlockHeight, tries: attempts });
      } });
    if (result.success && result.tx && result.tx === prepared?.signature) {
      return update(prepared, 'submitted', { outputLamports: result.amount_out });
    }
    if (prepared) return prepared; // Resolve signature before any second submission.
    const status = Number(/\b(400|429)\b/.exec(result.error ?? '')?.[1]);
    return retry('awaiting_quote', status === 429 ? 'rate limited' : status === 400 ? 'route unavailable' : 'swap preparation failed', status === 429 ? 120_000 : 60_000);
  } catch (error) {
    if (prepared) return prepared;
    const status = Number(/\b(400|429)\b/.exec(error.message)?.[1]);
    return retry(row.raw ? 'awaiting_quote' : 'awaiting_balance',
      status === 429 ? 'rate limited' : status === 400 ? 'route unavailable' : 'provider unavailable',
      status === 429 ? 120_000 : 60_000);
  }
}

export const dueSettlements = () => settlementRows().filter(r => active.has(r.status) && r.nextAt <= Date.now())
  .sort((a,b) => a.nextAt - b.nextAt);
