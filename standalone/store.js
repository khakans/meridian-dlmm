import fs from 'node:fs';
import { emptyMonitor, modeDatabase } from './database.js';

export class MonitorStore {
  constructor(file = null) {
    this.file = file;
    this.database = file == null ? modeDatabase() : null;
    this.historyIds = new Set();
    this.data = this.database ? this.database.get('monitor', emptyMonitor()) :
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyMonitor();
    if (this.data.version !== 1 || !this.data.wallets || !this.data.attempts || !Array.isArray(this.data.events)) throw new Error('Invalid monitor state; refusing to discard recovery history');
    for (const item of Object.values(this.data.research ?? {})) {
      item.plans = (item.plans ?? []).filter(plan => plan.range === 'volatility');
    }
  }
  save() {
    if (this.database) return this.database.saveMonitor(this.data, this.historyIds);
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  resetPnl(now = Date.now()) {
    const pnlResetAt = { [this.database.mode]: now };
    this.database.saveMonitor({ ...this.data, pnlResetAt }, this.historyIds);
    this.data.pnlResetAt = pnlResetAt;
  }
  prune(now = Date.now()) {
    for (const [mint, item] of Object.entries(this.data.convergenceDiagnostics ?? {})) {
      if (now - item.at > 86_400_000) delete this.data.convergenceDiagnostics[mint];
    }
    for (const [mint, item] of Object.entries(this.data.research ?? {})) {
      if (now - item.at > 24 * 3600_000) delete this.data.research[mint];
    }
    this.data.events = this.data.events.filter(e => now - e.at < 10 * 60_000);
    for (const [key, at] of Object.entries(this.data.seen)) if (now - at > 2 * 3600_000) delete this.data.seen[key];
    const seenEntries = Object.entries(this.data.seen);
    if (seenEntries.length > 5000) {
      seenEntries.sort((a, b) => b[1] - a[1]);
      this.data.seen = Object.fromEntries(seenEntries.slice(0, 5000));
    }
    for (const [mint, s] of Object.entries(this.data.signals)) {
      if (!s.done && now > s.deadline) {
        s.done = true;
        s.reason = s.reason || "expired";
        s.closedAt = now;
      }
      if (s.done && now - s.createdAt > 24 * 3600_000) delete this.data.signals[mint];
    }
    // Attempt records double as mint-level duplicate protection; a day matches
    // the pool-memory cooldown horizon. Never prune mid-submit checkpoints.
    for (const [mint, a] of Object.entries(this.data.attempts)) {
      if (!["submitting", "review_required"].includes(a.status) && now - a.at > 24 * 3600_000) delete this.data.attempts[mint];
    }
  }
}
export function qualifyingEvents(events, mint, options, now = Date.now()) {
  const latest = new Map();
  for (const e of events) {
    if (e.mint !== mint || e.at > now || now - e.at > options.windowSec * 1000 || e.depositSol < options.minDepositSol) continue;
    const group = options.walletGroups[e.wallet] || e.wallet;
    if (!latest.has(group) || latest.get(group).at < e.at) latest.set(group, e);
  }
  return [...latest.values()];
}
export function acceptEvents(store, events, options, now = Date.now()) {
  for (const e of events) {
    if (!store.data.events.some(old => old.id === e.id)) store.data.events.push(e);
  }
  const triggered = [];
  for (const mint of new Set(events.map(e => e.mint))) {
    const existing = store.data.signals[mint];
    const recent = qualifyingEvents(store.data.events, mint, options, now);
    const wider = qualifyingEvents(store.data.events, mint, { ...options, windowSec: Math.max(options.windowSec, 300) }, now);
    const times = wider.map(e => e.at);
    store.data.convergenceDiagnostics ??= {};
    store.data.convergenceDiagnostics[mint] = {
      at: now, current: recent.length, wider: wider.length,
      spreadSec: times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : null,
      reason: existing && (!existing.done || now < existing.cooldownUntil) ? 'active or cooldown' :
        recent.length >= options.walletThreshold ? 'threshold reached' : 'waiting for distinct wallets',
    };
    if (existing && (!existing.done || now < existing.cooldownUntil)) continue;
    // A completed signal cannot be reused after its cooldown.
    const fresh = recent.filter(e => !existing || e.at > existing.closedAt);
    if (fresh.length < options.walletThreshold) continue;
    const signal = { mint, createdAt: now, deadline: now + options.screeningDeadlineSec * 1000, nextCheck: now, events: fresh, done: false };
    store.data.signals[mint] = signal;
    triggered.push(signal);
  }
  store.prune(now);
  store.save();
  return triggered;
}
export function finishSignal(store, signal, reason, options = {}, now = Date.now()) {
  const cooldownSec = options?.cooldownSec ?? 300;
  Object.assign(signal, { done: true, reason, closedAt: now, cooldownUntil: now + cooldownSec * 1000 });
  if (store.data.convergenceDiagnostics?.[signal.mint]) store.data.convergenceDiagnostics[signal.mint].reason = reason;
  store.save();
}
