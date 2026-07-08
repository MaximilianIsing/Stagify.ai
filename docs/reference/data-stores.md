# Data stores

Every piece of durable state Stagify keeps, where it lives, and its shape. There is
**no external database** — a single SQLite file holds all structured state (accounts,
sessions, enterprise domains, chat memories, uptime), with append-only CSV logs and
uploaded images alongside it as flat files.

## Where the data lives

Resolved by `resolveDataDir()` ([`lib/db.js`](../../lib/db.js)) — the same rule for
every store:

- **Render:** the mounted persistent disk at **`/data`** (survives deploys — see
  [`deployment.md`](../operations/deployment.md)).
- **Local:** **`./data`** in the project root.

## SQLite — the application database (`auth-store.db`)

All structured state lives in **one SQLite database** (via `better-sqlite3`), opened
through a single shared connection in [`lib/db.js`](../../lib/db.js) and used by every
store factory. It began as the auth store, so the file is still named `auth-store.db`.

- **File:** `auth-store.db` (WAL mode adds `auth-store.db-wal` and `auth-store.db-shm`
  alongside it — don't copy the `.db` without them).
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `foreign_keys=ON`. WAL + `busy_timeout` is a **single-writer** design — see caveats.
- **Tables:**
  - Auth ([`lib/auth-store.js`](../../lib/auth-store.js)): `users`, `sessions`,
    `mobile_ip_usage`, `password_reset_tokens`, `pending_registrations`.
  - `enterprise_domains` ([`lib/enterprise-store.js`](../../lib/enterprise-store.js)) —
    one row per domain: activation + metered-usage state, kept in sync with Stripe.
  - `memories` ([`lib/memory.js`](../../lib/memory.js)) — one row per user holding that
    user's AI-chat-assistant memories (a JSON array).
  - `uptime_state` ([`lib/uptime-monitor.js`](../../lib/uptime-monitor.js)) — a single
    row: last heartbeat + coalesced downtime incidents (powers `/api/status`).
  - `meta` — key/value bookkeeping (e.g. the one-time-import guards).
- **What's inside auth:** accounts (email, **scrypt-hashed + per-user-salted** passwords —
  never plaintext, Google `sub`, Stripe customer/subscription ids, Pro flag), 30-day
  sessions, 15-minute registration codes, single-use password-reset tokens, and the
  anonymous mobile per-IP daily usage counter.
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

Written by [`lib/logging.js`](../../lib/logging.js) (and the contact/bug handlers in
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
  per-row writes, no whole-file rewrite. Still **snapshot `/data` before risky
  operations**, and back up the `.db` **with its `-wal`/`-shm` sidecars**. (Per Render's
  docs, don't restore a disk snapshot into a live SQLite DB — export/copy it instead.)
- **No automatic schema migrations.** Table changes are additive (`CREATE TABLE IF NOT
  EXISTS`); a breaking shape change is manual.
- **CSV logs are the only flat data files left, and they grow unbounded.** They're
  append-only (low risk), but nothing prunes them.
