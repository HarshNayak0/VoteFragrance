'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Both stores expose the same async interface:
//   getSettings() / saveSettings(settings)
//   listFragrances() / putFragrance(f) / deleteFragrance(id)
//   getVote(voterId) / castVote(voterId, fragranceId, ipHash) / votersForIp(ipHash) / tally()
//   listDays() / putDay(date, entry) / deleteDay(date)
//   hit(key, windowSeconds) -> number of hits on key inside the window (rate limiting)

// Local development and tests. Pass a dataDir to keep data in a JSON file
// between restarts; without one everything lives in memory.
function createMemoryStore(dataDir) {
  const file = dataDir ? path.join(dataDir, 'store.json') : null;
  let s = { settings: {}, fragrances: {}, votes: {}, voterIps: {}, days: {}, hits: {} };
  if (file && fs.existsSync(file)) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) };

  function save() {
    if (!file) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }

  return {
    async getSettings() { return { ...s.settings }; },
    async saveSettings(settings) { s.settings = { ...settings }; save(); },

    async listFragrances() { return Object.values(s.fragrances); },
    async putFragrance(f) { s.fragrances[f.id] = f; save(); },
    async deleteFragrance(id) { delete s.fragrances[id]; save(); },

    async getVote(voterId) { return s.votes[voterId] || null; },
    async castVote(voterId, fragranceId, ipHash) {
      s.votes[voterId] = fragranceId;
      (s.voterIps[ipHash] ||= []).includes(voterId) || s.voterIps[ipHash].push(voterId);
      save();
    },
    async votersForIp(ipHash) { return (s.voterIps[ipHash] || []).length; },
    async tally() {
      const counts = {};
      for (const id of Object.values(s.votes)) counts[id] = (counts[id] || 0) + 1;
      return counts;
    },

    async listDays() { return { ...s.days }; },
    async putDay(date, entry) { s.days[date] = entry; save(); },
    async deleteDay(date) { delete s.days[date]; save(); },

    async hit(key, windowSeconds) {
      const now = Date.now();
      const h = s.hits[key];
      if (!h || h.until < now) s.hits[key] = { count: 1, until: now + windowSeconds * 1000 };
      else h.count++;
      return s.hits[key].count;
    },
  };
}

// Vercel: Upstash Redis over its REST API, so no client library is needed.
//   vf:settings     string  JSON settings
//   vf:fragrances   hash    id -> JSON fragrance
//   vf:votes        hash    voterId -> fragranceId
//   vf:counts       hash    fragranceId -> vote count
//   vf:ip:<hash>    set     voterIds seen from one network
//   vf:days         hash    YYYY-MM-DD -> JSON day log
//   vf:hit:<key>    counter rate-limit window
const MOVE_VOTE = `
  local prev = redis.call('HGET', KEYS[1], ARGV[1])
  if prev == ARGV[2] then return 0 end
  if prev then redis.call('HINCRBY', KEYS[2], prev, -1) end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
  return 1`;

function createRedisStore({ url, token }) {
  async function pipeline(commands) {
    const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Redis request failed with HTTP ${res.status}`);
    const replies = await res.json();
    const failed = replies.find((r) => r.error);
    if (failed) throw new Error(`Redis error: ${failed.error}`);
    return replies.map((r) => r.result);
  }
  const one = async (...command) => (await pipeline([command]))[0];

  function pairs(flat) {
    const out = {};
    for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }

  return {
    async getSettings() {
      const raw = await one('GET', 'vf:settings');
      return raw ? JSON.parse(raw) : {};
    },
    async saveSettings(settings) { await one('SET', 'vf:settings', JSON.stringify(settings)); },

    async listFragrances() {
      return Object.values(pairs(await one('HGETALL', 'vf:fragrances'))).map((v) => JSON.parse(v));
    },
    async putFragrance(f) { await one('HSET', 'vf:fragrances', f.id, JSON.stringify(f)); },
    async deleteFragrance(id) { await one('HDEL', 'vf:fragrances', id); },

    async getVote(voterId) { return (await one('HGET', 'vf:votes', voterId)) || null; },
    async castVote(voterId, fragranceId, ipHash) {
      await pipeline([
        ['EVAL', MOVE_VOTE, '2', 'vf:votes', 'vf:counts', voterId, fragranceId],
        ['SADD', `vf:ip:${ipHash}`, voterId],
      ]);
    },
    async votersForIp(ipHash) { return Number(await one('SCARD', `vf:ip:${ipHash}`)) || 0; },
    async tally() {
      const counts = {};
      for (const [id, n] of Object.entries(pairs(await one('HGETALL', 'vf:counts')))) {
        if (Number(n) > 0) counts[id] = Number(n);
      }
      return counts;
    },

    async listDays() {
      const out = {};
      for (const [date, v] of Object.entries(pairs(await one('HGETALL', 'vf:days')))) out[date] = JSON.parse(v);
      return out;
    },
    async putDay(date, entry) { await one('HSET', 'vf:days', date, JSON.stringify(entry)); },
    async deleteDay(date) { await one('HDEL', 'vf:days', date); },

    async hit(key, windowSeconds) {
      const k = `vf:hit:${key}`;
      const [count] = await pipeline([['INCR', k]]);
      if (Number(count) === 1) await one('EXPIRE', k, String(windowSeconds));
      return Number(count);
    },
  };
}

// Vercel's Upstash integration has used both naming schemes over time.
function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

module.exports = { createMemoryStore, createRedisStore, redisConfigFromEnv };
