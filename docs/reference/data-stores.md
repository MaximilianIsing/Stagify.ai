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

One category deliberately does **not** live there: the gallery's render bytes, which go
to Cloudflare R2 — see [Object storage](#object-storage--gallery-render-bytes-r2).

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
  - `referral_links` + `referral_hits` ([`lib/data/referral-links.js`](../../lib/data/referral-links.js)) —
    campaign short-URLs (`/columbia`) and their click ledger. `referral_links` is one row
    per campaign (`slug` PK, `label`, `note`, `active`, `created_at`, `deactivated_at`);
    **retiring sets `active = 0`** rather than deleting, so a finished campaign keeps its
    results and keeps owning its slug. `referral_hits` is one row per arrival
    (`slug`, `ts`, `referer`, `is_bot`), indexed `(slug, ts)` — the shape of every read
    (one slug, one window) and every prune (one slug, oldest first).
    It is the only table written by **unauthenticated** requests, so it carries a ceiling:
    hits older than 400 days and anything past 100k rows per slug are pruned every 500
    inserts, on top of the per-IP `referralLimiter`. Deliberately **not** stored: the
    visitor's IP, their user-agent (read in memory to set `is_bot`, then dropped), and the
    referrer's query string (only `host/path` is kept — a referring URL routinely carries
    the sending site's own tracking params). The pre-existing `/columbia` link is seeded
    once behind a `meta` guard; without that guard, deleting it would resurrect it on the
    next boot. See [`admin-dashboard.md`](../guides/admin-dashboard.md#referrals-tab).
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
| `rejection_logs.csv` | `timestamp,kind,code,detail,email,userId,ipAddress,userAgent` |

These contain **emails and IP addresses** — treat as PII.

`rejection_logs.csv` records requests turned away **before any render happened**: an
upload the stageability gate refused (`kind: 'unstageable'`, `code` = the
[`unstageable.js`](../../lib/staging/unstageable.js) category), a free account at its
daily cap (`daily_limit`), or a caller that hit a rate limiter (`rate_limit`, `code` =
the limiter's name). None of these reach `processStaging`, so until this file existed
none of them were written down anywhere — including the single likeliest first-session
abandonment there is, where someone uploads the wrong kind of photo, is told no, and
leaves.

It is a **separate file rather than rows in `prompt_logs.csv` on purpose**: the dashboard
counts every prompt-log row as a generation, so folding rejections in would inflate the
headline volume and distort the success rate with work that never ran.

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

## Erasing one person's data

There are **no foreign keys** in this database (see the note in `db.js`), so nothing
cascades: deleting a `users` row on its own leaves that person's `sessions` (a live
bearer token for an account that no longer exists), `password_reset_tokens` and
`memories` behind. [`lib/data/user-deletion.js`](../../lib/data/user-deletion.js) is
the single place that knows the full set, run by
`POST /api/admin/delete-user` — see [`endpoints.md`](endpoints.md).

- **SQLite** — one transaction over `sessions`, `password_reset_tokens`, `memories`,
  `users` (last), plus `pending_registrations` for the same address (it holds a scrypt
  hash for an unverified signup). An address with *only* a pending registration can be
  erased on its own; otherwise the whole thing rolls back on failure, so an account is
  never half-erased.
- **CSV logs** — the identifying cells (`email` / `userId` / `ipAddress` / `userAgent`)
  of that person's rows are replaced with `[erased]`; the rows themselves stay. That is
  deliberate: the public "Rooms Staged" counter is a **record count** over
  `prompt_logs.csv`, so dropping rows would move a public number, and the dashboard
  reads these files positionally. Columns are matched by **name** against each file's
  own header, so the append-only column rule above cannot shift a redaction.
  `rejection_logs.csv` is covered too — its `kind` / `code` / `detail` cells are
  non-identifying and are left alone, so the drop-off analytics survive an erasure.
- **Not touched:** `mobile_ip_usage` (keyed by IP, no account link), `enterprise_domains`
  (a company's own billing record), `stripe_events`, `uptime_state`. Each is listed with
  its reason in `NOT_USER_KEYED`.

`test/data/user-deletion.test.js` introspects the live schema and **fails the build** if
a table grows a user-keyed column that is neither erased nor explicitly exempted, and if
a new CSV log appears that nothing redacts. Add the table/file to the right list — the
guard exists because this coverage is written once and forgotten forever.

**Known gap:** free-text columns (`userMessage` / `aiResponse` in `chat_logs.csv`, the
bug-report `description` and `conversationHistory`) can contain personal data a person
typed about themselves. Nothing can match those automatically; they are left as-is.

## Uploaded images (`hosted-images/`)

User-hosted images (`POST /api/host-image`) are written under
`hosted-images/` with a small JSON manifest; each is served back via `GET /i/:id`.
The uploader is capped at 25 MB and restricted to raster types (no SVG) — see
[`security.md`](../guides/security.md).

## The gallery tables

Six tables, all created from one schema constant in
[`lib/data/gallery-schema.js`](../../lib/data/gallery-schema.js) rather than per-factory —
the same reason `auth-store.js` holds the DDL for tables `session-tokens.js` queries: they
reference each other across store boundaries, so per-factory creation would make
construction **order** load-bearing.

| Table | Owner | Holds |
|---|---|---|
| `staged_renders` | [`staged-renders.js`](../../lib/data/staged-renders.js) | one row per finished render: the prompt, room type, style, `status`, `evicted_at`, plus `custom_name` — the owner's own label, `NULL` until they type one, because the page derives `<Style> <Room type>` rather than freezing a default into the row |
| `render_blobs` | same | `(render_id, role)` → `storage_key`; roles are `after` / `before` / `thumb` |
| `ref_objects` | [`render-refs.js`](../../lib/data/render-refs.js) | one row per **distinct** furniture reference photo, content-addressed |
| `render_refs` | same | which references a render used, in order |
| `gallery_shares` | [`gallery-shares.js`](../../lib/data/gallery-shares.js) | share links, one per finished render and minted by the gallery listing: `token_hash` (the lookup key) plus `token_plain` (so the owner can copy the link again), view count, revocation |
| `blob_tombstones` | [`blob-tombstones.js`](../../lib/data/blob-tombstones.js) | object keys owed a deletion |

Three properties are load-bearing rather than stylistic:

- **Every table carries `user_id`, even where it is derivable.** That column is what makes
  the GDPR drift guard in `test/data/user-deletion.test.js` *see* the table. Without it a
  table is invisible to the guard and its rows outlive the account.
- **Only the free tier is capped** — `FREE_GALLERY_LIMIT` (10). `PRO_GALLERY_LIMIT`
  defaults to `Infinity`: a Stagify+ gallery keeps every render, which is what the compare
  table on `stagify-plus.html` advertises. Eviction runs **inside the insert transaction**,
  because a cap checked in one statement and applied in another is not a cap; an uncapped
  tier reuses that same path rather than getting its own, since `evictBeyondCap` returns
  early on a non-finite cap (the door the downgrade grace window already used). Both
  constants stay env-overridable — setting `PRO_GALLERY_LIMIT` re-imposes a ceiling
  without a deploy if per-account storage ever threatens the R2 bill, at the cost of making
  the pricing page wrong. An eviction that breaks a **live share link** is reported to the
  owner regardless of tier.
- **`blob_tombstones` has NO `user_id`, on purpose.** It holds keys whose owning rows are
  *already* deleted. Giving it one would make the drift guard demand that an erasure
  delete these rows — i.e. delete the record that the bytes still need deleting. That
  exemption is only honest because object keys embed no account id either.

## Object storage — gallery render bytes (R2)

Rows describing renders are in SQLite; the **bytes** are in Cloudflare R2, behind
[`lib/data/object-store.js`](../../lib/data/object-store.js). Two backends, one interface:
R2 in production, the local disk (`<dataDir>/objects/`) in dev and CI, and **disabled** on
Render when R2 is unconfigured — falling back to the disk there would put ~220 KB per
render on the same 1 GB volume as `auth-store.db`, which is the failure the bucket exists
to avoid.

- **Keys carry no account id** — `renders/<renderId>/after.webp`, `refs/<sha256>.webp`.
  A presigned URL is handed to a stranger, and tombstones outlive the owning row, so an
  id in the key would leak through both.
- **Reads never pass through this process.** Manifests mint short-TTL presigned URLs and
  the browser fetches R2 directly. Consequence: **a takedown is eventual** — a URL already
  handed out works until it expires (≤15 min). Deleting the entry is the takedown, and the
  hard part of it, because a presigned URL to a deleted object 404s regardless of
  signature.
- **Deletion is a queue, not a call.** Erasure and eviction commit a *tombstone row* in
  the same transaction as the row deletion; a reaper drains it against R2 and retries.
  That is what lets `deleteUser` stay synchronous while the bytes live in someone else's
  datacentre.
- **Separate bucket and credentials from Litestream.** That token can overwrite the
  replica of the entire database.

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
- **Gallery render bytes have no second copy either.** The rows are in the replica, the
  objects are only in `stagify-renders` and rely on R2's own durability. So a restore
  from the Litestream replica brings back a gallery whose rows point at objects that
  still exist — but if the *bucket* were lost, the rows would outlive their bytes and
  every gallery entry would 404. Acceptable today; worth revisiting before the bucket
  matters more than the database.
- **No automatic schema migrations.** Table changes are additive (`CREATE TABLE IF NOT
  EXISTS`); a breaking shape change is manual. Note that `CREATE TABLE IF NOT EXISTS`
  does **not** add a column to a table that already exists, so a new user field either
  needs a hand-written `ALTER TABLE` or — the cheaper route, used by the comp-grant
  fields above — is simply left out of `KNOWN_USER_KEYS` and rides in `extra_json`,
  which round-trips unknown keys verbatim. That route has one real cost: SQLite cannot
  index or filter on a field *inside* the blob, so any query that selects on one has to
  read and `JSON.parse` every candidate row. Keep such a query **narrowed on a real
  column first** — `listTrialCandidates` (the hourly trial sweep) selects
  `WHERE plan = 'pro'` and only parses those, the difference between reading every
  account each hour and reading the few percent that could match. If a new field needs
  to be *searched* rather than merely stored, that is the case for a real column (and
  the `ALTER TABLE` that comes with it) instead of `extra_json`.
- **CSV logs grow unbounded.** They're append-only (low risk), but nothing prunes them.
