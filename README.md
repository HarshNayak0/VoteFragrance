# Vote My Next Fragrance

A tiny website where anyone can vote on the cologne I buy after finishing **75 Hard: Cologne Edition**.

- Shows the 75-day challenge progress bar
- One vote per person (cookie-based), changeable until voting closes
- Live results appear after you vote and refresh every 15 seconds
- Light and dark mode, works on phones
- Zero dependencies: plain Node.js, votes stored in a JSON file

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

## Put it online

The site needs a server with a persistent disk so votes survive restarts.

**Render (easiest):** push this repo to GitHub, then in Render choose *New → Blueprint* and pick the repo.
`render.yaml` sets up the service and a 1 GB disk for votes. Render's free tier has no persistent disk, so votes would be wiped whenever it restarts; use the Starter plan.

**Anywhere with Docker** (Fly.io, Railway, a VPS):

```bash
docker build -t vote-fragrance .
docker run -p 3000:3000 -v vote-data:/data vote-fragrance
```

Mount a volume at `/data` so votes persist.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where `votes.json` is written |
| `TRUST_PROXY` | off | Set to `1` behind a proxy/load balancer so the real client IP is used and cookies are `Secure` |
| `IP_SALT` | `vote-fragrance` | Salt for hashing IPs (raw IPs are never stored) |

## Peeking at the raw votes

`GET /api/state` returns the full tally, or read `DATA_DIR/votes.json` directly.
