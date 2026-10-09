'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Every store exposes the same async interface:
//   getVote(voterId) -> fragranceId | null
//   votersForIp(ipHash) -> number of distinct voters seen from that network
//   castVote(voterId, fragranceId, ipHash)
//   tally() -> { fragranceId: count }

// Local development and self-hosting: one JSON file. Writes go through a temp
// file + rename so a crash mid-write never leaves a corrupt store behind.
function createFileStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'votes.json');
  let state = { voters: {} };
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  return {
    async getVote(voterId) {
      const v = state.voters[voterId];
      return v ? v.fragranceId : null;
    },
    async votersForIp(ipHash) {
      return Object.values(state.voters).filter((v) => v.ipHash === ipHash).length;
    },
    async castVote(voterId, fragranceId, ipHash) {
      state.voters[voterId] = { fragranceId, ipHash, at: new Date().toISOString() };
      save();
    },
    async tally() {
      const counts = {};
      for (const v of Object.values(state.voters)) counts[v.fragranceId] = (counts[v.fragranceId] || 0) + 1;
      return counts;
    },
  };
}

// Vercel: Upstash Redis over its REST API, so no client library is needed.
//   vf:votes        hash   voterId -> fragranceId
//   vf:counts       hash   fragranceId -> vote count
//   vf:ip:<hash>    set    voterIds seen from one network
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

  return {
    async getVote(voterId) {
      const [fragranceId] = await pipeline([['HGET', 'vf:votes', voterId]]);
      return fragranceId || null;
    },
    async votersForIp(ipHash) {
      const [n] = await pipeline([['SCARD', `vf:ip:${ipHash}`]]);
      return Number(n) || 0;
    },
    async castVote(voterId, fragranceId, ipHash) {
      // Move the vote atomically: the Lua script reads the previous pick and
      // adjusts both counters in one step, so concurrent votes can't drift.
      const script = `
        local prev = redis.call('HGET', KEYS[1], ARGV[1])
        if prev == ARGV[2] then return 0 end
        if prev then redis.call('HINCRBY', KEYS[2], prev, -1) end
        redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
        redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
        return 1`;
      await pipeline([
        ['EVAL', script, '2', 'vf:votes', 'vf:counts', voterId, fragranceId],
        ['SADD', `vf:ip:${ipHash}`, voterId],
      ]);
    },
    async tally() {
      const [flat] = await pipeline([['HGETALL', 'vf:counts']]);
      const counts = {};
      for (let i = 0; i < (flat || []).length; i += 2) {
        const n = Number(flat[i + 1]);
        if (n > 0) counts[flat[i]] = n;
      }
      return counts;
    },
  };
}

// Vercel's Upstash integration has used both naming schemes over time.
function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

module.exports = { createFileStore, createRedisStore, redisConfigFromEnv };
