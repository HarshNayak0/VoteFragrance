'use strict';

const { createApi } = require('./api');
const { createRedisStore, redisConfigFromEnv } = require('./stores');

let handleApi = null;

// Shared entry point for the Vercel functions in api/. Built lazily so a
// missing database shows up as a clear error instead of a crashed function.
module.exports = function vercelRoute(pathname) {
  return (req, res) => {
    if (!handleApi) {
      const redis = redisConfigFromEnv();
      if (!redis) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'No database connected. Add Upstash Redis in the Vercel Storage tab, then redeploy.' }));
      }
      handleApi = createApi({ store: createRedisStore(redis), secure: true });
    }
    return handleApi(req, res, pathname);
  };
};
