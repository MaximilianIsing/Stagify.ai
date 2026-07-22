# Data stores

Every piece of durable state Stagify keeps, where it lives, and its shape. There is
**no external database** — a single SQLite file holds all structured state (accounts,
sessions, enterprise domains, chat memories, uptime), with append-only CSV logs and
uploaded images alongside it as flat files.

## Where the data lives

Resolved by `resolveDataDir()` ([`lib/data/db.js`](../../lib/data/db.js)) — the same rule for
every store:

- **Render:** the mounted persistent disk at **`/data`** (survives deploys — see
  [`deployment.md`](../operations/deployment.md)).
- **Local:** **`./data`** in the project root.

## SQLite — the application database (`auth-store.db`)

All structured state lives in **one SQLite database** (via `better-sqlite3`), opened
through a single shared connection in [`lib/data/db.js`](../../lib/data/db.js) and used by every
store factory. It began as the auth store, so the file is still named `auth-store.db`.

- **File:** `auth-store.db` (WAL mode adds `auth-store.db-wal` and `auth-store.db-shm`
  alongside it — don't copy the `.db` without them).
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `foreign_keys=ON`. WAL + `busy_timeout` is a **single-writer** design — see caveats.
- **Tables:**
  - Auth ([`lib/data/auth-store.js`](../../lib/data/auth-store.js)): `users`, `sessions`,
    `mobile_ip_usage` *(dormant — see below)*, `password_reset_tokens`, `pending_registrations`.
  - `enterprise_domains` ([`lib/data/enterprise-store.js`](../../lib/data/enterprise-store.js)) —
    one row per domain: activation + metered-usage state, kept in sync with Stripe.
  - `memories` ([`lib/data/memory.js`](../../lib/data/memory.js)) — one row per user holding that
    user's AI-chat-assistant memories (a JSON array).
  - `uptime_state` ([`lib/data/uptime-monitor.js`](../../lib/data/uptime-monitor.js)) — a single
    row: last heartbeat + coalesced downtime incidents (powers `/api/status`).
  - `meta` — key/value bookkeeping (e.g. the one-time-import guards).
- **What's inside auth:** accounts (email, **scrypt-hashed + per-user-salted** passwords —
  never plaintext, Google `sub`, Stripe customer/subscription ids, Pro flag), 30-day
  sessions, 15-minute registration codes, single-use password-reset tokens, and the
  **free-tier daily generation counter** (`usage_day` / `usage_count` on `users`, which
  enforces the 50-generations/day free cap). The separate `mobile_ip_usage` table is a
  **dormant legacy** table: no route writes to it anymore (staging now requires sign-in),
  and it is retained only so the backup/export shape stays 1:1 for rollback.
- **Admin comp grants** ([`lib/data/pro-grants.js`](../../lib/data/pro-grants.js)): the admin
  dashboard can hand a free account one calendar month of Stagify+ with **no Stripe
  subscription** behind it. A grant is `plan='pro'` plus `proGrantedAt` /
  `proGrantExpiresAt` (and `proGrantRevokedAt` if ended early). Those three fields are
  deliberately **absent from `KNOWN_USER_KEYS`**, so they ride in the `users.extra_json`
  blob and needed no column migration on the live DB — see the additive-change note under
  Caveats. Expiry is enforced when a row is **read** (`applyGrantExpiry` inside
  `rowToUser`), so a lapsed grant reads as `free` everywhere at once and the row
  self-heals to `plan='free'` on its next write; there is no sweep job to run. A real
  Stripe subscription always wins and is never expired this way.
- **Legacy:** on first boot each store performs a **one-time import** of its old JSON
  file (`auth-store.json`, `enterprise-domains.json`, `memories.json`, `uptime.json`)
  into SQLite — guarded so it never re-runs — then leaves the JSON as a **frozen
  fallback**. Those files are no longer the source of truth.

> **Sensitive.** `auth-store.db` holds password hashes, live session tokens, and
> billing identifiers. Treat backups and access accordingly.

## Legacy JSON fallbacks

`auth-store.json`, `enterprise-domains.json`, `memories.json`, and `uptime.json` are the
**pre-SQLite** stores. Each was imported once into `auth-store.db` and is now a
read-only fallback — the app neither reads nor writes them anymore. Keep them until a
migration is confirmed good; they double as a rollback source.

## CSV logs (append-only)

Written by [`lib/services/logging.js`](../../lib/services/logging.js) (and the contact/bug handlers in
[`routes/public.js`](../../routes/public.js)). Each is created with a header row on
first write, then appended to. Exposed (read-only) through the `endpoint_key`-gated
admin/log endpoints — see [`endpoints.md`](endpoints.md).

| File | Header |
|---|---|
| `prompt_logs.csv` | `timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress` |
| `chat_logs.csv` | `timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent` |
| `mask_logs.csv` | `timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent` |
| `contact_logs.csv` | `timestamp,userRole,referralSource,email,userAgent,ipAddress` |
| `bug_reports.csv` | `timestamp,description,stepsToReproduce,email,userId,userAgent,url,ipAddress,conversationHistory` |
| `email_open_logs.csv` | `timestamp,email,ipAddress,userAgent` |

These contain **emails and IP addresses** — treat as PII.

## Uploaded images (`hosted-images/`)

User-hosted images (`POST /api/host-image`) are written under
`hosted-images/` with a small JSON manifest; each is served back via `GET /i/:id`.
The uploader is capped at 25 MB and restricted to raster types (no SVG) — see
[`security.md`](../guides/security.md).

## Caveats (design consequences)

These follow directly from "one SQLite file + flat logs on one disk," and you must
design around them:

- **Single instance only.** SQLite here is single-writer (WAL + `busy_timeout`).
  Running **more than one instance** concurrently will corrupt shared state — do **not**
  scale horizontally without moving to a client/server datastore (e.g. Postgres). The
  app also keeps in-memory single-instance state (the rate limiter, the uptime timer).
- **Structured state is now transactional.** Accounts, sessions, enterprise domains,
  memories, and uptime all live in `auth-store.db` with WAL + transactions — atomic,
  per-row writes, no whole-file rewrite.
- **The database is backed up off-disk.** In production, [Litestream](https://litestream.io)
  continuously replicates `auth-store.db` to Cloudflare R2 (config in `litestream.yml`,
  run by `scripts/start.sh`) and restores it on boot if the disk is lost — so a disk
  failure is recoverable, not fatal. Full runbook: [`deployment.md`](../operations/deployment.md).
  ⚠️ Do **not** restore a Render disk snapshot *into* a live SQLite DB (it can corrupt
  it) — recover the DB from the R2 replica instead.
- **The CSV logs and `hosted-images/` are NOT replicated to R2** — they live only on the
  disk, so still **snapshot `/data`** before risky operations to protect those.
- **No automatic schema migrations.** Table changes are additive (`CREATE TABLE IF NOT
  EXISTS`); a breaking shape change is manual. Note that `CREATE TABLE IF NOT EXISTS`
  does **not** add a column to a table that already exists, so a new user field either
  needs a hand-written `ALTER TABLE` or — the cheaper route, used by the comp-grant
  fields above — is simply left out of `KNOWN_USER_KEYS` and rides in `extra_json`,
  which round-trips unknown keys verbatim.
- **CSV logs grow unbounded.** They're append-only (low risk), but nothing prunes them.
