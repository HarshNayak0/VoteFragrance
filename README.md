# Vote My Next Fragrance

A website that tracks my **75 Hard: Cologne Edition** challenge and lets anyone vote on the fragrance I buy when I finish.

**The daily rules:** 45 minute workout · 10,000 steps · 300–500 calorie deficit · 10 minutes of French.
Miss any of them (or forget to log a day) and the challenge restarts at Day 1 the next day.

## What's on the site

**Public page (`/`)**
- Current day out of 75, the attempt number, and today's four tasks
- A 75-square calendar of the current attempt, running totals (steps, workout hours, calories cut, French hours) and earlier attempts
- The fragrance ballot: one vote per person, changeable until Day 75 is complete. Then voting closes and the winner is announced.
- A suggestion box. Suggestions wait for your approval before they reach the ballot.

**Admin page (`/admin`, password protected)**
- Log a day: enter your numbers and it shows which tasks passed before you save. Edit or delete any past day.
- Add, edit and remove fragrances. Approve or reject visitor suggestions.
- Settings: site title, tagline, Day 1 date and your time zone (so "today" flips at your midnight).

## Deploy on Vercel

1. Import this GitHub repo in Vercel (**Add New → Project**). Leave the build settings at their defaults.
2. **Storage → Create Database → Upstash (Redis)**, free plan, connect it to the project. Vercel adds the keys for you.
3. **Settings → Environment Variables**, add:
   - `ADMIN_PASSWORD`: the password for `/admin`
   - `SESSION_SECRET`: any long random string (keeps you logged in safely; changing it logs you out everywhere)
4. **Deployments → ⋯ → Redeploy** so everything picks up the new variables.
5. Open `https://<your-project>.vercel.app/admin`, log in, set your Day 1 date and time zone, and add your fragrances.

## Run it locally

```bash
ADMIN_PASSWORD=dev npm run dev   # http://localhost:3000 and /admin
npm test
```

Node 20+. No dependencies to install. Locally, data is saved to `data/store.json` (git-ignored) unless the Upstash variables are set.

## How it's built

| Path | What it is |
| --- | --- |
| `public/` | The two pages (`index.html`, `admin.html`), served as static files |
| `api/` | One tiny Vercel function per endpoint, all routed into `lib/api.js` |
| `lib/challenge.js` | The 75 Hard rules: what passes a day, streaks, restarts, completion |
| `lib/api.js` | Endpoints, validation, admin sessions, rate limits |
| `lib/stores.js` | Storage: Upstash Redis over its REST API, or memory/JSON file locally |
| `server.js` | Local development server |

Anti-abuse: a voter is identified by a cookie, at most 5 different voters per network, 3 suggestions per network per day, 10 admin login attempts per 15 minutes. IP addresses are only stored as salted hashes. Set `IP_SALT` to your own random string if you like.
