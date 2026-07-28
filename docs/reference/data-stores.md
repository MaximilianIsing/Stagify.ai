# Data stores

Every piece of durable state Stagify keeps, where it lives, and its shape. There is
**no external database** — a single SQLite file holds all structured state (accounts,
sessions, enterprise domains, chat memories, uptime), with append-only CSV logs and
uploaded images alongside it as flat files.

## Where the data lives

Resolved by `resolveDataDir()` ([`lib/data/data-dir.js`](../../lib/data/data-dir.js)) — the
one implementation of the rule, for every store **and** every CSV writer. It lives apart
from `db.js` (which re-exports it) so the log writers can share it without pulling in
`better-sqlite3`. Nothing else may re-derive this path; a drift test
([`test/data/data-dir.test.js`](../../test/data/data-dir.test.js)) fails the build on a
second copy, because ten hand-maintained copies is how it started:

- **Render:** the mounted persistent disk at **`/data`** (survives deploys — see
  [`deployment.md`](../operations/deployment.md)).
- **Local:** **`./data`** in the project root.

## SQLite — the application database (`auth-store.db`)

All structured state lives in **one SQLite database** (via `better-sqlite3`), opened
through a single shared connection in [`lib/data/db.js`](../../lib/data/db.js) and used by every
store factory. It began as the auth store, so the file is still named `auth-store.db`.

- **File:** `auth-store.db` (WAL mode adds `auth-store.db-wal` and `auth-store.db-shm`
  alongside it — don't copy the `.db` without them).
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`.
  WAL + `busy_timeout` is a **single-writer** design — see caveats. `foreign_keys` is
  **not set explicitly** — no table declares a `REFERENCES` clause, so there is nothing
  to enforce, and better-sqlite3 turns the pragma on by default regardless. Enforcement
  is therefore on and always was; the explicit call was just noise.
- **Tables:**
  - Auth ([`lib/data/auth-store.js`](../../lib/data/auth-store.js)): `users`, `sessions`,
    `mobile_ip_usage` *(dormant — see below)*, `password_reset_tokens`, `pending_registrations`.
    The two token tables are owned by
    [`lib/data/session-tokens.js`](../../lib/data/session-tokens.js), which hashes every
    token on the way in and out — the auth store never writes them directly.
  - `enterprise_domains` ([`lib/data/enterprise-store.js`](../../lib/data/enterprise-store.js)) —
    one row per domain: activation + metered-usage state, kept in sync with Stripe.
    A row here is a **blanket `pro` grant to every address under that domain**, so
    public mailbox providers are refused on write *and* re-checked on read against
    [`public-email-domains.js`](../../lib/data/public-email-domains.js) — a `gmail.com`
    row arriving via the legacy import or `importStore()` grants nothing. See
    [`security.md`](../guides/security.md#enterprise-domains-are-a-blanket-grant).
  - `memories` ([`lib/data/memory.js`](../../lib/data/memory.js)) — one row per user holding that
    user's AI-chat-assistant memories (a JSON array).
  - `uptime_state` ([`lib/data/uptime-monitor.js`](../../lib/data/uptime-monitor.js)) — a single
    row: last heartbeat + coalesced downtime incidents (powers `/api/status`).
  - `meta` — key/value bookkeeping (e.g. the one-time-import guards).
- **Indexes** cover the lookups a table actually performs, not just its primary key:
  `users` by `email` / `google_sub` / both Stripe ids (in `auth-store.js`'s `SCHEMA`), and
  `sessions` / `password_reset_tokens` by `user_id` and `exp` (in
  [`session-tokens.js`](../../lib/data/session-tokens.js), next to the statements that use
  them). Those two are the only lookups the token-keyed tables make *without* a token —
  sign-out-everywhere on a password reset, and the expiry pruners — so without them both
  read the whole table. Every one is `CREATE INDEX IF NOT EXISTS`, executed on **every**
  open, so adding an index needs no migration step: a deployed database builds it on the
  next boot and nobody is signed out.
- **What's inside auth:** accounts (email, **scrypt-hashed + per-user-salted** passwords —
  never plaintext, Google `sub`, Stripe customer/subscription ids, Pro flag), 30-day
  sessions and single-use password-reset tokens (both **SHA-256 hashed at rest** —
  see [`lib/data/session-tokens.js`](../../lib/data/session-tokens.js); a completed
  password reset deletes every `sessions` row for that user in the same transaction as
  the hash rotation), 15-minute
  registration codes, and the
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

> **Sensitive.** `auth-store.db` holds password hashes, live sessions, and billing
> identifiers. Session and reset tokens are stored as SHA-256 digests
> ([`lib/data/session-tokens.js`](../../lib/data/session-tokens.js)), so a leaked
> copy is not a set of usable logins — but treat backups and access accordingly.

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
| `prompt_logs.csv` | `timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode` |
| `chat_logs.csv` | `timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent` |
| `mask_logs.csv` | `timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent` |
| `contact_logs.csv` | `timestamp,userRole,referralSource,email,userAgent,ipAddress` |
| `bug_reports.csv` | `timestamp,description,stepsToReproduce,email,userId,userAgent,url,ipAddress,conversationHistory` |
| `email_open_logs.csv` | `timestamp,email,ipAddress,userAgent` |

These contain **emails and IP addresses** — treat as PII.

The last five `prompt_logs.csv` columns (`status` … `errorCode`) were **appended, never
inserted**, because the admin dashboard reads these files **by column index** — a column
added mid-row would silently re-label every historical render. Rows written before they
existed simply end early, which reads as "outcome unknown". Append-only applies to the
header as much as the data.

**The public counters are seeded from two of these files at boot.**
[`lib/data/counters.js`](../../lib/data/counters.js) counts the records in
`prompt_logs.csv` (the home page's "Rooms Staged") and `contact_logs.csv`, then keeps
counting in memory as requests arrive. `countCsvRecords` is quote-aware on purpose: the
writer RFC-4180-quotes free-text user input, so a prompt containing a newline is one
record spanning several physical lines, and counting lines instead of records
**over-reports the public figure**. It streams the file in 64 KB chunks so an unbounded
log doesn't mean unbounded memory, and falls back to a line count (with a warning) if a
file's quotes don't balance, so a malformed row degrades the counter rather than
collapsing it. Both initializers take an optional log-directory argument for tests.

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
