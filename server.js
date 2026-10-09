'use strict';

// Local development / self-hosting server. On Vercel, api/*.js serve the API
// and public/ is served as static files instead.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApi, loadConfig } = require('./lib/api');
const { createFileStore, createRedisStore, redisConfigFromEnv } = require('./lib/stores');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createApp({
  configPath,
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  trustProxy = process.env.TRUST_PROXY === '1',
  store,
  now,
} = {}) {
  const redis = redisConfigFromEnv();
  const handleApi = createApi({
    config: loadConfig(configPath),
    store: store || (redis ? createRedisStore(redis) : createFileStore(dataDir)),
    trustProxy,
    now,
  });

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
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Vote My Next Fragrance running on http://localhost:${port}`));
}

module.exports = { createApp };
