import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config } from '../config.js';
import { startPumpFeed } from '../standalone/pump-feed.js';

test('Helius reads rotate through private backup lines, honor cooldowns and use the configured RPC fallback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-rpc-'));
  const file = join(dir, 'helius-keys.txt');
  const priorFile = process.env.HELIUS_RPC_KEYS_FILE;
  const priorConfig = { ...config.standalone };
  t.after(() => {
    if (priorFile === undefined) delete process.env.HELIUS_RPC_KEYS_FILE;
    else process.env.HELIUS_RPC_KEYS_FILE = priorFile;
    Object.assign(config.standalone, priorConfig);
    rmSync(dir, { recursive: true });
  });
  writeFileSync(file, '\ufeffprimary\r\n\r\nfirst-backup\r\nfirst-backup\r\nsecond-backup\r\n');
  process.env.HELIUS_RPC_KEYS_FILE = file;
  config.standalone.balanceRpcUrl = 'https://mainnet.helius-rpc.com/?api-key=primary';
  config.standalone.monitorRpcUrl = 'https://monitor.example';
  config.standalone.fallbackRpcUrl = 'https://fallback.example';

  let now = Date.now();
  let phase = 0;
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    const url = new URL(endpoint);
    const route = url.searchParams.get('api-key') ?? url.hostname;
    calls.push(route);
    if (route === 'primary') return new Response('max usage reached', { status: 429 });
    if (route === 'first-backup' && phase === 0) {
      return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '600' } });
    }
    if (route === 'second-backup' && phase > 0) return new Response('Unauthorized', { status: 401 });
    const { id } = JSON.parse(options.body);
    return Response.json({ jsonrpc: '2.0', id, result: 1234 });
  });

  const { readRpc, heliusWebSocketRoutes } = await import('../standalone/rpc.js');
  const getSlot = c => c.getSlot('confirmed');
  assert.equal(await readRpc('balance', getSlot), 1234);
  assert.deepEqual(calls.splice(0), ['primary', 'first-backup', 'second-backup']);
  assert.deepEqual(heliusWebSocketRoutes('primary').map(route => route.line), [5]);
  assert.equal(await readRpc('balance', getSlot), 1234);
  assert.deepEqual(calls.splice(0), ['second-backup']);

  now += 16_000;
  phase = 1;
  assert.equal(await readRpc('balance', getSlot), 1234);
  assert.deepEqual(calls.splice(0), ['second-backup', 'fallback.example']);
  now += 600_000;
  assert.equal(await readRpc('balance', getSlot), 1234);
  assert.deepEqual(calls.splice(0), ['first-backup']);
  assert.equal(await readRpc('monitor', getSlot), 1234);
  assert.deepEqual(calls, ['monitor.example']);
});

test('Pump.fun rotates on 429, accepts only acknowledged notifications and stops cleanly', async t => {
  const sockets = [];
  const logs = [];
  let backupDialed;
  const backup = new Promise(resolve => { backupDialed = resolve; });
  const stop = startPumpFeed('fixture', value => logs.push(value), {
    routes: () => [{ url: 'primary' }, { url: 'backup', line: 1 }],
    connect: url => {
      const socket = new EventEmitter();
      Object.assign(socket, {
        url, terminate() { this.closed = true; this.emit('close'); },
        send(body, cb) { this.request = JSON.parse(body); cb(); }, ping() {},
      });
      sockets.push(socket);
      if (url === 'backup') backupDialed(socket);
      return socket;
    },
  });
  t.after(stop);
  sockets[0].emit('unexpected-response', null, { statusCode: 429, headers: {}, resume() {} });
  const socket = await backup;
  assert.equal(sockets[0].closed, true);
  socket.emit('open');
  assert.equal(socket.request.method, 'logsSubscribe');
  const notify = (target, subscription) => target.emit('message', JSON.stringify({
    method: 'logsNotification', params: { subscription, result: { value: { logs: ['program log'] } } },
  }));
  notify(socket, 42);
  assert.equal(logs.length, 0);
  socket.emit('message', JSON.stringify({ id: 1, result: 42 }));
  notify(sockets[0], 42);
  notify(socket, 41);
  assert.equal(logs.length, 0);
  notify(socket, 42);
  assert.deepEqual(logs, [['program log']]);
  stop();
  assert.equal(socket.closed, true);
  notify(socket, 42);
  assert.equal(logs.length, 1);
});
