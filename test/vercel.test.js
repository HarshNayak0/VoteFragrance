'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');

// A stand-in for Upstash's REST /pipeline endpoint, covering the commands the
// Redis store sends. EVAL mirrors the store's Lua vote-moving script.
function fakeUpstash() {
  const hashes = new Map();
  const sets = new Map();
  const hash = (k) => hashes.get(k) || hashes.set(k, new Map()).get(k);
  const set = (k) => sets.get(k) || sets.set(k, new Set()).get(k);
  const run = ([cmd, ...a]) => {
    switch (cmd) {
      case 'HGET': return hash(a[0]).get(a[1]) ?? null;
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
      default: throw new Error(`unsupported ${cmd}`);
    }
  };
  return http.createServer(async (req, res) => {
    assert.strictEqual(req.url, '/pipeline');
    assert.strictEqual(req.headers.authorization, 'Bearer test-token');
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(JSON.parse(body).map((c) => ({ result: run(c) }))));
  });
}

async function listen(t, server) {
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  return `http://localhost:${server.address().port}`;
}

async function withRedisEnv(t) {
  const url = await listen(t, fakeUpstash());
  process.env.KV_REST_API_URL = url;
  process.env.KV_REST_API_TOKEN = 'test-token';
  t.after(() => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });
}

test('redis store: votes move between fragrances and tally correctly', async (t) => {
  await withRedisEnv(t);
  const { createApp } = require('../server');
  const url = await listen(t, createApp());

  const first = await fetch(`${url}/api/state`);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const post = (fragranceId, c) =>
    fetch(`${url}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}) },
      body: JSON.stringify({ fragranceId }),
    }).then((r) => r.json());

  await post('aventus', cookie);
  await post('layton');
  let body = await post('layton', cookie);
  assert.strictEqual(body.total, 2);
  assert.deepStrictEqual(body.results[0], { id: 'layton', votes: 2 });
  assert.strictEqual(body.results.find((r) => r.id === 'aventus').votes, 0);

  const state = await (await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).json();
  assert.strictEqual(state.myVote, 'layton');
});

function fakeVercelReq({ method, body, cookie }) {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    body,
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...(cookie ? { cookie } : {}) },
    socket: {},
  });
  return req;
}

test('vercel functions accept a pre-parsed body and set a Secure cookie', async (t) => {
  await withRedisEnv(t);
  delete require.cache[require.resolve('../lib/vercel')];
  delete require.cache[require.resolve('../api/vote')];
  const vote = require('../api/vote');

  let res;
  const done = new Promise((resolve) => {
    res = {
      headersSent: false,
      writeHead(status, headers) { Object.assign(this, { status, headers, headersSent: true }); },
      end(data) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(data) }); },
    };
  });
  await vote(fakeVercelReq({ method: 'POST', body: { fragranceId: 'oud-wood' } }), res);
  const out = await done;
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.myVote, 'oud-wood');
  assert.match(out.headers['Set-Cookie'], /; Secure$/);
});

test('vercel functions explain a missing database', async () => {
  delete require.cache[require.resolve('../lib/vercel')];
  delete require.cache[require.resolve('../api/state')];
  const state = require('../api/state');
  const out = await new Promise((resolve) => {
    state(fakeVercelReq({ method: 'GET' }), {
      writeHead(status) { this.status = status; },
      end(data) { resolve({ status: this.status, body: JSON.parse(data) }); },
    });
  });
  assert.strictEqual(out.status, 500);
  assert.match(out.body.error, /Upstash Redis/);
});
