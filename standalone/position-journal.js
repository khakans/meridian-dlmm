import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { modeDatabase } from './database.js';
import { readRpc } from './rpc.js';

const key = position => `position-txs:${position}`;
export const positionWrites = (position, db = modeDatabase()) => db.get(key(position), []);

function save(position, row, db) {
  const rows = positionWrites(position, db).filter(prior => prior.signature !== row.signature);
  db.put(key(position), [...rows, row]);
}

export async function simulateLegacy(connection, tx, payer, blockhash) {
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  return (await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, commitment: 'confirmed' })).value;
}

export async function sendPositionWrite(connection, tx, signers, position, stage, db = modeDatabase(), assertActive) {
  if (db.mode !== 'live' || process.env.DRY_RUN === 'true') throw Error('Position submission requires Live');
  let validity = await connection.getLatestBlockhash('confirmed');
  let simulation = await simulateLegacy(connection, tx, signers[0].publicKey, validity.blockhash);
  if (simulation.err === 'BlockhashNotFound') {
    assertActive?.();
    validity = await connection.getLatestBlockhash('confirmed');
    simulation = await simulateLegacy(connection, tx, signers[0].publicKey, validity.blockhash);
  }
  if (simulation.err) throw Error(`Transaction simulation rejected: ${JSON.stringify(simulation.err)}`);
  tx.sign(...signers);
  const bytes = tx.serialize();
  const signature = bs58.encode(tx.signature);
  const row = { signature, stage, ...validity, at: Date.now(), status: 'pending' };
  assertActive?.();
  save(position, row, db);
  const submitted = await connection.sendRawTransaction(bytes, { maxRetries: 2 });
  if (submitted !== signature) throw Error('Unexpected transaction signature');
  const confirmation = await connection.confirmTransaction({ signature, ...validity }, 'confirmed');
  if (confirmation.value.err) throw Error('Transaction failed on-chain; reconciling final status');
  save(position, { ...row, status: 'confirmed' }, db);
  return signature;
}

export function isRetryableEntryError(error) {
  return typeof error === 'string' && (
    error === 'Transaction simulation rejected: "BlockhashNotFound"' ||
    /^Transaction simulation rejected: \{"InstructionError":\[\d+,\{"Custom":6004\}\]\}$/.test(error) ||
    error === 'Active bin changed after entry validation' ||
    error === 'Active bin changed before entry'
  );
}

export function writeStatus(row, signatureStatus, finalizedHeight) {
  if (signatureStatus?.confirmationStatus === 'finalized') return signatureStatus.err ? 'failed' : 'confirmed';
  if (signatureStatus && !signatureStatus.err &&
      signatureStatus.confirmationStatus === 'confirmed') return 'confirmed';
  if (!signatureStatus && finalizedHeight > row.lastValidBlockHeight) return 'expired';
  return 'pending';
}

export async function reconcilePositionWrites(position, db = modeDatabase(), rpc = readRpc) {
  const rows = positionWrites(position, db);
  const pending = rows.filter(row => row.status === 'pending');
  if (!pending.length) return rows;
  const resolved = await rpc('monitor', async connection => {
    const [statuses, height] = await Promise.all([
      connection.getSignatureStatuses(pending.map(row => row.signature), { searchTransactionHistory: true }),
      connection.getBlockHeight('finalized'),
    ]);
    return Promise.all(pending.map(async (row, i) => {
      let status = writeStatus(row, statuses.value[i], height);
      if (status === 'expired') {
        const tx = await connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (tx) status = tx.meta ? (tx.meta.err ? 'failed' : 'confirmed') : 'pending';
      }
      return { ...row, status };
    }));
  });
  for (const row of resolved) if (row.status !== 'pending') save(position, row, db);
  return positionWrites(position, db);
}

export function walletLamportDelta(tx, owner) {
  if (!tx?.meta) return null;
  const message = tx.transaction?.message;
  const keys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
  const i = keys.findIndex(key => String(key.pubkey ?? key) === owner);
  const pre = tx.meta.preBalances?.[i], post = tx.meta.postBalances?.[i];
  return Number.isSafeInteger(pre) && Number.isSafeInteger(post) ? post - pre : null;
}

export function netWalletSol(transactions, owner) {
  const deltas = transactions.map(tx => walletLamportDelta(tx, owner));
  if (!deltas.length || !deltas.every(Number.isSafeInteger)) return null;
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  return Number.isSafeInteger(total) ? total / 1e9 : null;
}

export async function estimateEntryOverheadSol(position, owner, capital) {
  const entries = positionWrites(position).filter(row => row.stage === 'entry' && row.status === 'confirmed');
  if (!entries.length || !owner || !(capital > 0)) return null;
  const txs = await Promise.all(entries.map(row => readRpc('monitor', c =>
    c.getTransaction(row.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))));
  const walletDelta = netWalletSol(txs, owner);
  const positionDelta = netWalletSol(txs, position);
  if (walletDelta == null || positionDelta == null || positionDelta < 0) return null;
  return Math.max(0, -walletDelta - positionDelta - capital);
}

export function estimateNetExitPct(grossPct, capital, entryOverheadSol) {
  if (!Number.isFinite(grossPct) || !(capital > 0) || !Number.isFinite(entryOverheadSol) || entryOverheadSol < 0) return null;
  const exitFeeReserveSol = 0.00003;
  return grossPct - (entryOverheadSol + exitFeeReserveSol) / capital * 100;
}
