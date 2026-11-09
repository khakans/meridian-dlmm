import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { fetchJson } from './rpc.js';
import { screenMint } from './screening.js';
import { startPumpFeed } from './pump-feed.js';

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

export async function meteoraCandidates(minTvl, minVolume) {
  const filter = `token_y=${config.tokens.SOL} && tvl>=${minTvl} && is_blacklisted=false`;
  const feeds = [
    ['Meteora new pool', 'pool_created_at:desc', filter],
    ['Meteora active pool', 'fee_tvl_ratio_30m:desc', `${filter} && volume_30m>=${minVolume}`],
  ];
  const results = await Promise.allSettled(feeds.map(async ([source, sort, filters]) => {
    const params = new URLSearchParams({ page_size: '20', sort_by: sort, filter_by: filters });
    const data = (await fetchJson(`https://dlmm.datapi.meteora.ag/pools?${params}`)).data;
    if (!Array.isArray(data)) throw Error('Invalid Meteora pool list');
    return data.flatMap(pool => {
      const mint = pool.token_x?.address;
      if (pool.token_y?.address !== config.tokens.SOL || typeof mint !== 'string') return [];
      if (source === 'Meteora new pool' && !(Date.now() - pool.created_at >= 0 && Date.now() - pool.created_at < 86_400_000)) return [];
      try { return [{ mint: new PublicKey(mint).toBase58(), source }]; } catch { return []; }
    });
  }));
  for (const result of results) if (result.status === 'rejected') log('discovery_warn', 'Meteora discovery feed unavailable');
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

export function startDiscovery({ gmgnKey, heliusKey, notify, thresholds = config.screening, onMatch, stats }) {
  const queue = new Map();
  const screened = new Map();
  let stopped = false;
  let busy = false;
  let gmgnRetryAt = 0;

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
    queue.set(mint, { mint, sources: new Set([source]), priority, addedAt: Date.now(), tries: 0, retryAt: 0 });
    stats.received++;
    // Keep higher-value signals when the launch feed is busy.
    if (queue.size > 120) {
      const score = item => item.priority + Number(item.tries > 0);
      const lowest = [...queue.values()].reduce((a, b) => score(a) <= score(b) ? a : b);
      queue.delete(lowest.mint);
      stats.dropped++;
    }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (gmgnKey && Date.now() >= gmgnRetryAt) {
        try {
          for (const mint of await gmgnTrending(gmgnKey)) enqueue(mint, 'GMGN trending', 2);
        } catch (error) {
          gmgnRetryAt = Date.now() + 5 * MINUTE;
          log('discovery_warn', error.message.startsWith('Data request failed (HTTP')
            ? `GMGN ${error.message}` : 'GMGN ranking unavailable');
        }
      }
      for (const { mint, source } of await meteoraCandidates(thresholds.minTvl, thresholds.minVolume)) {
        enqueue(mint, source, source === 'Meteora new pool' ? 3 : 2);
      }
      const now = Date.now();
      for (const [mint, item] of queue) if (now - item.addedAt > 30 * MINUTE) {
        queue.delete(mint);
        stats.dropped++;
      }
      for (const [mint, item] of screened) if (now >= item.retryAt) screened.delete(mint);
      const ranked = [...queue.values()].filter(item => item.retryAt <= now).sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    const reserved = [
      ranked.find(item => item.tries > 0 && [...item.sources].some(source => source.startsWith('Meteora'))),
      ranked.find(item => item.tries > 0),
      ranked.find(item => item.priority === 1),
    ].filter(Boolean);
      const batch = [...new Set([...reserved, ...ranked])].slice(0, 6);
      for (const item of batch) {
        if (stopped) break;
        const { mint, sources } = item;
        item.tries++;
        let result;
        try {
          result = await screenMint(mint, { thresholds });
        } catch {
          result = { pass: false, reason: 'Screening data unavailable' };
        }
        if (stopped) break;
        log('discovery', `${mint} [${[...sources].join(', ')}] ${result.pass ? 'passed' : result.reason}`);
        if (!result.pass) {
          const reason = result.reason.split(/ \(|;/)[0];
          stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
        }
        if (result.pass || result.terminal || item.tries >= 4) {
          queue.delete(mint);
          screened.set(mint, { priority: item.priority, announced: result.pass || result.terminal, retryAt: Date.now() + (result.pass || result.terminal ? 60 : 10) * MINUTE });
        } else {
          item.retryAt = Date.now() + [2, 5, 10][item.tries - 1] * MINUTE;
          stats.retries++;
        }
        if (result.pass) {
          stats.passed++;
          try {
            const research = await onMatch?.(mint, result, [...sources]);
            if (!stopped) await notify(`🔎 Meridian watchlist\nMint ${mint}\nPool ${result.pool.pool_address}\nSource ${[...sources].join(', ')}${research ? `\n${research}` : ''}`);
          } catch { log('discovery_warn', `${mint} post-screen processing unavailable`); }
        }
      }
    } finally {
      stats.waiting = queue.size;
      busy = false;
    }
  }

  const stopPump = startPumpFeed(heliusKey, logs => {
    for (const { mint, source } of pumpCandidates(logs)) {
      enqueue(mint, source, source === 'Pump.fun migration' ? 3 : 1);
    }
  });

  log('discovery', `Watchlist started (GMGN=${Boolean(gmgnKey)}, Helius=${Boolean(heliusKey)})`);
  const timer = setInterval(() => void tick(), MINUTE);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    stopPump();
  };
}
