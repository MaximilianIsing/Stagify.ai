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
  - **Listing Studio** ([`lib/data/projects.js`](../../lib/data/projects.js)) — `projects`
    (one real-estate listing), `project_photos` (the uploaded frames, each with a room and
    a `frame_role` of `hero`/`support`/`excluded`), `design_bibles` (the versioned per-room
    description of the staged look) and `renders` (one row per photo × variation, and the
    lease-based work queue itself, in
    [`project-renders.js`](../../lib/data/project-renders.js)). The queue lives in the
    **database rather than in memory** because it is the only thing that survives a restart
    mid-listing; the rule that a support frame cannot be claimed before its room's bible
    exists is a clause in the claim's single `UPDATE`, not JS around it.
  - `project_shares` ([`lib/data/project-shares.js`](../../lib/data/project-shares.js)) —
    the public client links into a listing. One row per link ever minted: minting rotates
    the previous one out, and revoking sets `revoked_at` rather than deleting, so a broker
    keeps the view count of the link they sent their seller in March. **Only the sha256
    digest of the token is stored** (same `hashToken` as the session tables) — the
    plaintext is returned once, at creation, and is unrecoverable afterwards. `user_id` is
    denormalized onto the row on purpose: it is redundant with `projects.user_id`, and it
    is what makes this table **visible to the erasure drift guard**, which finds user-keyed
    tables by looking for exactly that column. The other three project children have no
    such column and are therefore in that guard's blind spot, which is why they need
    `PROJECT_CHILD_TABLES` and this one does not.
  - `share_feedback` ([`lib/data/share-feedback.js`](../../lib/data/share-feedback.js)) —
    seller sign-off coming back through a share link: `approved` / `changes` plus a note,
    attached to the room it is about. **The only table an anonymous request can write FREE
    TEXT to** (`referral_hits` is the only other anonymous write and stores no caller string
    at all), so its ceilings live in the store rather than in the route — clamped note,
    allowlisted verdict, and a per-share row cap enforced **inside the insert's transaction**,
    because a limit that can be raced is not a limit. Rows are **append-only**: `latestByRoom`
    reduces them, so the broker keeps the note explaining why a room was re-rendered after the
    room is approved. `user_id` is the listing **owner's**, not the viewer's — nothing
    identifies the viewer beyond an optional display name they typed.
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


> **Every CSV here is bounded.** `prompt_logs.csv`, `chat_logs.csv` and `mask_logs.csv`
> stop accepting new rows at `CSV_LOG_MAX_BYTES` (64 MB each, env-overridable) —
> `bug_reports.csv` and `email_open_logs.csv` already had their own ceilings; these three
> did not, and they share the volume with SQLite's WAL, so an unbounded log takes auth and
> Stripe webhooks down with it. The Listing Studio made it urgent: one 30-photo listing at
> three variations writes ~80 prompt rows where the single-photo stager wrote one.
>
> At the ceiling a log **stops growing** — it is never truncated and never rotated.
> Truncation would drop history silently, and `prompt_logs.csv` is what seeds the public
> "Rooms Staged" count at boot, so rewriting it would move a public number. A brand-new
> file is always created regardless of the ceiling, and a stat failure fails OPEN: this
> check must never be the reason a paid render goes unrecorded.
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

## Erasing one person's data

There are **no foreign keys** in this database (see the note in `db.js`), so nothing
cascades: deleting a `users` row on its own leaves that person's `sessions` (a live
bearer token for an account that no longer exists), `password_reset_tokens` and
`memories` behind. [`lib/data/user-deletion.js`](../../lib/data/user-deletion.js) is
the single place that knows the full set, run by
`POST /api/admin/delete-user` — see [`endpoints.md`](endpoints.md).

- **SQLite** — one transaction over `sessions`, `password_reset_tokens`, `memories`,
  `project_shares`, `share_feedback`, `projects` and their children (`renders`, `design_bibles`,
  `project_photos`, via `PROJECT_CHILD_TABLES`), `users` (last), plus
  `pending_registrations` for the same address (it holds a scrypt hash for an unverified
  signup). An address with *only* a pending registration can be erased on its own;
  otherwise the whole thing rolls back on failure, so an account is never half-erased.
  **`project_shares` is erased first and by `user_id`**, because a surviving row there is
  not a stray record — it is a live public URL to the erased person's home, and that is the
  worst failure this path has.
- **CSV logs** — the identifying cells (`email` / `userId` / `ipAddress` / `userAgent`)
  of that person's rows are replaced with `[erased]`; the rows themselves stay. That is
  deliberate: the public "Rooms Staged" counter is a **record count** over
  `prompt_logs.csv`, so dropping rows would move a public number, and the dashboard
  reads these files positionally. Columns are matched by **name** against each file's
  own header, so the append-only column rule above cannot shift a redaction.
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

## Listing Studio images (`projects/`)

> **Orphan blobs are reclaimed by a sweep, not by hope.** A listing delete removes rows first
> and blobs second (deliberately), so a crash or a failed unlink between the two leaves files
> nothing references. `POST /api/admin/blob-gc`
> ([`project-blob-gc.js`](../../lib/data/project-blob-gc.js)) finds them by diffing the disk
> against every `storage_key` in `project_photos` and `renders`. It is a **dry run unless
> `?apply=1`**, and it refuses to touch anything younger than an hour — the worker writes a
> render's blob before its row, so a fresh unreferenced file may be a live render, not garbage.

The one place in the app where a **user's own** files are stored durably, and by far the
largest thing on the disk:

```
<dataDir>/projects/<projectId>/src/<photoId>.<ext>   uploaded room photos
<dataDir>/projects/<projectId>/out/<renderId>.<ext>  finished renders
```

Deliberately **not** in SQLite — but for a different reason than this section first claimed,
and the correction matters because it changes where the disk actually goes.

**Measured, not estimated.** A 30-photo listing at `variationCount: 3` produces **78** renders,
not 90 (the queue enqueues one hero per *room* plus `variationCount` per *support* frame — not
photos × variations), and each render lands at about **0.28 MB** after `upscaleForDelivery`,
not "multi-MB". So the renders are the *small* half:

| 30-photo listing, 3 variations, 6 rooms | bytes |
|---|---|
| source photographs, **as received** (30 × 2–6 MB) | ~120 MB |
| source photographs, **as stored** (30 × ~0.35 MB) | **~10 MB** |
| renders (78 × ~0.28 MB) | ~22 MB |
| **total on disk** | **~32 MB** |

**Sources used to be 82–85% of the footprint** — that measurement is what motivated
downscaling them on upload, and it describes the volume BEFORE that landed. It no longer
describes the volume today: once a source is capped at 1920×1080 the two rows are the same
order of magnitude, and **renders are now the larger half**. A full-size 40-photo batch would
otherwise have committed ~600 MB in a single request.

> On the numbers: the render figure and the as-received range are measured. The **~0.35 MB
> stored source is an ESTIMATE** — real room photography re-encodes to 91 KB at 900×600
> (measured over the seven sample interiors in `public/media-webp/example/`), scaled by pixel
> count to the 1920×1080 cap. Treat it as an order of magnitude, not a budget line. If you
> need a real number, measure `<dataDir>/projects/*/src` on a live volume — or ask
> `GET /api/admin/listing-health?storage=1`, which reports bytes per account. The one perverse case to know about: when `upscaleForDelivery`
fails open to the model's native PNG, the stored file is ~1.6 MB — roughly 6× larger at a
quarter of the delivered resolution.

None of it belongs in a single-writer database that Litestream replicates row by row.
The DB holds only the `storage_key`, and it is stored **relative and backend-agnostic**
(`projects/<id>/out/<id>.webp`) so moving to S3/R2 is one adapter in
[`project-storage.js`](../../lib/data/project-storage.js) rather than a data migration.

Two things to know:

- **The key validator is a security boundary, not tidiness.** These keys end up resolved
  against the filesystem and served over HTTP (`GET /api/projects/:id/renders/:rid/image`),
  so `isSafeStorageKey` enforces a strict hex-only shape *and* `absolutePathFor` re-checks
  containment within the projects root. Both, on purpose.
- **This is the storage-growth trigger.** Render's disk is finite and Litestream backs up
  the DB only — not the CSVs, not `hosted-images/`, and not this. Listings are the first
  feature whose bytes grow per customer per shoot, so this is the thing to watch before it
  becomes the reason to adopt object storage.

Erasure: a user's project directories are **removed outright** when their account is
erased (see [Erasing one person's data](#erasing-one-persons-data)). The rows are the
index; the images are the personal data.

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
- **The listing render queue inherits the single-instance limit.** `renders` rows are the
  queue and `lib/staging/listing-worker.js` leases one at a time, so throughput is one
  render per instance — and a second instance would not double it, it would corrupt the
  database. The upside of putting the queue in SQLite is that all progress is durable: a
  restart mid-listing resumes, and a lease abandoned by a killed process is reclaimed.
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
  which round-trips unknown keys verbatim. That route has one real cost: SQLite cannot
  index or filter on a field *inside* the blob, so any query that selects on one has to
  read and `JSON.parse` every candidate row. Keep such a query **narrowed on a real
  column first** — `listTrialCandidates` (the hourly trial sweep) selects
  `WHERE plan = 'pro'` and only parses those, the difference between reading every
  account each hour and reading the few percent that could match. If a new field needs
  to be *searched* rather than merely stored, that is the case for a real column (and
  the `ALTER TABLE` that comes with it) instead of `extra_json`.
- **CSV logs grow unbounded.** They're append-only (low risk), but nothing prunes them.
