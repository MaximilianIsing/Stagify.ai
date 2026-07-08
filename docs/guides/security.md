# Security model & hardening

How Stagify authenticates, protects its endpoints, and bounds abuse. This is the
rationale behind the limits in the code — change them deliberately. Related:
[`environment-variables.md`](../reference/environment-variables.md),
[`data-stores.md`](../reference/data-stores.md), [`endpoints.md`](../reference/endpoints.md).

## Authentication & accounts

Backed by SQLite (`auth-store.db`, [`lib/auth-store.js`](../../lib/auth-store.js)):

- **Passwords:** hashed with **scrypt** (`crypto.scryptSync`, 64-byte key) using a
  per-user 16-byte random salt. Never stored or logged in plaintext.
- **Sessions:** random 30-day tokens, validated on each request until logout.
- **Registration:** email-verified — a code with a **15-minute expiry** and **max 5
  verify attempts** before it's invalidated.
- **Password reset:** **single-use** tokens; the "forgot password" flow is
  **non-enumerating** (it does not reveal whether an email exists).
- **Google Sign-In:** ID tokens are verified with `google-auth-library`
  (`OAuth2Client`) against `GOOGLE_CLIENT_ID`. Disabled on staging (see below).
- **Free-tier limits:** the free plan is effectively unlimited; anonymous **mobile
  requests are capped per IP per day** to bound cost abuse.

## Admin / log-export endpoints

The log and data-export routes (`/promptlogs`, `/authstore`, `/api/getpro`, etc.) are
guarded by the **`endpoint_key`** (note the lowercase env name):

- Compared in **constant time** (`sha256` each side, then `crypto.timingSafeEqual`) —
  no early-exit timing leak.
- Session tokens are read from the `Authorization` header / body, **never from the URL
  query string**, so they can't leak via access logs, browser history, or `Referer`.
- Responses carrying secrets/PII set `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer` (`setSensitiveHeaders`).

## Rate limiting

`express-rate-limit`, tunable via env (see the env doc):

| Limiter | Default | Applies to |
|---|---|---|
| `RL_AUTH` | 40 / 15 min | sign-in / account actions (brute-force) |
| `RL_EMAIL` | 6 / 15 min | anything that sends email (spam/abuse) |
| `RL_GEN` | 60 / 5 min | paid AI generation (cost abuse) |

## Request-size & DoS hardening

The body parsers are the cheapest DoS surface, so they're **scoped**, not global:

- **JSON (`express.json`):** app-wide limit is **1 MB**; only the five routes that
  legitimately carry base64 images in JSON (`/api/chat`, `/api/mask-edit`,
  `/api/segment`, `/api/validate-image`, `/api/bug-report`) get **25 MB**. This matters
  because the parser runs before the per-route limiters and `JSON.parse` is
  **synchronous** — a large body on any path would otherwise buffer + block the event
  loop. Guarded by [`test/json-body-limit.test.js`](../../test/json-body-limit.test.js).
- **Multipart uploads (`multer`, memory storage):** each file is buffered whole in
  RAM, and `.fields()`/`.array()` multiply the cap by the file count, so the caps are
  kept tight:
  - staging (`process-image`, `stage-by-endpoint-key`): **25 MB**/file (×6 max)
  - `process-pdf`: **25 MB**
  - `chat-upload`: **20 MB**/file (×5) + 25 MB history field
  - `host-image`: **25 MB**
  - Over-cap uploads return a clean **413** (the multer error handler sits *after* the
    routers — a subtle bit; if moved before them it silently regresses to 500).
    Guarded by [`test/upload-limits.test.js`](../../test/upload-limits.test.js).

> Photos are downscaled to 1920×1080 after receipt, so these caps are already far
> above any real upload. If a legit user hits a 413, raise the specific cap — don't
> widen the global JSON limit.

## Transport & headers

- **CSP** via `helmet`, tuned for the third parties the app loads (Google, Stripe,
  Supademo/Instagram embeds, the HEIC WASM worker). Toggle with `DISABLE_CSP=1` only
  to debug a blocked resource.
- **CORS** restricted to the `ALLOWED_ORIGINS` allow-list (defaults to the stagify.ai
  origins + `localhost:3000`).

## File-upload safety

- Staging/PDF/host uploads use **type `fileFilter`s** (images → jpeg/png/webp; PDF →
  pdf). **`host-image` deliberately rejects SVG** — an SVG can carry script and would
  execute on our own origin.
- `chat-upload` intentionally accepts **all** types (the AI handles unsupported ones) —
  a known trade-off; it's still size-capped at 20 MB/file.

## Secrets

- `.env` and the `*.txt` key files are **gitignored**; the server reads the env var
  first, then the file. Production secrets live in the **Render dashboard**
  (`sync: false`), never in the repo. Full list: the env doc.
- Sentry runs with **`sendDefaultPii: false`** — no cookies, auth headers, or client IP
  are sent.

## Staging safety

When `IS_STAGING` is on, **Google Sign-In and Stripe checkout are disabled** and a
staging banner is shown, so a staging deploy can't mint real sessions or take real
payments. Ensure production does **not** set `IS_STAGING`. (See
[`deployment.md`](../operations/deployment.md).)

## Sensitive data at rest

- `auth-store.db` — password hashes + session tokens.
- The CSV logs and the `memories` table (in `auth-store.db`) — emails, IPs, chat content.

All live on the `/data` disk ([`data-stores.md`](../reference/data-stores.md)); the
export endpoints that read them are `endpoint_key`-gated.

## Known gaps / follow-ups

- **Single instance only** — the flat-file/SQLite-single-writer design corrupts under
  horizontal scaling (see the storage doc). This is an availability *and* integrity
  constraint.
- **`chat-upload` accepts any file type** (size-capped only).
- **No at-rest encryption** for the `/data` files beyond the host disk.
