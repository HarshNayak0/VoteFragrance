# Vote My Next Fragrance

A tiny website where anyone can vote on the cologne I buy after finishing **75 Hard: Cologne Edition**.

- Shows the 75-day challenge progress bar
- One vote per person (cookie-based), changeable until voting closes
- Live results appear after you vote and refresh every 15 seconds
- Light and dark mode, works on phones
- Zero dependencies: plain Node.js. Runs on Vercel with Upstash Redis, or locally with a JSON file

## Run it locally

```bash
npm start            # http://localhost:3000
npm test
```

Node 18+ required. Nothing to install.

## Customize

Everything lives in [`config.json`](config.json):

| Field | What it does |
| --- | --- |
| `challengeStartDate` | Day 1 of your 75 Hard (`YYYY-MM-DD`). Drives the progress bar. |
| `challengeDays` | Length of the challenge (75). |
| `votingClosesAt` | ISO timestamp to lock voting, e.g. `"2026-12-15T23:59:00-05:00"`. `null` keeps it open. |
| `maxVotersPerIp` | Caps how many different voters can come from one network, to slow down ballot stuffing. `0` disables. |
| `fragrances` | The lineup. Each needs a unique `id`; `name`, `house`, `notes` and `vibe` are shown on the card. |

Don't rename or remove an `id` after votes come in: votes for it would stop counting.

## Put it online (Vercel)

1. Push this repo to GitHub, then in Vercel choose **Add New → Project** and import it. Leave every build setting at its default; `vercel.json` already handles them.
2. In the project, open **Storage → Create Database → Upstash (Redis)**, use the free plan, and connect it to the project. Vercel adds the database keys to the project automatically.
3. Redeploy (**Deployments → ⋯ → Redeploy**) so the functions pick up the keys.

That's it. Share the `*.vercel.app` URL, or add your own domain under **Settings → Domains**.

How it fits together on Vercel: `public/` is served as the static site, and `api/state.js` and `api/vote.js` run as serverless functions that keep votes in Redis. If the site says "No database connected", step 2 or 3 was skipped.

Locally, `npm start` stores votes in `data/votes.json` instead, unless you set the Redis variables below.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Local server only: where `votes.json` is written |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | none | Upstash Redis credentials. Vercel sets these when you connect the database (the older `UPSTASH_REDIS_REST_URL`/`_TOKEN` names also work). |
| `TRUST_PROXY` | off | Local server only: set to `1` behind a proxy so the real client IP is used and cookies are `Secure`. Always on for Vercel. |
| `IP_SALT` | `vote-fragrance` | Salt for hashing IPs (raw IPs are never stored) |

## Peeking at the raw votes

`GET /api/state` returns the full tally. On Vercel you can also browse the `vf:counts` hash in the Upstash console.
