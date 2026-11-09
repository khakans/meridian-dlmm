import { Connection } from '@solana/web3.js';
import { config } from '../config.js';

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status})`);
  return response.json();
}
export function connection(url, wsEndpoint) {
  if (!url) throw new Error('Configure RPC_URL (and optionally MONITOR_RPC_URL/BALANCE_RPC_URL)');
  return new Connection(url, {
    commitment: 'confirmed', ...(wsEndpoint ? { wsEndpoint } : {}),
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
}
const connections = new Map();
const rateLimitedUntil = new Map();
export async function readRpc(kind, fn) {
  const primary = kind === 'balance' ? config.standalone.balanceRpcUrl : config.standalone.monitorRpcUrl;
  const urls = [...new Set([primary, config.standalone.fallbackRpcUrl].filter(Boolean))];
  if (!urls.length) throw new Error('RPC_URL is required');
  let error;
  for (const url of urls) {
    if ((rateLimitedUntil.get(url) ?? 0) > Date.now()) continue;
    try {
      if (!connections.has(url)) connections.set(url, connection(url));
      return await fn(connections.get(url));
    } catch (e) {
      error = e;
      if (/\b429\b|too many requests/i.test(e.message ?? '')) rateLimitedUntil.set(url, Date.now() + 15_000);
    }
  }
  // Provider errors may contain authenticated URLs. Keep them out of persisted state.
  throw new Error(`RPC ${kind} read failed (${error?.name || 'Error'})`);
}
