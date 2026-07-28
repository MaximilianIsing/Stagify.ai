# Security model & hardening

How Stagify authenticates, protects its endpoints, and bounds abuse. This is the
rationale behind the limits in the code — change them deliberately. Related:
[`environment-variables.md`](../reference/environment-variables.md),
[`data-stores.md`](../reference/data-stores.md), [`endpoints.md`](../reference/endpoints.md).

## Authentication & accounts

Backed by SQLite (`auth-store.db`, [`lib/data/auth-store.js`](../../lib/data/auth-store.js)):

- **Passwords:** hashed with **scrypt** (`crypto.scryptSync`, 64-byte key) using a
  per-user 16-byte random salt. Never stored or logged in plaintext.
- **Sessions:** random 30-day tokens, validated on each request until logout. Stored
  **SHA-256 hashed**, never raw — see [Tokens at rest](#tokens-at-rest).
- **Registration:** email-verified — a code with a **15-minute expiry** and **max 5
  verify attempts** before it's invalidated.
- **Password reset:** **single-use** tokens, hashed at rest like sessions and expiring
  after an hour; the "forgot password" flow is **non-enumerating** (it does not reveal
  whether an email exists). Completing a reset **revokes every live session** for that
  account — see [Password reset revokes sessions](#password-reset-revokes-sessions).
- **Google Sign-In:** ID tokens are verified with `google-auth-library`
  (`OAuth2Client`) against `GOOGLE_CLIENT_ID`. Disabled on staging (see below).
- **Staging requires sign-in:** `POST /api/process-image` returns `401 AUTH_REQUIRED`
  for any request without a valid session — there is **no** anonymous/"mobile UA"
  staging path (that former per-IP bypass was removed to close the IP-rotation
  cost-abuse vector).
- **Free-tier daily cap:** free accounts are capped at **`FREE_DAILY_LIMIT` (50)
  generations per UTC day**, enforced server-side **before** any paid AI call
  (`freeGenerationStatus` in `lib/data/auth-store.js`); over-cap requests get
  `429 DAILY_LIMIT_REACHED`. Pro accounts are uncapped; enterprise-domain users are
  metered and billed separately.

## Enterprise domains are a blanket grant

An active enterprise domain upgrades **every** account whose email ends in it to
`pro` (`enhanceUserWithEnterprise` → `enterpriseStore.isActiveDomain`). That makes the
domain field on `enterprise.html` a privilege-escalation surface, not just a form
field: registering `gmail.com` would hand Stagify+ to a large slice of the internet
for the price of one seat.

So **public mailbox providers cannot be registered** — free consumer providers and
common disposable services, listed with their matcher in
[`lib/data/public-email-domains.js`](../../lib/data/public-email-domains.js). Input is
normalized before matching (case, an `@` prefix, a full address, a trailing dot, a
pasted URL) and subdomains of a listed provider match too, since the buyer controls
neither `gmail.com` nor `mail.gmail.com`.

Enforced at three layers, deliberately overlapping:

1. `POST /api/enterprise/create-checkout` — `400` with code `PUBLIC_EMAIL_DOMAIN`,
   before Stripe is contacted at all.
2. `activateDomain()` — refuses to write the row, so a replayed webhook, hand-edited
   session metadata, or a subscription created directly in the Stripe dashboard
   cannot bypass the route.
3. `isActiveDomain()` — re-checks on **read**. This is the important one: it is the
   single chokepoint every plan upgrade passes through, so it neutralizes a bad row
   regardless of how it got there (the legacy `enterprise-domains.json` import,
   `importStore()` during a restore, a hand-edited DB). It looks redundant next to
   layer 2 — it isn't, and it should not be "simplified" away.

**Scope:** this list gates enterprise registration only. Ordinary signup must keep
accepting gmail/yahoo/outlook addresses — do not wire it into the auth routes.

## Admin / log-export endpoints

The log and data-export routes (`/promptlogs`, `/authstore`, `/api/getpro`, etc.) are
guarded by the **`endpoint_key`** (note the lowercase env name):

- Compared in **constant time** (`sha256` each side, then `crypto.timingSafeEqual`) —
  no early-exit timing leak.
- Session tokens are read from the `Authorization` header / body, **never from the URL
  query string**, so they can't leak via access logs, browser history, or `Referer`.
- Responses carrying secrets/PII set `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer` (`setSensitiveHeaders`).

### No credentials over HTTP — `exportStore` vs `exportRedacted`

`GET /authstore` serves `authStore.exportRedacted()`: users, minus credentials.
It must stay that way. `exportStore()` — the sibling that backs
migration/restore — additionally returns **password hashes and salts,
pending-registration hashes, and a row per live session / outstanding reset token
keyed to its user**. Those token keys are now SHA-256 digests rather than the
bearer values (see *Tokens at rest* below), so the payload no longer hands over
accounts by itself — but it is still every credential the system has, plus a
session→user map.

It used to be what this route returned, so the single static `endpoint_key`
was, on its own, the only thing standing between a leak and every account. The
dashboard never read a single one of those fields.

Rules:
- **Never** serve `exportStore()` over HTTP, on this route or a new one. Backup
  and rollback are the SQLite file itself (Litestream → R2), not a browser
  download.
- `exportRedacted` filters through the `ADMIN_VISIBLE_USER_KEYS` **allowlist**.
  A new admin panel that needs another column adds it there deliberately. Do not
  convert it to a denylist — `rowToUser` spreads `extra_json`, so anything parked
  there would start shipping to the browser on its own.
- Enforced by `test/data/auth-store-sqlite.test.js` (no secret survives
  redaction; unknown `extra_json` fields do not leak) and
  `test/routes/admin-route.test.js` (the route calls the redacted export and
  `exportStore` is never invoked).

### Tokens at rest

Session tokens and password-reset tokens are **bearer credentials** — the string
alone authenticates, with no password step. They are therefore stored **hashed**:
[`lib/data/session-tokens.js`](../../lib/data/session-tokens.js) owns both token
tables, hashes on every write, and hashes the presented token on every lookup, so
the database holds `sha256$<digest>` and never a usable token.

This is what keeps a database read from being a mass account takeover. Password
hashes are scrypt, so the DB alone doesn't yield accounts — these two tables were
the exception, and they are the reason a leaked `/data` volume, a Litestream/R2
restore, or the frozen `auth-store.json` is now a disclosure rather than a
break-in.

Notes for anyone touching this:

- **Plain SHA-256, no salt, no stretching, and that is deliberate.** The input is
  already 32 bytes of CSPRNG output — there is no guessable keyspace for a work
  factor to slow down — and validation runs on every authenticated request, so the
  digest has to stay a fast deterministic key. Do not "upgrade" it to scrypt.
- **Write token rows only through `session-tokens.js`.** It is the single
  chokepoint; a new call site that prepares its own `INSERT INTO sessions` puts a
  raw token back on disk.
- **The `sha256$` prefix is load-bearing.** A raw token and its digest are both 64
  hex chars, so the prefix is the only way to tell stored form from raw. It makes
  the boot migration and the backup/legacy import idempotent instead of
  double-hashing, which would sign every user out.
- Enforced by `test/data/auth-store-sqlite.test.js` (raw tokens never appear in
  the tables, a stored digest is not replayable, the migration keeps existing
  sessions valid and is idempotent).

### Password reset revokes sessions

`completePasswordReset` ([`lib/data/auth-store.js`](../../lib/data/auth-store.js))
rotates the scrypt hash, drops the account's reset tokens, **and deletes every row in
`sessions` for that `user_id`** — all in one transaction, so the new password and the
revocation can never diverge.

The revocation is the point of the flow, not a courtesy. A reset is what someone does
when they believe another party is in their account, and a session token is a bearer
credential with a 30-day life: rotating the password alone would leave a stolen cookie
working for up to a month after the one action the user was told to take. Sessions are
plain DB rows re-read by `validateSession` on every request — there is no in-memory
cache — so the delete takes effect immediately, across every device and process.

Notes for anyone touching this:

- **Signing the user out of their other devices is intended**, not a regression to
  paper over. `POST /api/auth/reset-password` returns a bare `{ ok: true }` and mints
  no session, so the user is already headed to the login page.
- **`dropSessionsForUser` is keyed by `user_id`, so it does not hash its argument** —
  unlike its neighbours in `session-tokens.js`, which all take raw tokens. That
  asymmetry is correct; don't "fix" it by wrapping the id in `hashToken`.
- Enforced by `test/data/auth-store.test.js` ("password reset revokes every existing
  session for that user"): two sessions for the victim both die, and a third user's
  session survives — that last assertion is what catches a `DELETE` that loses its
  `WHERE user_id`.

A **"your password was changed" notice** is emailed to the account owner on success
(`renderPasswordChangedEmail`, sent from the route). That mail is the flow's only
channel back to the real owner — every other step is driven by whoever holds the
mailbox link — so it is how someone learns about an attacker-initiated reset. It is
sent **best-effort**: the password is already changed and the sessions already revoked
by the time it goes out, so a delivery failure is logged and the response is still
`{ ok: true }`. Failing the request there would tell the user their reset didn't work
when it did, and send them round the loop again.

**Not done:** the reset UI itself doesn't mention that other devices were signed out —
only the email says so.

**Still open:** `endpoint_key` remains a single, non-rotating, process-wide
secret with no per-admin identity and no audit trail, and it also guards the CSV
exports (customer emails, prompt text) and mutating routes like
`/api/admin/grant-plus`. Redacting `/authstore` removed the worst blast radius;
it did not fix the admin auth model.

## Rate limiting

`express-rate-limit`, tunable via env (see the env doc):

| Limiter | Default | Applies to |
|---|---|---|
| `RL_AUTH` | 40 / 15 min | sign-in / account actions (brute-force) |
| `RL_EMAIL` | 6 / 15 min | anything that sends email (spam/abuse) |
| `RL_GEN` | 60 / 5 min | paid AI generation (cost abuse) |
| `RL_CHECKOUT` | 10 / 60 min | `POST /api/enterprise/create-checkout` (see below) |

### The enterprise checkout is public on purpose

`POST /api/enterprise/create-checkout` takes **no session**: a company buys the plan
before anyone on it has an account, so there is nothing to authenticate. That makes
`checkoutLimiter` (`RL_CHECKOUT`, per IP) the only thing bounding it, and it covers
two distinct abuses:

- **Stripe-session spam** — every accepted request creates a real Checkout Session.
- **Customer enumeration** — the duplicate-domain branch answers differently from a
  fresh domain, so an unlimited endpoint would be a lookup service for "is *company.com*
  a Stagify enterprise customer?". The 409 no longer *says* so (it reads "not available
  for self-serve checkout … contact support"), but the branch is still distinguishable;
  the limiter is what makes probing a domain list impractical, not the wording.

Unlike the other limiters, `checkoutLimiter` is imported by
[`routes/billing.js`](../../routes/billing.js) directly rather than taken from the
`server.js` dep bag, so an omitted dep cannot leave the endpoint unlimited. The
`checkoutLimiter` dep is a **test seam only**; passing `null` mounts the real one.
Guarded by [`test/routes/billing-checkout-limit.test.js`](../../test/routes/billing-checkout-limit.test.js).

## Request-size & DoS hardening

The body parsers are the cheapest DoS surface, so they're **scoped**, not global:

- **JSON (`express.json`):** app-wide limit is **1 MB**; only the five routes that
  legitimately carry base64 images in JSON (`/api/chat`, `/api/mask-edit`,
  `/api/segment`, `/api/validate-image`, `/api/bug-report`) get **25 MB**. This matters
  because the parser runs before the per-route limiters and `JSON.parse` is
  **synchronous** — a large body on any path would otherwise buffer + block the event
  loop. Guarded by [`test/server/json-body-limit.test.js`](../../test/server/json-body-limit.test.js).
- **Multipart uploads (`multer`, memory storage):** each file is buffered whole in
  RAM, and `.fields()`/`.array()` multiply the cap by the file count, so the caps are
  kept tight:
  - staging (`process-image`, `stage-by-endpoint-key`): **25 MB**/file (×6 max)
  - `chat-upload`: **20 MB**/file (×5) + 25 MB history field
  - `host-image`: **25 MB**
  - Over-cap uploads return a clean **413** (the multer error handler sits *after* the
    routers — a subtle bit; if moved before them it silently regresses to 500).
    Guarded by [`test/server/upload-limits.test.js`](../../test/server/upload-limits.test.js).

> Photos are downscaled to 1920×1080 after receipt, so these caps are already far
> above any real upload. If a legit user hits a 413, raise the specific cap — don't
> widen the global JSON limit.

## Error responses (no stack-trace leak)

Route handlers are async, and on **Express 4** an unhandled rejection would otherwise
either hang the request or fall through to Express's built-in handler — which, when
`NODE_ENV` isn't `production`, renders the full **stack trace** to the client. Two layers
prevent that information leak:

- Every router is built with **`createAsyncRouter()`** ([`lib/http/async-router.js`](../../lib/http/async-router.js)),
  which funnels any escaped async rejection to `next(err)`.
- A **final catch-all** in `server.js` (after the Sentry hook) returns a generic
  `{ error: 'Internal server error' }` `500` — the stack trace is logged server-side (and
  captured by Sentry), never sent to the client. Guarded by
  [`test/http/async-router.test.js`](../../test/http/async-router.test.js).

## Transport & headers

- **CSP** via `helmet`, tuned for the third parties the app loads (Google, Stripe,
  Supademo/Instagram embeds, the HEIC WASM worker).
  - **`script-src` carries no `'unsafe-inline'`.** All page JS lives in external files
    under `public/scripts/` — there are no inline `<script>` blocks or `on*=` handlers
    left — so the policy genuinely blocks injected script (the core XSS defence). Keep
    it that way: any new client-side JS goes in a file, never inline. Small former
    inline snippets were extracted to dedicated files (e.g. `footer-year.js`,
    `hover-glow.js`, the two page auth-gates); mark hookup points with a `data-*`
    attribute (`data-hover-glow`, `data-print`) and bind in the external script.
  - **`style-src` still allows `'unsafe-inline'`.** The pages carry many inline
    `style=""` attributes, so this stays for now — a deliberately accepted, lower-severity
    gap (CSS injection, not JS execution).
  - Toggle the whole policy with `DISABLE_CSP=1` only to debug a blocked resource.
- **CORS** restricted to the `ALLOWED_ORIGINS` allow-list (defaults to the stagify.ai
  origins + `localhost:3000`).

## File-upload safety

- Staging and host uploads use **type `fileFilter`s** (images → jpeg/png/webp).
  **`host-image` deliberately rejects SVG** — an SVG can carry script and would
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
