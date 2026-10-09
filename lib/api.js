'use strict';

const crypto = require('node:crypto');
const { computeProgress, todayIn, isValidDate, isValidTimeZone, parseDayEntry } = require('./challenge');

const VOTER_COOKIE = 'vf_voter';
const ADMIN_COOKIE = 'vf_admin';
const ONE_YEAR = 60 * 60 * 24 * 365;
const ADMIN_SESSION = 60 * 60 * 24 * 30;
const MAX_VOTERS_PER_NETWORK = 5;
const MAX_SUGGESTIONS_PER_DAY = 3;
const MAX_PENDING_SUGGESTIONS = 50;
const MAX_LOGIN_ATTEMPTS = 10; // per network per 15 minutes

const DEFAULT_SETTINGS = {
  title: 'Vote My Next Fragrance',
  tagline: '75 days of workouts, steps, discipline and French. When I finish, you pick the bottle I earn.',
  startDate: null,
  timeZone: 'UTC',
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

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

async function readJsonBody(req, limit = 8192) {
  // Mutations must be JSON: browsers can't send that cross-site without a
  // CORS preflight, which this API never grants. That blocks CSRF.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw httpError(415, 'Send JSON.');
  }
  // Vercel parses the body before the handler runs; plain Node does not.
  if (req.body !== undefined) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try {
      return JSON.parse(String(req.body) || '{}');
    } catch {
      throw httpError(400, 'Invalid JSON.');
    }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request too large.');
    chunks.push(c);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw httpError(400, 'Invalid JSON.');
  }
}

function cleanText(value, max, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw httpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw httpError(400, `${field} must be text.`);
  const v = value.replace(/\s+/g, ' ').trim();
  if (required && !v) throw httpError(400, `${field} is required.`);
  if (v.length > max) throw httpError(400, `${field} must be ${max} characters or fewer.`);
  return v;
}

function cleanNotes(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean)
    .slice(0, 6)
    .map((n) => n.slice(0, 30));
}

const sameFragrance = (a, b) =>
  a.name.toLowerCase() === b.name.toLowerCase() && (a.house || '').toLowerCase() === (b.house || '').toLowerCase();

// Builds the handler behind every /api route. Shared by the Vercel functions
// (api/**.js) and the local development server (server.js).
function createApi({
  store,
  adminPassword = process.env.ADMIN_PASSWORD || '',
  sessionSecret = process.env.SESSION_SECRET || '',
  secure = false, // behind HTTPS + a proxy (Vercel): trust X-Forwarded-For, mark cookies Secure
  ipSalt = process.env.IP_SALT || 'vote-fragrance',
  now = () => new Date(),
}) {
  const signingKey = sessionSecret || adminPassword;
  const secureAttr = secure ? '; Secure' : '';

  function ipHash(req) {
    const forwarded = secure && req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || 'unknown';
    return crypto.createHash('sha256').update(ipSalt + ip).digest('hex').slice(0, 32);
  }

  function voter(req) {
    const existing = parseCookies(req.headers.cookie)[VOTER_COOKIE];
    if (existing && /^[a-f0-9-]{36}$/.test(existing)) return { id: existing, headers: {} };
    const id = crypto.randomUUID();
    return { id, headers: { 'Set-Cookie': `${VOTER_COOKIE}=${id}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secureAttr}` } };
  }

  // --- admin sessions: "<expiry>.<hmac>" signed with the session secret ---
  const sign = (exp) => crypto.createHmac('sha256', signingKey).update(`admin:${exp}`).digest('hex');
  const safeEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };
  function isAdmin(req) {
    if (!adminPassword) return false;
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE] || '';
    const [exp, sig] = token.split('.');
    return Boolean(exp && sig) && Number(exp) > now().getTime() && safeEqual(sig, sign(exp));
  }
  function requireAdmin(req) {
    if (!adminPassword) throw httpError(503, 'Set ADMIN_PASSWORD in your Vercel project settings, then redeploy.');
    if (!isAdmin(req)) throw httpError(401, 'Log in first.');
  }

  async function loadState() {
    const [stored, days, fragrances, counts] = await Promise.all([
      store.getSettings(),
      store.listDays(),
      store.listFragrances(),
      store.tally(),
    ]);
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    const progress = computeProgress({ startDate: settings.startDate, today: todayIn(settings.timeZone, now()), days });
    const lineup = fragrances
      .filter((f) => f.status === 'approved')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((f) => ({ id: f.id, name: f.name, house: f.house, notes: f.notes, vibe: f.vibe, votes: counts[f.id] || 0 }));
    const total = lineup.reduce((sum, f) => sum + f.votes, 0);
    const votingOpen = progress.status !== 'complete';
    const top = Math.max(0, ...lineup.map((f) => f.votes));
    const winners = !votingOpen && top > 0 ? lineup.filter((f) => f.votes === top).map((f) => f.id) : [];
    return { settings, progress, fragrances, lineup, total, votingOpen, winners };
  }

  const routes = {
    'GET /api/state': async (req) => {
      const v = voter(req);
      const [state, myVote] = await Promise.all([loadState(), store.getVote(v.id)]);
      return [200, {
        title: state.settings.title,
        tagline: state.settings.tagline,
        progress: state.progress,
        fragrances: state.lineup,
        total: state.total,
        votingOpen: state.votingOpen,
        winners: state.winners,
        myVote: state.lineup.some((f) => f.id === myVote) ? myVote : null,
      }, v.headers];
    },

    'POST /api/vote': async (req) => {
      const v = voter(req);
      const body = await readJsonBody(req);
      const state = await loadState();
      if (!state.votingOpen) throw httpError(403, 'Voting is closed. The challenge is complete!');
      if (!state.lineup.some((f) => f.id === body.fragranceId)) throw httpError(400, 'That fragrance is not on the ballot.');
      const net = ipHash(req);
      const previous = await store.getVote(v.id);
      if (!previous && (await store.votersForIp(net)) >= MAX_VOTERS_PER_NETWORK) {
        throw httpError(429, 'Too many people have voted from this network.');
      }
      await store.castVote(v.id, body.fragranceId, net);
      const counts = await store.tally();
      const fragrances = state.lineup.map((f) => ({ ...f, votes: counts[f.id] || 0 }));
      return [200, { myVote: body.fragranceId, fragrances, total: fragrances.reduce((s, f) => s + f.votes, 0) }, v.headers];
    },

    'POST /api/suggest': async (req) => {
      const body = await readJsonBody(req);
      const suggestion = {
        name: cleanText(body.name, 80, 'Fragrance name', { required: true }),
        house: cleanText(body.house, 60, 'Brand'),
      };
      if ((await store.hit(`suggest:${ipHash(req)}`, 60 * 60 * 24)) > MAX_SUGGESTIONS_PER_DAY) {
        throw httpError(429, `You can suggest up to ${MAX_SUGGESTIONS_PER_DAY} fragrances a day.`);
      }
      const all = await store.listFragrances();
      if (all.some((f) => sameFragrance(f, suggestion))) return [200, { ok: true, message: 'Already on the list. Thanks!' }];
      if (all.filter((f) => f.status === 'pending').length >= MAX_PENDING_SUGGESTIONS) {
        throw httpError(429, 'The suggestion box is full right now. Try again later.');
      }
      await store.putFragrance({
        id: crypto.randomUUID().slice(0, 8),
        ...suggestion,
        notes: [],
        vibe: '',
        status: 'pending',
        suggested: true,
        createdAt: now().toISOString(),
      });
      return [201, { ok: true, message: 'Thanks! Your suggestion will appear once it is approved.' }];
    },

    // ---------- admin ----------
    'GET /api/admin/session': async (req) => [200, { configured: Boolean(adminPassword), authenticated: isAdmin(req) }],

    'POST /api/admin/session': async (req) => {
      if (!adminPassword) throw httpError(503, 'Set ADMIN_PASSWORD in your Vercel project settings, then redeploy.');
      const body = await readJsonBody(req);
      if ((await store.hit(`login:${ipHash(req)}`, 15 * 60)) > MAX_LOGIN_ATTEMPTS) {
        throw httpError(429, 'Too many attempts. Wait 15 minutes and try again.');
      }
      if (typeof body.password !== 'string' || !safeEqual(body.password, adminPassword)) {
        throw httpError(401, 'Wrong password.');
      }
      const exp = String(now().getTime() + ADMIN_SESSION * 1000);
      const cookie = `${ADMIN_COOKIE}=${exp}.${sign(exp)}; Path=/api/admin; Max-Age=${ADMIN_SESSION}; HttpOnly; SameSite=Strict${secureAttr}`;
      return [200, { authenticated: true }, { 'Set-Cookie': cookie }];
    },

    'DELETE /api/admin/session': async () => [
      200,
      { authenticated: false },
      { 'Set-Cookie': `${ADMIN_COOKIE}=; Path=/api/admin; Max-Age=0; HttpOnly; SameSite=Strict${secureAttr}` },
    ],

    'GET /api/admin/data': async (req) => {
      requireAdmin(req);
      const [state, days] = await Promise.all([loadState(), store.listDays()]);
      const counts = Object.fromEntries(state.lineup.map((f) => [f.id, f.votes]));
      return [200, {
        settings: state.settings,
        progress: state.progress,
        days,
        fragrances: state.fragrances
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((f) => ({ ...f, votes: counts[f.id] || 0 })),
      }];
    },

    'PUT /api/admin/day': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await store.getSettings()) };
      if (!isValidDate(body.date)) throw httpError(400, 'Pick a valid date.');
      if (body.date > todayIn(settings.timeZone, now())) throw httpError(400, "You can't log a day that hasn't happened yet.");
      const { entry, error } = parseDayEntry(body);
      if (error) throw httpError(400, error);
      await store.putDay(body.date, entry);
      return [200, { ok: true }];
    },

    'DELETE /api/admin/day': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      if (!isValidDate(body.date)) throw httpError(400, 'Pick a valid date.');
      await store.deleteDay(body.date);
      return [200, { ok: true }];
    },

    'POST /api/admin/fragrances': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const f = {
        id: crypto.randomUUID().slice(0, 8),
        name: cleanText(body.name, 80, 'Fragrance name', { required: true }),
        house: cleanText(body.house, 60, 'Brand'),
        notes: cleanNotes(body.notes),
        vibe: cleanText(body.vibe, 160, 'Description'),
        status: 'approved',
        suggested: false,
        createdAt: now().toISOString(),
      };
      await store.putFragrance(f);
      return [201, { fragrance: f }];
    },

    'PUT /api/admin/fragrances': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const existing = (await store.listFragrances()).find((f) => f.id === body.id);
      if (!existing) throw httpError(404, 'That fragrance no longer exists.');
      const f = {
        ...existing,
        name: cleanText(body.name ?? existing.name, 80, 'Fragrance name', { required: true }),
        house: cleanText(body.house ?? existing.house, 60, 'Brand'),
        notes: body.notes === undefined ? existing.notes : cleanNotes(body.notes),
        vibe: cleanText(body.vibe ?? existing.vibe, 160, 'Description'),
        status: body.status === 'approved' || body.status === 'pending' ? body.status : existing.status,
      };
      await store.putFragrance(f);
      return [200, { fragrance: f }];
    },

    'DELETE /api/admin/fragrances': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      if (typeof body.id !== 'string') throw httpError(400, 'Missing fragrance id.');
      await store.deleteFragrance(body.id);
      return [200, { ok: true }];
    },

    'PUT /api/admin/settings': async (req) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const current = { ...DEFAULT_SETTINGS, ...(await store.getSettings()) };
      const next = {
        title: cleanText(body.title ?? current.title, 80, 'Title', { required: true }),
        tagline: cleanText(body.tagline ?? current.tagline, 240, 'Tagline'),
        startDate: body.startDate === undefined ? current.startDate : body.startDate || null,
        timeZone: body.timeZone ?? current.timeZone,
      };
      if (next.startDate !== null && !isValidDate(next.startDate)) throw httpError(400, 'Pick a valid start date.');
      if (!isValidTimeZone(next.timeZone)) throw httpError(400, 'Pick a valid time zone.');
      await store.saveSettings(next);
      return [200, { settings: next }];
    },
  };

  return async function handleApi(req, res, pathname) {
    try {
      const route = routes[`${req.method} ${pathname}`];
      if (!route) throw httpError(pathname in KNOWN_PATHS ? 405 : 404, 'Not found.');
      const [status, body, headers] = await route(req);
      sendJson(res, status, body, headers);
    } catch (err) {
      if (!err.status) console.error(err);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong. Try again.' });
    }
  };
}

const KNOWN_PATHS = Object.fromEntries(
  ['/api/state', '/api/vote', '/api/suggest', '/api/admin/session', '/api/admin/data', '/api/admin/day', '/api/admin/fragrances', '/api/admin/settings'].map((p) => [p, true]),
);

module.exports = { createApi, DEFAULT_SETTINGS };
