import { config } from '../config.js';
import { modeDatabase } from './database.js';
import { readRpc } from './rpc.js';
import { getWalletBalances, quoteTokenToSol, swapToken } from '../tools/wallet.js';

const active = new Set(['awaiting_balance', 'awaiting_quote', 'submitted']);
export const settlementRows = () => Object.values(modeDatabase().get('settlements', {}));

function save(row) {
  const db = modeDatabase();
  db.transaction(() => {
    const rows = db.get('settlements', {});
    rows[row.id] = row;
    db.put('settlements', rows);
    db.append('settlement', `${row.id}:${row.updatedAt}:${row.status}`, row.updatedAt, row);
  });
  return row;
}

function update(row, status, fields = {}) {
  return save({ ...row, ...fields, status, updatedAt: Date.now() });
}

export function beginSettlement({ id, mint, wallet, baseline, txs }) {
  const prior = settlementRows().find(r => r.id === id);
  if (prior) return prior;
  return update({ id, mint, wallet, baseline, txs, tries: 0, nextAt: 0 }, 'awaiting_balance');
}

export function tokenDelta(meta, mint, owner) {
  if (!Array.isArray(meta?.preTokenBalances) || !Array.isArray(meta?.postTokenBalances) || meta.err) return null;
  if ([...meta.preTokenBalances, ...meta.postTokenBalances].some(t => t.mint === mint && !t.owner)) return null;
  const sum = list => list.filter(t => t.mint === mint && t.owner === owner)
    .reduce((n, t) => n + BigInt(t.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

export async function advanceSettlement(row) {
  if (config.standalone.shadow || process.env.DRY_RUN === 'true' || !active.has(row.status)) return row;
  if (row.status === 'submitted') {
    if (!row.signature) return update(row, 'review_required');
    const status = await readRpc('monitor', c => c.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).catch(() => null);
    const sig = status?.value[0];
    if (sig?.err) return update(row, 'awaiting_quote', { signature: null, nextAt: Date.now() + 60_000 });
    if (['confirmed', 'finalized'].includes(sig?.confirmationStatus)) return update(row, 'swapped', { confirmedByRpc: true });
    return update(row, 'submitted', { nextAt: Date.now() + 30_000 });
  }
  const attempts = row.tries + 1;
  const retry = (status, reason, delay = 60_000) => update(row, status, { tries: attempts, reason, nextAt: Date.now() + delay });
  let prepared = null;
  try {
    if (row.raw == null) {
      let delta = 0n;
      if (!row.txs?.length || row.baseline == null || !row.wallet) return update(row, 'review_required');
      for (const sig of new Set(row.txs)) {
        const tx = await readRpc('monitor', c => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
        const part = tokenDelta(tx?.meta, row.mint, row.wallet);
        if (part == null) return retry('awaiting_balance', 'close metadata pending');
        delta += part;
      }
      if (delta <= 0n) return update(row, 'no_balance');
      row = update(row, 'awaiting_quote', { raw: String(delta) });
    }
    const balance = await getWalletBalances({ force: true });
    if (balance.error || balance.wallet !== row.wallet) return retry('awaiting_balance', 'wallet read unavailable');
    const token = balance.tokens.find(t => t.mint === row.mint);
    const surplus = BigInt(token?.raw_balance ?? 0) - BigInt(row.baseline);
    if (surplus < BigInt(row.raw) || !token) return retry('awaiting_balance', 'withdrawn tokens unavailable');
    // Check the exact amount attributable to the close before preparing a swap.
    await quoteTokenToSol(row.mint, row.raw);
    const result = await swapToken({ input_mint: row.mint, output_mint: 'SOL',
      amount: Number(row.raw) / 10 ** token.decimals, raw_amount: row.raw,
      beforeExecute: signature => { prepared = update(row, 'submitted', { signature, tries: attempts }); } });
    if (result.success && result.tx) return update(prepared ?? row, 'swapped', { signature: result.tx, outputLamports: result.amount_out });
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
