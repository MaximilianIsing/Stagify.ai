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
| Build | `sh scripts/build.sh` — `npm install` → `npm test` (**a failing test blocks the deploy**) → download the Litestream binary into `./bin` |
| Start | `sh scripts/start.sh` — restore the DB from R2 if `/data` is empty, then run the app under `litestream replicate` (which execs `npm start` → `node --import ./instrument.js server.js`, so Sentry still loads first) |
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
3. Render runs the build (`sh scripts/build.sh` — install, the test gate, then the
   Litestream binary). **If any test fails the deploy is aborted** — fix and retry. Keep
   the suite green (see [`testing.md`](../guides/testing.md)).
4. Watch the deploy logs for `Server running on port …` and `AI configured: true`.

> **Check the `e2e` CI job before deploying.** The Playwright studio smoke
> ([`playwright.config.js`](../../playwright.config.js)) runs as a **separate GitHub CI
> job**, *not* as part of `scripts/build.sh` — so the Render build gate (`npm test`)
> does **not** cover it. This is deliberate: a flaky browser test must never block a
> deploy. The trade-off is that a genuinely broken studio flow won't abort the build on
> its own, so before clicking **Manual Deploy**, confirm the **`e2e` job is green on the
> commit you're shipping** (GitHub → the commit/PR → CI). Treat a red `e2e` as a
> deploy-blocker even though the build won't.

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
- **Backups are disabled on staging** — `scripts/start.sh` skips Litestream entirely
  when `IS_STAGING` is truthy, so staging can never replicate its throwaway data **into**
  (nor restore production data **out of**) the R2 backup. Belt and suspenders: don't set
  the `LITESTREAM_*` keys on the staging service either.

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

### Backups & disaster recovery (Litestream → Cloudflare R2)

The SQLite database is **continuously replicated off-disk** to a Cloudflare R2 bucket
(`stagify-backups`) by [Litestream](https://litestream.io) — configured in
[`litestream.yml`](../../litestream.yml), the binary fetched in `scripts/build.sh`, and
run by `scripts/start.sh`:

- **On boot**, if `/data/auth-store.db` is missing (fresh disk / disaster recovery),
  `start.sh` restores it from R2 *before* the app starts — so recovering a lost disk is
  just a redeploy.
- **While running**, changes stream to R2 continuously (seconds of RPO).
- Needs `LITESTREAM_ACCESS_KEY_ID` + `LITESTREAM_SECRET_ACCESS_KEY` on the **production**
  service ([`environment-variables.md`](../reference/environment-variables.md)). If
  they're unset — or on staging (`IS_STAGING`) — replication is skipped and the app
  still runs normally.

**Covered:** only the SQLite DB (`auth-store.db`) — i.e. all *structured* state.
**Not covered:** the CSV logs and `hosted-images/`, which live only on the disk. For
those, still **snapshot `/data`** (Render dashboard) before anything risky — a migration,
a manual data edit, deleting the service. ⚠️ Do **not** restore a Render disk snapshot
*into* a live SQLite DB (it can corrupt it) — recover the DB from the R2 replica instead.

## Rolling back

Because `autoDeploy` is off, you already control timing. To roll back a bad deploy:

1. Render dashboard → `stagify-ai` → **Deploys** → pick the last good deploy →
   **Redeploy** (or "Rollback").
2. If the bad deploy also changed **data shape** on `/data`, code rollback alone won't
   fix data — restore the disk snapshot too.
3. **Lost the whole disk?** Just redeploy — `scripts/start.sh` restores `auth-store.db`
   from the R2 replica on boot. (The CSV logs and `hosted-images/` come from a disk
   snapshot, not R2.)

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
- **Localized SEO is generated — rebuild before committing.** After changing the
  language or page set in `lib/i18n/locales.js`, run **`node scripts/build-i18n-seo.js`**
  (regenerates `sitemap.xml` + the English pages' `hreflang`). A drift test blocks the
  deploy if you forget. See [`i18n.md`](../guides/i18n.md).
- **A red test blocks the deploy** — the build gate is real.
- **A red `e2e` job does NOT block the deploy** — the Playwright studio smoke is a
  separate CI job outside the build gate (by design). Check it's green manually before a
  Manual Deploy; see [Deploying](#deploying).
