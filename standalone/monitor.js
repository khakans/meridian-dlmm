import { PublicKey } from '@solana/web3.js';
import { listSmartWallets } from '../smart-wallets.js';
import { connection, readRpc, fetchJson } from './rpc.js';
import { DLMM_PROGRAM, transactionEntries } from './events.js';
import { acceptEvents } from './store.js';
import { log } from '../logger.js';

export class WalletMonitor {
  constructor(store, options, { rpc = readRpc, wallets = listSmartWallets, entries = transactionEntries, onSignal = () => {}, onEntries = () => {} } = {}) {
    Object.assign(this, { store, options, rpc, wallets, entries, onSignal, onEntries });
    this.subscriptions = new Map(); this.running = false; this.reconciling = false; this.draining = false;
    this.retry = new Map();
    this.stats = { transactions: 0, entries: 0, lastLagMs: null, errors: 0 };
  }
  enqueue(wallet, signature, slot) {
    const key = `${wallet}:${signature}`;
    if (!this.running || !this.store.data.wallets[wallet] || slot <= this.store.data.wallets[wallet].baselineSlot) return;
    if (this.store.data.seen[key] || this.store.data.pending[key]) return;
    if (Object.keys(this.store.data.pending).length >= this.options.maxPendingTransactions) throw new Error('Wallet queue is full; entry monitoring is degraded');
    this.store.data.pending[key] = { wallet, signature, slot, queuedAt: Date.now(), retryAt: 0, failures: 0 };
    this.store.save();
  }
  coverage(now = Date.now()) {
    const wallets = this.wallets().wallets.filter(w => !w.type || w.type === 'lp');
    const result = { total: wallets.length, fresh: 0, stale: 0, errors: 0 };
    for (const w of wallets) {
      const state = this.store.data.wallets[w.address];
      if (state?.error || this.retry.has(w.address)) result.errors++;
      else if (state?.reconciledAt && now - state.reconciledAt < this.options.reconcileSec * 3000) result.fresh++;
      else result.stale++;
    }
    return result;
  }
  healthy() {
    const { total, fresh } = this.coverage();
    return fresh === total && fresh >= this.options.walletThreshold;
  }
  async start() {
    this.running = true;
    this.ws = connection(this.options.monitorRpcUrl, this.options.monitorWsUrl);
    await this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), 1000);
    this.queueTimer = setInterval(() => this.drain(), 1000);
  }
  async reconcile() {
    if (!this.running || this.reconciling) return;
    this.reconciling = true;
    try {
      const wallets = this.wallets().wallets.filter(w => !w.type || w.type === 'lp');
      const addresses = new Set(wallets.map(w => w.address));
      for (const address of this.retry.keys()) if (!addresses.has(address)) this.retry.delete(address);
      for (const [address, id] of this.subscriptions) if (!addresses.has(address)) {
        await this.ws.removeOnLogsListener(id).catch(() => {});
        this.subscriptions.delete(address);
      }
      for (const address of Object.keys(this.store.data.wallets)) if (!addresses.has(address)) {
        delete this.store.data.wallets[address];
        this.store.data.events = this.store.data.events.filter(e => e.wallet !== address);
      }
      const now = Date.now();
      const last = w => this.store.data.wallets[w.address]?.reconciledAt ?? 0;
      const due = wallets.filter(w => now >= (this.retry.get(w.address)?.at ?? 0) &&
        (!this.subscriptions.has(w.address) || now >= last(w) + this.options.reconcileSec * 1000))
        .sort((a, b) => last(a) - last(b)).slice(0, 4);
      let baseline;
      await Promise.all(due.map(async w => {
        if (!this.running) return;
        try {
          if (!this.store.data.wallets[w.address]) {
            const baselineSlot = await (baseline ??= this.rpc('monitor', c => c.getSlot('confirmed')));
            // Existing portfolio is a reconciliation baseline, never an entry signal.
            const portfolio = await fetchJson(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${w.address}`);
            if (!Array.isArray(portfolio.pools)) throw new Error('Unexpected Meteora portfolio response');
            this.store.data.wallets[w.address] = { baselineSlot, cursor: null, baselinePools: portfolio.pools.map(p => p.poolAddress), reconciledAt: 0 };
            this.store.save();
          }
          if (!this.subscriptions.has(w.address)) {
            const id = this.ws.onLogs(new PublicKey(w.address), (event, context) => {
              if (event.err || (Array.isArray(event.logs) &&
                  !event.logs.some(line => line.startsWith(`Program ${DLMM_PROGRAM} invoke [`)))) return;
              try { this.enqueue(w.address, event.signature, context.slot); }
              catch (e) { this.store.data.wallets[w.address].error = e.message; this.store.save(); }
            }, 'confirmed');
            this.subscriptions.set(w.address, id);
          }
          const state = this.store.data.wallets[w.address];
          let before, newest, complete = false;
          const found = [];
          for (let page = 0; page < 10; page++) {
            const signatures = await this.rpc('monitor', c => c.getSignaturesForAddress(new PublicKey(w.address), { limit: 100, ...(before ? { before } : {}) }, 'confirmed'));
            newest ||= signatures[0]?.signature;
            for (const s of signatures) {
              if (s.signature === state.cursor || s.slot <= state.baselineSlot || (s.blockTime != null && Date.now() - s.blockTime * 1000 > this.options.windowSec * 1000)) { complete = true; break; }
              if (!s.err) found.push(s);
            }
            if (complete || signatures.length < 100) { complete = true; break; }
            before = signatures.at(-1).signature;
          }
          if (!complete) throw new Error('Signature backfill limit reached; entries paused until history catches up');
          for (const s of found.reverse()) this.enqueue(w.address, s.signature, s.slot);
          state.cursor = newest || state.cursor;
          state.error = null; state.reconciledAt = Date.now();
          this.retry.delete(w.address);
          this.store.save();
        } catch (e) {
          this.stats.errors++;
          const failures = (this.retry.get(w.address)?.failures ?? 0) + 1;
          this.retry.set(w.address, { failures, at: Date.now() + Math.min(120_000, 5000 * 2 ** Math.min(failures - 1, 5)) });
          const state = this.store.data.wallets[w.address];
          if (state) { state.error = e.message; this.store.save(); }
          log('monitor_warn', `Wallet ${w.address.slice(0, 8)}: ${e.message}`);
        }
      }));
    } finally { this.reconciling = false; }
  }
  async drain() {
    if (!this.running || this.draining) return;
    this.draining = true;
    let dirty = false;
    try {
      const reads = new Map();
      for (const [key, pending] of Object.entries(this.store.data.pending).filter(([, row]) => row.retryAt <= Date.now()).slice(0, 20)) {
        if (!this.running) break;
        dirty = true;
        try {
          if (!this.store.data.wallets[pending.wallet] || Date.now() - pending.queuedAt > this.options.windowSec * 1000 || (pending.failures ?? 0) >= 3) {
            delete this.store.data.pending[key]; continue;
          }
          if (!reads.has(pending.signature)) reads.set(pending.signature, this.rpc('monitor', c =>
            c.getTransaction(pending.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })));
          const tx = await reads.get(pending.signature);
          if (!tx) throw new Error('Confirmed transaction not yet available');
          this.stats.transactions++;
          const events = await this.entries(tx, pending.signature, pending.wallet, this.options);
          this.stats.entries += events.length;
          if (events.length) this.stats.lastLagMs = Date.now() - tx.blockTime * 1000;
          this.store.data.seen[key] = Date.now();
          delete this.store.data.pending[key];
          const signals = acceptEvents(this.store, events, this.options);
          for (const signal of signals) this.onSignal(signal);
          if (events.length) this.onEntries(events);
        } catch {
          pending.failures++;
          pending.retryAt = Date.now() + Math.min(15_000, 1000 * 2 ** Math.min(pending.failures, 4));
          this.stats.errors++;
        }
      }
      if (dirty) this.store.save();
    } finally { this.draining = false; }
  }
  async stop() {
    this.running = false;
    clearInterval(this.reconcileTimer); clearInterval(this.queueTimer);
    await Promise.allSettled([...this.subscriptions.values()].map(id => this.ws.removeOnLogsListener(id)));
    this.subscriptions.clear();
  }
}
