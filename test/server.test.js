'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function start(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  const configPath = path.join(dir, 'config.json');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...base, ...overrides }));
  const server = createApp({ configPath, dataDir: path.join(dir, 'data') });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const url = `http://localhost:${server.address().port}`;
  return { url, dir, configPath };
}

function voterCookie(res) {
  return res.headers.get('set-cookie').split(';')[0];
}

async function vote(url, cookie, fragranceId) {
  const res = await fetch(`${url}/api/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ fragranceId }),
  });
  return { res, body: await res.json() };
}

test('serves the page and initial state', async (t) => {
  const { url } = await start(t);
  const page = await fetch(url);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Vote My Next Fragrance/);

  const res = await fetch(`${url}/api/state`);
  const state = await res.json();
  assert.ok(state.fragrances.length > 0);
  assert.strictEqual(state.total, 0);
  assert.strictEqual(state.myVote, null);
  assert.ok(voterCookie(res).startsWith('vf_voter='));
});

test('one vote per voter, changing a vote moves it', async (t) => {
  const { url } = await start(t);
  const cookie = voterCookie(await fetch(`${url}/api/state`));

  let { body } = await vote(url, cookie, 'aventus');
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.myVote, 'aventus');

  ({ body } = await vote(url, cookie, 'oud-wood'));
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.results[0].id, 'oud-wood');

  const state = await (await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).json();
  assert.strictEqual(state.myVote, 'oud-wood');
});

test('votes persist across restarts', async (t) => {
  const { url, dir, configPath } = await start(t);
  const cookie = voterCookie(await fetch(`${url}/api/state`));
  await vote(url, cookie, 'layton');

  const again = createApp({ configPath, dataDir: path.join(dir, 'data') });
  await new Promise((r) => again.listen(0, r));
  t.after(() => again.close());
  const state = await (await fetch(`http://localhost:${again.address().port}/api/state`)).json();
  assert.strictEqual(state.total, 1);
});

test('rejects unknown fragrances and bad JSON', async (t) => {
  const { url } = await start(t);
  assert.strictEqual((await vote(url, null, 'nope')).res.status, 400);
  const res = await fetch(`${url}/api/vote`, { method: 'POST', body: '{bad' });
  assert.strictEqual(res.status, 400);
});

test('caps distinct voters per network', async (t) => {
  const { url } = await start(t, { maxVotersPerIp: 2 });
  assert.strictEqual((await vote(url, null, 'aventus')).res.status, 200);
  assert.strictEqual((await vote(url, null, 'aventus')).res.status, 200);
  assert.strictEqual((await vote(url, null, 'aventus')).res.status, 429);
});

test('refuses votes after voting closes', async (t) => {
  const { url } = await start(t, { votingClosesAt: '2000-01-01T00:00:00Z' });
  const { res } = await vote(url, null, 'aventus');
  assert.strictEqual(res.status, 403);
});

test('blocks path traversal', async (t) => {
  const { url } = await start(t);
  const res = await fetch(`${url}/%2e%2e/config.json`);
  assert.notStrictEqual(res.status, 200);
});
