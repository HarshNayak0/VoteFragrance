'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const VOTER_COOKIE = 'vf_voter';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function loadConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const ids = new Set();
  for (const f of config.fragrances) {
    if (!f.id || ids.has(f.id)) throw new Error(`Fragrance ids must be unique and non-empty (got "${f.id}")`);
    ids.add(f.id);
  }
  return config;
}

// Votes live in a single JSON file. Writes go through a temp file + rename so
// a crash mid-write never leaves a corrupt store behind.
function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'votes.json');
  let state = { voters: {} };
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  return {
    getVote: (voterId) => state.voters[voterId] || null,
    votersForIp: (ipHash) => Object.values(state.voters).filter((v) => v.ipHash === ipHash).length,
    castVote(voterId, fragranceId, ipHash) {
      state.voters[voterId] = { fragranceId, ipHash, at: new Date().toISOString() };
      save();
    },
    tally() {
      const counts = {};
      for (const v of Object.values(state.voters)) counts[v.fragranceId] = (counts[v.fragranceId] || 0) + 1;
      return counts;
    },
  };
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
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createApp({
  configPath = path.join(__dirname, 'config.json'),
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  trustProxy = process.env.TRUST_PROXY === '1',
  ipSalt = process.env.IP_SALT || 'vote-fragrance',
  now = () => new Date(),
} = {}) {
  const config = loadConfig(configPath);
  const store = createStore(dataDir);
  const fragranceIds = new Set(config.fragrances.map((f) => f.id));

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  }

  function votingOpen() {
    return !config.votingClosesAt || now() < new Date(config.votingClosesAt);
  }

  function results() {
    const counts = store.tally();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      total,
      results: config.fragrances
        .map((f) => ({ id: f.id, votes: counts[f.id] || 0 }))
        .sort((a, b) => b.votes - a.votes),
    };
  }

  function voterCookie(req) {
    const existing = parseCookies(req.headers.cookie)[VOTER_COOKIE];
    if (existing && /^[a-f0-9-]{36}$/.test(existing)) return { id: existing, setCookie: null };
    const id = crypto.randomUUID();
    const secure = trustProxy ? '; Secure' : '';
    return { id, setCookie: `${VOTER_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax${secure}` };
  }

  async function handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/state') {
      const voter = voterCookie(req);
      const vote = store.getVote(voter.id);
      const { title, subtitle, tagline, challengeStartDate, challengeDays, votingClosesAt, fragrances } = config;
      return sendJson(
        res,
        200,
        {
          title, subtitle, tagline, challengeStartDate, challengeDays, votingClosesAt, fragrances,
          votingOpen: votingOpen(),
          myVote: vote ? vote.fragranceId : null,
          ...results(),
        },
        voter.setCookie ? { 'Set-Cookie': voter.setCookie } : {},
      );
    }

    if (req.method === 'POST' && pathname === '/api/vote') {
      const voter = voterCookie(req);
      const cookieHeader = voter.setCookie ? { 'Set-Cookie': voter.setCookie } : {};
      if (!votingOpen()) return sendJson(res, 403, { error: 'Voting is closed.' }, cookieHeader);

      const body = await readJsonBody(req);
      if (typeof body.fragranceId !== 'string' || !fragranceIds.has(body.fragranceId)) {
        return sendJson(res, 400, { error: 'Unknown fragrance.' }, cookieHeader);
      }

      const ipHash = crypto.createHash('sha256').update(ipSalt + clientIp(req)).digest('hex');
      const isNewVoter = !store.getVote(voter.id);
      if (isNewVoter && config.maxVotersPerIp && store.votersForIp(ipHash) >= config.maxVotersPerIp) {
        return sendJson(res, 429, { error: 'Too many votes from this network.' }, cookieHeader);
      }

      store.castVote(voter.id, body.fragranceId, ipHash);
      return sendJson(res, 200, { myVote: body.fragranceId, ...results() }, cookieHeader);
    }

    return sendJson(res, 404, { error: 'Not found.' });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  return http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
      if (!err.status) console.error(err);
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Vote My Next Fragrance running on http://localhost:${port}`));
}

module.exports = { createApp };
