# Deployment & operations runbook

How Stagify.ai is deployed, the staging vs production split, and the operational
tasks (deploy, roll back, back up). Config reference: [`render.yaml`](../../render.yaml)
and [`environment-variables.md`](../reference/environment-variables.md). Storage
details: [`data-stores.md`](../reference/data-stores.md).

## Hosting at a glance

Deployed on **Render** as a Node web service, defined by [`render.yaml`](../../render.yaml):

| Setting | Value |
|---|---|
| Service | `stagify-ai`, `env: node`, **`plan: standard`** (~2 GB RAM) |
| Build | `npm install && npm test` — **a failing test blocks the deploy** |
| Start | `npm start` → `node --import ./instrument.js server.js` (Sentry loads before the app) |
| Disk | `stagify-data` mounted at **`/data`**, 1 GB — all runtime state lives here |
| **`autoDeploy`** | **`false`** |

> **Push ≠ deploy.** `autoDeploy` is **off**, so pushing to the default branch does
> **not** ship anything. Deploys are a **manual** action from the Render dashboard.
> The running site can therefore lag `main` — keep that in mind when debugging "my
> change isn't live" (that's exactly the staging 404 class of confusion).

## Deploying

1. Merge/commit to the default branch as usual (push does nothing on its own).
2. In the **Render dashboard** → the `stagify-ai` service → **Manual Deploy** →
   deploy the latest commit (or a specific one).
3. Render runs the build (`npm install && npm test`). **If any test fails the deploy
   is aborted** — fix and retry. Keep the suite green (see
   [`testing.md`](../guides/testing.md)).
4. Watch the deploy logs for `Server running on port …` and `AI configured: true`.

## Environments: staging vs production

There is a separate **staging** service (`stagify-ai-staging.onrender.com`). The only
thing that makes a deploy "staging" is the **`IS_STAGING`** env var (truthy =
`1`/`true`/`on`/`yes`):

- **Google Sign-In and Stripe checkout are disabled** when `IS_STAGING` is on (so a
  staging deploy can't take real payments or mint real Google sessions).
- A **red staging banner** is shown. `HIDE_STAGING_BANNER=true` hides only the banner
  (e.g. for screenshots) while keeping the other staging behavior.
- **Sentry reports from production only** — `instrument.js` sets `enabled: !IS_STAGING`,
  so staging never reports even though `SENTRY_DSN` is present there.

> ⚠️ **The production service must NOT have `IS_STAGING` set** (or it must be
> `false`/empty). If production is accidentally flagged staging, sign-in and checkout
> silently break and errors stop reaching Sentry. Note the string `"false"` is falsey
> here by design (explicit regex parse), so leaving it unset is safest.

## Error tracking (Sentry)

- Initialized in [`instrument.js`](../../instrument.js), loaded via `--import` **before**
  `server.js` so the SDK can instrument Express.
- **No-op without `SENTRY_DSN`** (local dev) — zero overhead, like the other keys.
- `sendDefaultPii: false` — cookies, auth headers, and client IP are **not** sent (this
  app handles password hashes and uploads). `tracesSampleRate: 0` (errors only).
- Set `SENTRY_DSN` in the **production** Render dashboard only.

## Persistence & the `/data` disk

All durable state — the SQLite `auth-store.db` (accounts, sessions, enterprise domains,
memories, uptime — plus its `-wal`/`-shm` sidecars), the CSV logs, `hosted-images/`, and
the frozen legacy `*.json` fallbacks — lives on the **1 GB `/data` disk**, which survives
deploys and restarts. Locally it's `./data`. Full inventory: [`data-stores.md`](../reference/data-stores.md).

**Back up before anything risky** (a migration, a manual data edit, deleting the
service): snapshot `/data` from the Render dashboard (disk snapshot) or copy the files
off. There is **no automatic backup** and writes are not atomic — see the storage
doc's caveats.

## Rolling back

Because `autoDeploy` is off, you already control timing. To roll back a bad deploy:

1. Render dashboard → `stagify-ai` → **Deploys** → pick the last good deploy →
   **Redeploy** (or "Rollback").
2. If the bad deploy also changed **data shape** on `/data`, code rollback alone won't
   fix data — restore the disk snapshot too.

## Uptime & status

The app self-monitors: a heartbeat writes to the `uptime_state` row in `auth-store.db`
every 60s, and
`/api/status` (plus the status page) reports uptime windows and any incidents
(90-day retention). Use it as a quick "is it healthy" check after a deploy alongside
`GET /health`.

## Common gotchas

- **Push ≠ deploy** (above) — the running site can lag `main`.
- **Case-sensitivity:** local dev is Windows (case-insensitive); Render is Linux
  (case-sensitive). An asset that loads locally can 404 in production if the path case
  doesn't match what git recorded. The `static` test checks that referenced assets
  exist, but not case — double-check on a rename.
- **Immutable image caching:** images/fonts/media are served `Cache-Control: immutable`
  for a year. To update one in place, **rename it or append `?v=`** — see
  [`caching.md`](../reference/caching.md).
- **A red test blocks the deploy** — the build gate is real.
