'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');
const { createRedisStore } = require('../lib/stores');

// A stand-in for Upstash's REST /pipeline endpoint, covering the commands the
// Redis store sends. EVAL mirrors the store's Lua vote-moving script.
function fakeUpstash() {
  const strings = new Map();
  const hashes = new Map();
  const sets = new Map();
  const hash = (k) => hashes.get(k) || hashes.set(k, new Map()).get(k);
  const set = (k) => sets.get(k) || sets.set(k, new Set()).get(k);
  const run = ([cmd, ...a]) => {
    switch (cmd) {
      case 'GET': return strings.get(a[0]) ?? null;
      case 'SET': strings.set(a[0], a[1]); return 'OK';
      case 'INCR': { const n = Number(strings.get(a[0]) || 0) + 1; strings.set(a[0], String(n)); return n; }
      case 'EXPIRE': return 1;
      case 'HGET': return hash(a[0]).get(a[1]) ?? null;
      case 'HSET': hash(a[0]).set(a[1], a[2]); return 1;
      case 'HDEL': return hash(a[0]).delete(a[1]) ? 1 : 0;
      case 'HGETALL': return [...hash(a[0])].flat().map(String);
      case 'SCARD': return set(a[0]).size;
      case 'SADD': return set(a[0]).add(a[1]) && 1;
      case 'EVAL': {
        const [, , votesKey, countsKey, voter, pick] = a;
        const votes = hash(votesKey), counts = hash(countsKey);
        const prev = votes.get(voter);
        if (prev === pick) return 0;
        if (prev) counts.set(prev, counts.get(prev) - 1);
        votes.set(voter, pick);
        counts.set(pick, (counts.get(pick) || 0) + 1);
        return 1;
      }
      default: return { error: `unsupported ${cmd}` };
    }
  };
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url !== '/pipeline' || req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401);
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(JSON.parse(body).map((c) => {
      const r = run(c);
      return r && r.error ? r : { result: r };
    })));
  });
}

async function redis(t) {
  const server = fakeUpstash();
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  return { url: `http://localhost:${server.address().port}`, token: 'test-token' };
}

test('redis store round-trips every kind of data', async (t) => {
  const store = createRedisStore(await redis(t));

  await store.saveSettings({ startDate: '2026-10-01', timeZone: 'UTC' });
  assert.deepStrictEqual(await store.getSettings(), { startDate: '2026-10-01', timeZone: 'UTC' });

  await store.putFragrance({ id: 'a', name: 'A' });
  await store.putFragrance({ id: 'b', name: 'B' });
  await store.deleteFragrance('b');
  assert.deepStrictEqual(await store.listFragrances(), [{ id: 'a', name: 'A' }]);

  await store.castVote('v1', 'a', 'net');
  await store.castVote('v2', 'a', 'net');
  await store.castVote('v1', 'c', 'net');
  assert.deepStrictEqual(await store.tally(), { a: 1, c: 1 });
  assert.strictEqual(await store.getVote('v1'), 'c');
  assert.strictEqual(await store.votersForIp('net'), 2);

  await store.putDay('2026-10-01', { steps: 1 });
  await store.putDay('2026-10-02', { steps: 2 });
  await store.deleteDay('2026-10-02');
  assert.deepStrictEqual(await store.listDays(), { '2026-10-01': { steps: 1 } });

  assert.strictEqual(await store.hit('k', 60), 1);
  assert.strictEqual(await store.hit('k', 60), 2);
});

test('redis errors surface instead of being swallowed', async (t) => {
  const store = createRedisStore({ ...(await redis(t)), token: 'wrong' });
  await assert.rejects(store.getSettings(), /HTTP 401/);
});

function fakeReq(method, body) {
  return Object.assign(Readable.from([]), {
    method,
    body,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    socket: {},
  });
}

function call(handler, req) {
  return new Promise((resolve) => {
    handler(req, {
      headersSent: false,
      writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); },
      end(data) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(data) }); },
    });
  });
}

function freshVercelModule(path) {
  delete require.cache[require.resolve('../lib/vercel')];
  delete require.cache[require.resolve(path)];
  return require(path);
}

test('vercel functions explain a missing database', async () => {
  delete process.env.KV_REST_API_URL;
  const state = freshVercelModule('../api/state');
  const out = await call(state, fakeReq('GET'));
  assert.strictEqual(out.status, 503);
  assert.match(out.body.error, /Upstash Redis/);
});

test('vercel functions work against redis with a pre-parsed body', async (t) => {
  const { url, token } = await redis(t);
  Object.assign(process.env, { KV_REST_API_URL: url, KV_REST_API_TOKEN: token });
  t.after(() => { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; });

  const suggest = freshVercelModule('../api/suggest');
  const out = await call(suggest, fakeReq('POST', { name: 'Bleu de Chanel', house: 'Chanel' }));
  assert.strictEqual(out.status, 201);

  const state = require('../api/state');
  const s = await call(state, fakeReq('GET'));
  assert.strictEqual(s.status, 200);
  assert.match(s.headers['Set-Cookie'], /; Secure$/);
  assert.deepStrictEqual(s.body.fragrances, [], 'suggestion is pending, not on the ballot');
});
