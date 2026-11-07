import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { log } from '../logger.js';
import { connection, fetchJson } from './rpc.js';
import { screenMint } from './screening.js';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const CREATE = '1b72a94ddeeb6376';
const MIGRATION = 'bde95db95c94ea94';
const MINUTE = 60_000;

// Borsh layouts from pump-public-docs/idl/pump.json. Only accept data emitted
// by Pump itself, including when Pump is invoked by another program.
export function pumpCandidates(logs) {
  const stack = [];
  const found = [];
  for (const line of logs) {
    const invoked = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoked) {
      if (Number(invoked[2]) !== stack.length + 1) return found;
      stack.push({ program: invoked[1], firstEvent: found.length });
      continue;
    }
    const exited = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (exited) {
      const frame = stack.pop();
      if (frame?.program !== exited[1]) return [];
      if (exited[2] !== 'success') found.length = frame.firstEvent;
      continue;
    }
    if (!line.startsWith('Program data: ') || stack.at(-1)?.program !== PUMP.toBase58()) continue;
    const data = Buffer.from(line.slice(14), 'base64');
    const kind = data.subarray(0, 8).toString('hex');
    let offset = 40; // discriminator + user pubkey in CompletePumpAmmMigrationEvent
    if (kind === CREATE) {
      offset = 8;
      for (let i = 0; i < 3; i++) {
        if (offset + 4 > data.length) break;
        offset += 4 + data.readUInt32LE(offset);
      }
    }
    if ((kind === CREATE || kind === MIGRATION) && offset + 32 <= data.length) {
      found.push({
        mint: new PublicKey(data.subarray(offset, offset + 32)).toBase58(),
        source: kind === MIGRATION ? 'Pump.fun migration' : 'Pump.fun launch',
      });
    }
  }
  // Ignore incomplete invocations when a provider truncates the log.
  return stack.length ? found.slice(0, stack[0].firstEvent) : found;
}

export async function gmgnTrending(key) {
  const params = new URLSearchParams({
    chain: 'sol', interval: '5m', limit: '20', order_by: 'volume', direction: 'desc',
    timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID(),
  });
  const result = await fetchJson(`https://openapi.gmgn.ai/v1/market/rank?${params}`, {
    headers: { 'X-APIKEY': key },
    redirect: 'error',
  });
  if (result.code !== 0 || !Array.isArray(result.data?.rank)) {
    throw new Error('GMGN rejected the request or returned an invalid rank');
  }
  return result.data.rank.slice(0, 20).flatMap(item => {
    const address = item?.address;
    if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return [];
    try { return [new PublicKey(address).toBase58()]; } catch { return []; }
  });
}

export function startDiscovery({ gmgnKey, heliusKey, notify }) {
  if (!gmgnKey && !heliusKey) return null;
  const queue = new Map();
  const screened = new Map();
  let stopped = false;
  let busy = false;
  let ws, subscription;

  function enqueue(mint, source, priority) {
    const item = queue.get(mint);
    if (item) {
      item.sources.add(source);
      item.priority = Math.max(item.priority, priority);
      return;
    }
    const previous = screened.get(mint);
    if (previous && Date.now() < previous.retryAt &&
        (previous.announced || priority <= previous.priority)) return;
    queue.set(mint, { mint, sources: new Set([source]), priority, addedAt: Date.now() });
    // Keep higher-value signals when the launch feed is busy.
    if (queue.size > 120) {
      const lowest = [...queue.values()].reduce((a, b) => a.priority <= b.priority ? a : b);
      queue.delete(lowest.mint);
    }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (gmgnKey) {
        try {
          for (const mint of await gmgnTrending(gmgnKey)) enqueue(mint, 'GMGN trending', 2);
        } catch (error) {
          log('discovery_warn', error.message.startsWith('Data request failed (HTTP')
            ? `GMGN ${error.message}` : 'GMGN ranking unavailable');
        }
      }
      const now = Date.now();
      for (const [mint, item] of queue) if (now - item.addedAt > 15 * MINUTE) queue.delete(mint);
      for (const [mint, item] of screened) if (now >= item.retryAt) screened.delete(mint);
      const ranked = [...queue.values()].sort((a, b) => b.priority - a.priority);
      // Reserve one slot for launches even when trending is continuously full.
      const launch = ranked.find(item => item.priority === 1);
      const batch = launch ? [...ranked.filter(item => item !== launch).slice(0, 3), launch] : ranked.slice(0, 4);
      for (const item of batch) {
        if (stopped) break;
        const { mint, sources, priority } = item;
        try {
          const result = await screenMint(mint);
          if (stopped) break;
          screened.set(mint, { priority: item.priority, announced: result.pass, retryAt: Date.now() + (result.pass ? 60 : 5) * MINUTE });
          log('discovery', `${mint} [${[...sources].join(', ')}] ${result.pass ? 'passed' : result.reason}`);
          if (result.pass) await notify(`🔎 Meridian watchlist\n${mint}\nPool ${result.pool.pool_address}\nSource ${[...sources].join(', ')}\nPassed token and DLMM pool screening.`);
        } catch {
          screened.set(mint, { priority, retryAt: Date.now() + MINUTE });
          log('discovery_warn', `${mint} screening unavailable; will retry when rediscovered`);
        } finally {
          queue.delete(mint);
        }
      }
    } finally {
      busy = false;
    }
  }

  if (heliusKey) {
    const url = new URL('https://mainnet.helius-rpc.com/');
    url.searchParams.set('api-key', heliusKey);
    ws = connection(url.toString(), url.toString().replace(/^https:/, 'wss:'));
    subscription = ws.onLogs(PUMP, event => {
      if (stopped || event.err) return;
      for (const { mint, source } of pumpCandidates(event.logs)) {
        enqueue(mint, source, source === 'Pump.fun migration' ? 3 : 1);
      }
    }, 'confirmed');
  }

  log('discovery', `Watchlist started (GMGN=${Boolean(gmgnKey)}, Helius=${Boolean(heliusKey)})`);
  const timer = setInterval(() => void tick(), MINUTE);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (ws) await ws.removeOnLogsListener(subscription).catch(() => {});
  };
}
