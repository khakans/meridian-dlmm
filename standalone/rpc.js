import { readFileSync } from 'node:fs';
import { Connection } from '@solana/web3.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';
const connections = new Map();
const blockedUntil = new Map();
const activeHelius = new Map();
let backupKeys;

function heliusEndpoint(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin === new URL(HELIUS_RPC).origin && !parsed.username && !parsed.password) return parsed;
  } catch { /* An invalid URL is handled by the RPC client. */ }
  return null;
}

function readBackupKeys() {
  if (backupKeys) return backupKeys;
  const file = process.env.HELIUS_RPC_KEYS_FILE?.trim();
  backupKeys = [];
  if (!file) return backupKeys;
  try {
    const seen = new Set();
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      const key = line.trim();
      if (!/^[\w.~-]+$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      backupKeys.push({ key, line: index + 1 });
    }
    if (!backupKeys.length) log('rpc_warn', 'Helius backup key file has no usable lines');
  } catch {
    log('rpc_warn', 'Helius backup key file is unreadable');
  }
  return backupKeys;
}

function routesFor(url) {
  const helius = heliusEndpoint(url);
  const routes = [{ url }];
  if (!helius) return routes;
  routes[0].group = url;
  for (const { key, line } of readBackupKeys()) {
    if (key === helius.searchParams.get('api-key')) continue;
    const endpoint = new URL(HELIUS_RPC);
    endpoint.searchParams.set('api-key', key);
    routes.push({ url: endpoint.href, group: url, line });
  }
  const active = routes.findIndex(route => route.url === activeHelius.get(url));
  if (active > 0) routes.unshift(...routes.splice(active, 1));
  return routes;
}

export function heliusWebSocketRoutes(key) {
  const primary = new URL(HELIUS_RPC);
  if (key) primary.searchParams.set('api-key', key);
  return routesFor(primary.href)
    .filter(route => (key || route.line) && !(blockedUntil.get(route.url) > Date.now()))
    .map(route => ({ url: route.url.replace(/^https:/, 'wss:'), line: route.line }));
}

export function retryAfterMs(header, fallback) {
  const seconds = header ? Number(header) : NaN;
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(wait) ? Math.max(1000, wait) : fallback;
}

function blockUnavailable(url, message, status, retryAfter) {
  const helius = heliusEndpoint(url);
  let delay;
  if (helius && /max usage reached|(?:credits?|quota) (?:exhausted|exceeded|depleted)/i.test(message)) {
    delay = 6 * 60 * 60_000;
  } else if (helius && (status === 401 || /(?:invalid|revoked|expired) api key/i.test(message))) {
    delay = Infinity;
  } else if (status === 429 || /\b429\b|too many requests|rate limit|-32005/i.test(message)) {
    delay = retryAfterMs(retryAfter, 15_000);
  }
  if (delay) blockedUntil.set(url, Math.max(blockedUntil.get(url) ?? 0, Date.now() + delay));
}

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
    fetch: async (endpoint, options) => {
      const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(15_000) });
      if (response.status === 429 || (heliusEndpoint(url) && [401, 403].includes(response.status))) {
        const body = heliusEndpoint(url) ? await response.clone().text().catch(() => '') : '';
        blockUnavailable(url, body, response.status, response.headers.get('retry-after'));
      }
      return response;
    },
  });
}
export async function readRpc(kind, fn) {
  const primary = kind === 'balance' ? config.standalone.balanceRpcUrl : config.standalone.monitorRpcUrl;
  const urls = [...new Set([primary, config.standalone.fallbackRpcUrl].filter(Boolean))];
  if (!urls.length) throw new Error('RPC_URL is required');
  const attempted = new Set();
  let skipGroup;
  for (const { url, group, line } of urls.flatMap(routesFor)) {
    if (attempted.has(url) || (group && group === skipGroup) || (blockedUntil.get(url) ?? 0) > Date.now()) continue;
    attempted.add(url);
    try {
      if (!connections.has(url)) connections.set(url, connection(url));
      const result = await fn(connections.get(url));
      if (group && activeHelius.get(group) !== url && !(blockedUntil.get(url) > Date.now())) {
        activeHelius.set(group, url);
        if (line) log('rpc', `Helius backup #${line} active for ${kind} reads`);
      }
      return result;
    } catch (e) {
      if (!(blockedUntil.get(url) > Date.now())) blockUnavailable(url, e?.message ?? '');
      if (group && !(blockedUntil.get(url) > Date.now())) skipGroup = group;
    }
  }
  // Provider errors may contain authenticated URLs. Keep them out of persisted state.
  throw new Error(`RPC ${kind} read failed`);
}
