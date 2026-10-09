'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const VOTER_COOKIE = 'vf_voter';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function loadConfig(configPath) {
  // require() for the default lets Vercel's bundler see and ship config.json.
  const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : require('../config.json');
  const ids = new Set();
  for (const f of config.fragrances) {
    if (!f.id || ids.has(f.id)) throw new Error(`Fragrance ids must be unique and non-empty (got "${f.id}")`);
    ids.add(f.id);
  }
  return config;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readJsonBody(req, limit = 4096) {
  // Vercel parses the body before the handler runs; plain Node does not.
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) return req.body;
    try {
      return JSON.parse(String(req.body) || '{}');
    } catch {
      throw httpError(400, 'Invalid JSON');
    }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

// Builds the request handler for /api/state and /api/vote. Shared by the local
// server (server.js) and the Vercel functions (api/*.js).
function createApi({
  config = loadConfig(),
  store,
  trustProxy = false,
  ipSalt = process.env.IP_SALT || 'vote-fragrance',
  now = () => new Date(),
}) {
  const fragranceIds = new Set(config.fragrances.map((f) => f.id));

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  const votingOpen = () => !config.votingClosesAt || now() < new Date(config.votingClosesAt);

  async function results() {
    const counts = await store.tally();
    const tally = config.fragrances
      .map((f) => ({ id: f.id, votes: counts[f.id] || 0 }))
      .sort((a, b) => b.votes - a.votes);
    return { total: tally.reduce((sum, r) => sum + r.votes, 0), results: tally };
  }

  function voterCookie(req) {
    const existing = parseCookies(req.headers.cookie)[VOTER_COOKIE];
    if (existing && /^[a-f0-9-]{36}$/.test(existing)) return { id: existing, headers: {} };
    const id = crypto.randomUUID();
    const secure = trustProxy ? '; Secure' : '';
    const cookie = `${VOTER_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
    return { id, headers: { 'Set-Cookie': cookie } };
  }

  async function route(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/state') {
      const voter = voterCookie(req);
      const { title, subtitle, tagline, challengeStartDate, challengeDays, votingClosesAt, fragrances } = config;
      const [myVote, tally] = await Promise.all([store.getVote(voter.id), results()]);
      return sendJson(
        res,
        200,
        {
          title, subtitle, tagline, challengeStartDate, challengeDays, votingClosesAt, fragrances,
          votingOpen: votingOpen(),
          myVote,
          ...tally,
        },
        voter.headers,
      );
    }

    if (req.method === 'POST' && pathname === '/api/vote') {
      const voter = voterCookie(req);
      if (!votingOpen()) return sendJson(res, 403, { error: 'Voting is closed.' }, voter.headers);

      const body = await readJsonBody(req);
      if (typeof body.fragranceId !== 'string' || !fragranceIds.has(body.fragranceId)) {
        return sendJson(res, 400, { error: 'Unknown fragrance.' }, voter.headers);
      }

      const ipHash = crypto.createHash('sha256').update(ipSalt + clientIp(req)).digest('hex');
      const isNewVoter = !(await store.getVote(voter.id));
      if (isNewVoter && config.maxVotersPerIp && (await store.votersForIp(ipHash)) >= config.maxVotersPerIp) {
        return sendJson(res, 429, { error: 'Too many votes from this network.' }, voter.headers);
      }

      await store.castVote(voter.id, body.fragranceId, ipHash);
      return sendJson(res, 200, { myVote: body.fragranceId, ...(await results()) }, voter.headers);
    }

    return sendJson(res, 404, { error: 'Not found.' });
  }

  return async function handleApi(req, res, pathname) {
    try {
      await route(req, res, pathname);
    } catch (err) {
      if (!err.status) console.error(err);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
    }
  };
}

module.exports = { createApi, loadConfig };
