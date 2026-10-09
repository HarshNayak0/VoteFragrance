'use strict';

// Local development server. On Vercel, public/ is served as static files and
// api/**.js run as functions instead; both share lib/api.js.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('./lib/api');
const { createMemoryStore, createRedisStore, redisConfigFromEnv } = require('./lib/stores');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createApp({ store, adminPassword, now } = {}) {
  const redis = redisConfigFromEnv();
  const handleApi = createApi({
    store: store || (redis ? createRedisStore(redis) : createMemoryStore(path.join(__dirname, 'data'))),
    ...(adminPassword !== undefined && { adminPassword }),
    ...(now && { now }),
  });

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    // Mirror Vercel's cleanUrls: /admin serves admin.html.
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!path.extname(rel)) rel += '.html';
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

  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  });
}

if (require.main === module) {
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the admin page will be locked. Try ADMIN_PASSWORD=dev npm start');
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Running on http://localhost:${port} (admin: http://localhost:${port}/admin)`));
}

module.exports = { createApp };
