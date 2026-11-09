import WebSocket from 'ws';
import { log } from '../logger.js';
import { heliusWebSocketRoutes, retryAfterMs } from './rpc.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export function startPumpFeed(key, onLogs, {
  routes = () => heliusWebSocketRoutes(key),
  connect = url => new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024 }),
} = {}) {
  if (!key && !process.env.HELIUS_RPC_KEYS_FILE?.trim()) return () => {};
  const cooldowns = new Map();
  let stopped = false, socket, retry, subscribeTimeout, heartbeat;

  function dial() {
    if (stopped) return;
    const now = Date.now();
    const route = routes().find(candidate => !(cooldowns.get(candidate.url) > now));
    if (!route) {
      retry = setTimeout(dial, 15_000);
      return;
    }
    const label = route.line ? `Helius backup #${route.line}` : 'Helius primary';
    const current = socket = connect(route.url);
    let subscription, alive = true;

    function failed(reason, wait = 30_000) {
      if (stopped || socket !== current) return;
      socket = null;
      clearTimeout(subscribeTimeout);
      clearInterval(heartbeat);
      cooldowns.set(route.url, Date.now() + wait);
      current.terminate();
      log('discovery_warn', `Pump.fun WebSocket ${label}: ${reason}; rotating`);
      retry = setTimeout(dial, 1000);
    }

    subscribeTimeout = setTimeout(() => failed('subscription timeout'), 8000);
    current.on('unexpected-response', (_request, response) => {
      response.resume();
      const { statusCode } = response;
      const wait = statusCode === 401 || statusCode === 403 ? 6 * 60 * 60_000
        : retryAfterMs(response.headers['retry-after'], statusCode === 429 ? 60_000 : 30_000);
      failed(`HTTP ${statusCode}`, wait);
    });
    current.on('error', () => failed('connection failed'));
    current.on('close', () => failed('connection closed'));
    current.on('pong', () => { alive = true; });
    current.on('open', () => {
      if (stopped || socket !== current) return;
      current.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }), err => {
        if (err) failed('subscribe request failed');
      });
    });
    current.on('message', data => {
      if (stopped || socket !== current) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message?.id === 1 && subscription === undefined) {
        if (!Number.isSafeInteger(message.result)) return failed('subscription rejected');
        subscription = message.result;
        clearTimeout(subscribeTimeout);
        log('discovery', `Pump.fun WebSocket subscribed via ${label}`);
        heartbeat = setInterval(() => {
          if (!alive) return failed('heartbeat timeout');
          alive = false;
          current.ping();
        }, 25_000);
        return;
      }
      if (subscription === undefined || message?.method !== 'logsNotification' ||
          message.params?.subscription !== subscription) return;
      const value = message.params.result?.value;
      if (value && !value.err && Array.isArray(value.logs) && value.logs.every(line => typeof line === 'string')) {
        onLogs(value.logs);
      }
    });
  }

  dial();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(subscribeTimeout);
    clearInterval(heartbeat);
    socket?.terminate();
    socket = null;
  };
}
