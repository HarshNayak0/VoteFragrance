'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { createMemoryStore } = require('../lib/stores');
const { addDays } = require('../lib/challenge');

const NOW = new Date('2026-10-09T15:00:00Z');
const GOOD = { workoutMin: 50, steps: 12000, deficit: 400, frenchMin: 15 };

async function start(t, { now = NOW, adminPassword = 'hunter2' } = {}) {
  const store = createMemoryStore();
  const server = createApp({ store, adminPassword, now: () => now });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  // A tiny cookie-keeping client, one per simulated person.
  function client() {
    const jar = {};
    return async (path, { method = 'GET', body, raw } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  }
  return { base, store, client };
}

async function admin(client) {
  const a = client();
  assert.strictEqual((await a('/api/admin/session', { method: 'POST', body: { password: 'hunter2' } })).status, 200);
  return a;
}

test('serves both pages', async (t) => {
  const { base } = await start(t);
  for (const path of ['/', '/admin']) {
    const res = await fetch(base + path);
    assert.strictEqual(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.notStrictEqual((await fetch(`${base}/%2e%2e/package.json`)).status, 200);
});

test('admin routes need the password', async (t) => {
  const { client } = await start(t);
  const visitor = client();
  assert.strictEqual((await visitor('/api/admin/data')).status, 401);
  assert.strictEqual((await visitor('/api/admin/day', { method: 'PUT', body: { date: '2026-10-09', ...GOOD } })).status, 401);
  assert.strictEqual((await visitor('/api/admin/session', { method: 'POST', body: { password: 'nope' } })).status, 401);

  const a = await admin(client);
  assert.strictEqual((await a('/api/admin/data')).status, 200);
  await a('/api/admin/session', { method: 'DELETE' });
  assert.strictEqual((await a('/api/admin/data')).status, 401);
});

test('admin is locked when no password is configured', async (t) => {
  const { client } = await start(t, { adminPassword: '' });
  const c = client();
  assert.deepStrictEqual((await c('/api/admin/session')).body, { configured: false, authenticated: false });
  assert.strictEqual((await c('/api/admin/session', { method: 'POST', body: { password: '' } })).status, 503);
});

test('login attempts are rate limited', async (t) => {
  const { client } = await start(t);
  const c = client();
  for (let i = 0; i < 10; i++) await c('/api/admin/session', { method: 'POST', body: { password: 'wrong' } });
  assert.strictEqual((await c('/api/admin/session', { method: 'POST', body: { password: 'hunter2' } })).status, 429);
});

test('mutations must be JSON', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/vote`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"fragranceId":"x"}' });
  assert.strictEqual(res.status, 415);
});

test('logging days drives public progress', async (t) => {
  const { client } = await start(t);
  const a = await admin(client);
  assert.strictEqual((await a('/api/admin/settings', { method: 'PUT', body: { startDate: '2026-10-06', timeZone: 'America/New_York' } })).status, 200);
  for (const date of ['2026-10-06', '2026-10-07', '2026-10-08']) {
    assert.strictEqual((await a('/api/admin/day', { method: 'PUT', body: { date, ...GOOD, note: 'private' } })).status, 200);
  }
  assert.strictEqual((await a('/api/admin/day', { method: 'PUT', body: { date: '2026-10-10', ...GOOD } })).status, 400, 'future day');
  assert.strictEqual((await a('/api/admin/day', { method: 'PUT', body: { date: '2026-10-09', ...GOOD, steps: 'lots' } })).status, 400);

  const { body } = await client()('/api/state');
  assert.strictEqual(body.progress.streak, 3);
  assert.strictEqual(body.progress.today, '2026-10-09');
  assert.strictEqual(body.progress.todayStatus, 'pending');
  assert.ok(!JSON.stringify(body).includes('private'), 'notes stay private');

  assert.strictEqual((await a('/api/admin/settings', { method: 'PUT', body: { timeZone: 'Mars/Olympus' } })).status, 400);
});

test('voting, switching and the per-network cap', async (t) => {
  const { client } = await start(t);
  const a = await admin(client);
  const ids = [];
  for (const name of ['Aventus', 'Oud Wood']) {
    const res = await a('/api/admin/fragrances', { method: 'POST', body: { name, house: 'House', notes: 'a, b' } });
    assert.strictEqual(res.status, 201);
    ids.push(res.body.fragrance.id);
  }

  const v = client();
  await v('/api/state');
  let r = await v('/api/vote', { method: 'POST', body: { fragranceId: ids[0] } });
  assert.strictEqual(r.status, 200);
  r = await v('/api/vote', { method: 'POST', body: { fragranceId: ids[1] } });
  assert.strictEqual(r.body.total, 1);
  assert.strictEqual(r.body.fragrances.find((f) => f.id === ids[1]).votes, 1);
  assert.strictEqual((await v('/api/state')).body.myVote, ids[1]);
  assert.strictEqual((await v('/api/vote', { method: 'POST', body: { fragranceId: 'nope' } })).status, 400);

  for (let i = 0; i < 4; i++) assert.strictEqual((await client()('/api/vote', { method: 'POST', body: { fragranceId: ids[0] } })).status, 200);
  assert.strictEqual((await client()('/api/vote', { method: 'POST', body: { fragranceId: ids[0] } })).status, 429);
});

test('suggestions wait for approval, dedupe and are rate limited', async (t) => {
  const { client } = await start(t);
  const v = client();
  assert.strictEqual((await v('/api/suggest', { method: 'POST', body: { name: '' } })).status, 400);
  assert.strictEqual((await v('/api/suggest', { method: 'POST', body: { name: 'Terre', house: 'Hermès' } })).status, 201);
  assert.strictEqual((await v('/api/suggest', { method: 'POST', body: { name: 'terre', house: 'HERMÈS' } })).body.message, 'Already on the list. Thanks!');
  assert.strictEqual((await v('/api/state')).body.fragrances.length, 0, 'not on the ballot yet');

  const a = await admin(client);
  const pending = (await a('/api/admin/data')).body.fragrances.find((f) => f.status === 'pending');
  assert.strictEqual(pending.name, 'Terre');
  await a('/api/admin/fragrances', { method: 'PUT', body: { id: pending.id, status: 'approved' } });
  assert.strictEqual((await v('/api/state')).body.fragrances[0].name, 'Terre');

  await v('/api/suggest', { method: 'POST', body: { name: 'Third' } });
  assert.strictEqual((await v('/api/suggest', { method: 'POST', body: { name: 'Fourth' } })).status, 429);
});

test('finishing Day 75 closes voting and names the winner', async (t) => {
  const start75 = addDays('2026-10-09', -74);
  const { client, store } = await start(t);
  const a = await admin(client);
  await a('/api/admin/settings', { method: 'PUT', body: { startDate: start75, timeZone: 'UTC' } });
  const id = (await a('/api/admin/fragrances', { method: 'POST', body: { name: 'Layton' } })).body.fragrance.id;
  const v = client();
  await v('/api/vote', { method: 'POST', body: { fragranceId: id } });

  for (let i = 0; i < 74; i++) await store.putDay(addDays(start75, i), { ...GOOD });
  assert.strictEqual((await v('/api/state')).body.votingOpen, true);
  await a('/api/admin/day', { method: 'PUT', body: { date: '2026-10-09', ...GOOD } });

  const { body } = await v('/api/state');
  assert.strictEqual(body.progress.status, 'complete');
  assert.strictEqual(body.votingOpen, false);
  assert.deepStrictEqual(body.winners, [id]);
  assert.strictEqual((await client()('/api/vote', { method: 'POST', body: { fragranceId: id } })).status, 403);
});
