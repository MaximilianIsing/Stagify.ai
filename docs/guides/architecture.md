# Architecture

How the Stagify.ai server is put together. For the project overview and setup see
[`README.md`](../README.md); for the HTTP surface see [`endpoints.md`](../reference/endpoints.md).

## The big picture

Stagify is a **static frontend + JSON API monolith** with no client framework and no
build step. One Node process (`server.js`) serves the static site in `public/` *and*
the JSON API. State lives in `data/`: user accounts/sessions in a **SQLite** database,
everything else in flat JSON/CSV files.

```
browser ──HTTP──▶ server.js ──▶ express.static('public')   (HTML/CSS/JS/images)
                     │
                     ├──▶ routers (routes/*.js)  ──▶ lib/*.js  ──▶ AI / Stripe / Resend
                     │                                    │
                     └──────────────────────────────────▶ data/  (SQLite auth + JSON/CSV)
```

## The composition-root + factory pattern

This is the single most important thing to understand about the code.

`server.js` is a **composition root**: at startup it resolves every secret and config
value, constructs the shared stores and helper functions, and then wires everything
together. The reusable logic lives in `lib/*` and `routes/*`, each of which exports a
**factory** — `createX(deps)` — rather than reaching for globals.

`server.js` calls each factory with a plain `deps` object that injects the module-scope
names those functions need (stores, helpers, config flags, and even `__dirname` /
`DEBUG_MODE`). For example:

```js
// server.js
app.use(createPublicRouter({ authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY,
  getPromptCount, getContactCount, healthHandler, /* …many more… */ }));
```

```js
// routes/public.js
export default function createPublicRouter(deps) {
  const { authStore, healthHandler, getPromptCount, /* … */ } = deps;
  const router = createAsyncRouter();          // not express.Router() — see Error handling
  router.get('/health', healthHandler);
  // …
  return router;
}
```

Why it's built this way: `server.js` grew very large, so routes and helpers are being
**extracted verbatim** into modules while preserving behavior. The DI object keeps each
extracted piece working without turning shared state into globals. When you add a
route, you add its dependency to the factory's `deps` at the `server.js` call site.

> **ESM gotcha:** the project is `"type": "module"`. There is no built-in `__dirname` —
> modules derive it with `fileURLToPath(import.meta.url)` (or receive it via `deps`).
> A path built from an undefined `__dirname` fails at request time, not at import, so
> it can slip past a boot test. Keep an eye on this when extracting file-serving code.

## Request lifecycle

Middleware runs in registration order, wired from `server.js` (steps 1–2 via
`applyEdgeMiddleware(app)` and step 5 via `applyBodyAndStatic(app)`, both in
[`lib/http/app-middleware.js`](../../lib/http/app-middleware.js); the billing router is
mounted between them so the Stripe webhook still sees the raw body):

1. **`helmet`** — security headers + Content-Security-Policy (toggle with `DISABLE_CSP=1`).
2. **`cors`** — restricted to `ALLOWED_ORIGINS`.
3. **Body parsing** — the Stripe webhook is registered with `express.raw()` **before**
   `express.json()` so signature verification sees the exact bytes; everything else
   gets parsed JSON.
4. **Rate limiters** (`express-rate-limit`) — applied to auth (`RL_AUTH`), email
   (`RL_EMAIL`), AI-generation (`RL_GEN`), and enterprise-checkout (`RL_CHECKOUT`)
   routes, among others; `lib/http/rate-limiters.js` holds the full set. The odd one
   out is `RL_ENDPOINT_KEY`, which is applied inside the guards in
   `lib/http/http-guards.js` rather than as route middleware, because it counts only
   *rejected* admin-key attempts — see `docs/guides/security.md`.

   Every limiter that actually **refuses** a request is built by `rejectingLimiter`,
   which records the refusal to `rejection_logs.csv` before answering exactly as
   express-rate-limit's default handler would. A 429 is a user hitting a wall, and none
   of them were written down anywhere before — the request is turned away by middleware,
   so it never reaches a handler that logs. The writer arrives through
   `setRateLimitRejectionLogger` (a setter, not a dep) because these limiters are module
   singletons constructed at import time, before the logging factory exists.
   `emailPixelLimiter` and `referralLimiter` are deliberately excluded: neither refuses
   anything — they flag the request and call `next()`, which is what makes them
   write-ceilings rather than rate limits.
5. **`express.static('public')`** — if a file matches the URL it is served here (with
   long-lived immutable cache headers for images/fonts/media, `no-cache` for
   html/css/js/json). This is why `/` serves `public/index.html`.
6. **Routers** (`app.use(createXRouter(...))`) — the API and dynamic routes.
7. **The 404 handler** (`createNotFoundHandler`, [`lib/http/not-found.js`](../../lib/http/not-found.js))
   — nothing claimed the path, so it answers. Mounted after every router (including the
   referral router, which is otherwise last) and before the error middleware. It is a
   **normal** middleware, not a 4-arg error handler: Express only reaches those via
   `next(err)`, and an unmatched route never produces one. See
   [The 404 handler](#the-404-handler).
8. **Error-handling middleware** (registered last, see [Error handling](#error-handling)):
   the JSON body-parse handler, the multer upload handler (after the routers so Express
   reaches it), the Sentry capture hook, and a final catch-all that returns a clean JSON
   `500` instead of leaking a stack-trace page.

## Backend modules (`lib/`)

`lib/` is organized into subdirectories by concern (plus `lib/logger.js` at the root).
Each module is a `createX(deps)` factory or a set of pure helpers.

**`lib/config/`** — configuration

| Module | Responsibility |
|---|---|
| `config.js` | Reads secrets/config from env vars, falling back to local `stripe_*.txt` / `*.txt` files. |
| `model-config.js` | Model selection + per-model temperature for the AI calls. |
| `runtime-flags.js` | Computes the boot flags once (`DEBUG_MODE`, `IS_STAGING`, `HIDE_STAGING_BANNER`, stats overrides). The bootstrap layer beneath the logger. |

**`lib/data/`** — persistence

| Module | Responsibility |
|---|---|
| `db.js` | The single shared `better-sqlite3` connection (WAL + pragmas). Every store opens through this. Re-exports `resolveDataDir` for convenience. |
| `data-dir.js` | The **one** implementation of "where durable state lives" (Render's `/data` vs `<baseDir>/data`). Separate from `db.js` so the CSV writers can import it without `better-sqlite3`. A drift test fails the build if any other file re-derives the path. |
| `auth-store.js` | User accounts, salted+hashed passwords, 30-day sessions, email registration codes, free-tier usage. Imports a legacy `auth-store.json` once on first run. Session and reset tokens are delegated to `session-tokens.js` below, so this file never touches a token row. |
| `password-hash.js` | The password hash **format**, its verifier, and the cost parameters (`PASSWORD_PARAMS`). Hashes are stored as `scrypt$N=…,r=…,p=…,keylen=…$<hex>`, so raising the cost is a one-line change: existing rows keep verifying under their own parameters and are re-hashed on the owner's next sign-in. Bare-hex rows written before this still verify. See [`security.md`](security.md#password-hashes-carry-their-cost). |
| `session-tokens.js` | The `sessions` + `password_reset_tokens` tables, end to end. Owns their statements and their **indexes** (`user_id` and `exp` — the only lookups these token-keyed tables make without a token), prunes them, and **hashes every token** (`sha256$…`) so the raw bearer value never reaches disk — the single chokepoint the auth-store writes through. Also carries the idempotent one-time migration that hashes pre-existing rows in place, keeping signed-in users signed in. See [`security.md`](security.md#tokens-at-rest). |
| `pro-grants.js` | Admin **comp grants** — one calendar month of Stagify+ with no Stripe subscription behind it. Owns the month arithmetic and the grant/revoke rules; its `applyGrantExpiry` is called from the auth-store's `rowToUser`, so a lapsed grant is downgraded on **read** rather than by a sweep job. |
| `stripe-linking.js` | Which account a Stripe subscription belongs to, and the plan that follows: `activateProFromStripeCheckout` (checkout → account) and `applyStripeSubscriptionState` (status → plan). The checkout mapping treats `client_reference_id` and `customer_email` as **unequally trustworthy** — an unverified email may start a billing relationship, never replace one. See [`security.md`](security.md#stagify-checkout-an-unverified-email-may-start-a-subscription-never-take-one-over). |
| `enterprise-store.js` | Enterprise domain activation + metered usage, kept in sync with Stripe. Because an active domain is a blanket `pro` grant to every address under it, both `activateDomain` (write) and `isActiveDomain` (read) refuse public mailbox providers. |
| `public-email-domains.js` | The list of free consumer + disposable mail domains that can **not** be sold as an enterprise domain, and the normalizing matcher (`isPublicEmailDomain`). Used by the enterprise store and `/api/enterprise/create-checkout` — **not** by signup. Rationale: [`security.md`](security.md#enterprise-domains-are-a-blanket-grant). |
| `stripe-events.js` | The Stripe **webhook idempotency ledger** (`stripe_events`). Stripe delivers at-least-once, so `routes/billing.js` claims each `event.id` before handling it and drops a redelivery. A failed handler *releases* its claim (so Stripe's retry still runs), and a claim abandoned by a killed process becomes re-claimable after 5 minutes. |
| `memory.js` | Per-user AI-chat memory storage and LLM-driven memory-action evaluation. |
| `counters.js` | The prompt/contact counters shown in the hero stats. |
| `uptime-monitor.js` | Self-hosted uptime tracking (heartbeat → the `uptime_state` row in `auth-store.db`); powers `/api/status` and the status page. |

**`lib/data/` — the gallery** (saved renders). Rows here, bytes in R2.

| Module | Responsibility |
|---|---|
| `gallery-schema.js` | The DDL for **all six** gallery tables in one constant, plus `ensureColumn`/`tableExists`. One place rather than per-factory, for the same reason `auth-store.js` holds the DDL for tables `session-tokens.js` queries: these tables reference each other across store boundaries, so per-factory creation would make construction **order** load-bearing. |
| `object-store.js` | Picks the byte backend at boot: **R2** when configured, the **local disk** off Render, and **disabled** on Render when unconfigured — falling back there would put render bytes on the same volume as `auth-store.db`. Never throws; a storage misconfiguration turns the gallery off rather than failing the boot. |
| `object-store-r2.js` / `object-store-local.js` | The two backends behind one interface. `presignGet` is **pure and synchronous** on both — a manifest mints one URL per blob on the request path, and an async signature invites a cache, which would be a revocation bug. |
| `s3-presign.js` | Synchronous SigV4 query-signing for GET only. Hand-rolled *because* it must be sync; kept honest by a differential test asserting byte-identical output to `aws4fetch` (which signs the network verbs, where async costs nothing). |
| `object-keys.js` | The key layout and the traversal gate. **No account id appears in a key** — a presigned URL goes to a stranger, and tombstones outlive the owning row. |
| `staged-renders.js` | The render rows, and the tier caps. Eviction runs **inside the insert transaction**; a cap applied in a second statement is not a cap. |
| `render-refs.js` | Furniture reference photos, content-addressed and deduped per user. Their lifetime is **derived** (an indexed `NOT EXISTS`), never counted — a double-decrement would delete bytes a live entry still shows. |
| `gallery-shares.js` | Share tokens: sha256 for lookup, plaintext alongside it so the owner can copy the link again, one live link per render enforced in a transaction. Minted a page at a time by the gallery listing — there is no create step and no off switch — and revoked rather than deleted, because a delete would take the view count with it. |
| `gallery-page-reads.js` | The three batched SQL reads behind one gallery page (blobs, references, live share links), as **text only** — each store prepares them against its own handle. Together because they share one non-obvious decision: `json_each(?)` rather than a generated `?, ?, ?` run, so the SQL text (and better-sqlite3's statement cache entry) does not vary with the page size. Exported as strings so a drift test can `EXPLAIN` the query actually prepared rather than a retyped copy. |
| `blob-tombstones.js` | The queue of object bytes owed a deletion, and the reaper that drains it. This is what lets `deleteUser` stay **synchronous** while the bytes live in someone else's datacentre: the transaction commits the *obligation*, not the deletion. |

**`lib/http/`** — request/response plumbing

| Module | Responsibility |
|---|---|
| `async-router.js` | `createAsyncRouter()` — the async-safe `express.Router()` used by every route file (see [Error handling](#error-handling)). |
| `http-helpers.js` | Small pure helpers: `sendError()` (the standard JSON error shape), `setSensitiveHeaders()`, client-IP + user-identifier helpers. |
| `error-ref.js` | `reportError(context, err)` — logs a caught error under a random 8-char reference and returns it, so a 5xx body carries `{ ref }` instead of `error.message`. See [A caught exception never goes in the body](#a-caught-exception-never-goes-in-the-body). |
| `http-guards.js` | The `endpoint_key` guards (`protectLogs`, `stagingEndpointKeyGuard`) and the `/health` handler. |
| `rate-limiters.js` | The `express-rate-limit` configs (`RL_AUTH` / `RL_EMAIL` / `RL_GEN` / `RL_CHECKOUT` / `RL_ENDPOINT_KEY` / …). |
| `uploads.js` | The multer upload configs (staging / chat / hosted-image). |
| `app-middleware.js` | The base HTTP middleware, lifted out of `server.js`. `applyEdgeMiddleware(app)` (helmet/CSP, CORS allow-list, compression — mounted **before** the billing router) and `applyBodyAndStatic(app)` (JSON body parsing + its error handler, `express.static` — mounted **after**, so Stripe's webhook still sees the raw body). |
| `not-found.js` | `createNotFoundHandler({ __dirname, DEBUG_MODE })` — the terminal 404. Deliberately a plain handler rather than a `createXRouter` factory, so it does not trip the "the referral router is mounted last" guard it sits behind. See [The 404 handler](#the-404-handler). |

**`lib/image/`** — image processing

| Module | Responsibility |
|---|---|
| `image-primitives.js` | `sharp` helpers: input downscale, aspect-ratio handling (`nearestGeminiAspectRatio` snaps a room to the nearest ratio the image models emit — passed as `imageConfig.aspectRatio` so iterative round-trips can't drift — plus the `cropToAspectRatio` safety net, and the legacy `enforceAspectRatio`/padding still used by the erase pass), marked-room compositing, and the final delivery upscale (`upscaleForDelivery` — a ~2× lanczos enlarge + gentle sharpen of the finished result, encoded as WebP; interpolation only, no added detail). |
| `image-annotation.js` | GPT-vision image annotation. |
| `image-review.js` | The quality-gate reviewer + mask-edit / stageable-image validation. All three reviewers **fail open**. The upload gatekeeper answers with a digit from the fixed taxonomy in `lib/staging/unstageable.js`, which maps to a stable `code` the browser localizes — see [`i18n.md`](i18n.md). |
| `erase.js` | Furniture-removal ("empty the room") pass. |
| `hosted-images.js` | The admin-hosted image store + manifest served at `/i/:id`. |

**`lib/services/`** — external providers

| Module | Responsibility |
|---|---|
| `ai-clients.js` | Constructs the Gemini / OpenAI / Resend clients once at boot from env (or `.txt` fallbacks). |
| `auth-helpers.js` | Cross-cutting auth/enterprise helpers (resolve user from request, enterprise domain, usage reporting, Pro gating). |
| `email.js` | Sends registration-verification email; serves the email-open tracking pixel. |
| `logging.js` | Append-only **CSV** business-event writer (prompts, chats, contacts, masks, bug reports, email opens). Not a diagnostic logger — that's `lib/logger.js`. |
| `stripe-webhooks.js` | Applies Stripe subscription lifecycle events (checkout/updated/deleted) to accounts & domains. |

**`lib/staging/`** — staging & AI Designer

| Module | Responsibility |
|---|---|
| `prompts.js` | Pure prompt/data constants for the AI Designer, staging, QA review, and image gatekeeping. Single source of truth for model-facing wording. Also holds `generatePrompt()`, which assembles the staging prompt — see [Staging prompt assembly](#staging-prompt-assembly). |
| `promptMatrix.js` | The room-type × furniture-style prompt templates used when staging — the **style** layer only (a shopping list of furniture and finishes). Non-negotiable per-room rules live in `room-constraints.js` instead. |
| `room-constraints.js` | The **rules** layer: `ROOM_TYPE_CONSTRAINTS`, per-room hard limits that hold whatever style is picked (e.g. a dorm's fixed university-issued furniture and small-room scale). Separate from the matrix because two `generatePrompt` paths skip or outrank a matrix entry — see [Where per-room rules belong](#where-per-room-rules-belong). |
| `staging-pipeline.js` | The generate-with-quality-retry loop (unit-testable, no real model calls). |
| `staging-generation.js` | The Gemini image-generation pipeline lifted out of `server.js`: the positional quality-gate wrapper plus `processImageGeneration` (text-to-image) and `processStaging` (virtual staging). `processStaging` pins the output shape to the nearest supported ratio (`imageConfig.aspectRatio`) so re-staging a downloaded result doesn't accumulate an aspect-ratio stretch. Both generators run the quality-gate winner through the delivery upscale (`upscaleForDelivery`, WebP ~2×) before returning, so the served image is larger than the model's ~1 MP native output. |
| `virtual-staging-handler.js` | The `/api/process-image` + `/api/stage-by-endpoint-key` multipart handler (`handleVirtualStagingMultipart`), lifted out of `server.js`: free-tier cap, two-stage furniture removal, per-variation staging, enterprise metering. |
| `mask-edit.js` | The `/api/mask-edit` request pipeline (locator overlay, reference letterboxing, quality-retry review), lifted out of `routes/staging.js`. |
| `segment.js` | The `/api/segment` magic-wand handler (Gemini box detection → normalized `box_2d`), lifted out of `routes/staging.js`. |
| `cad-handling.js` | Renders a floor plan (AI Designer), via Gemini. **Two views**, chosen by the routing model's `cad[].view`: `top-down` (default — a furnished 3D plan seen from above) and `eye-level` (a photorealistic interior photo taken standing inside the room named by `cad[].room`). `createCadHandling({ genAI })` — takes the **shared** client from `server.js`; it must not build its own (it used to, from a `lib/staging/key.txt` that never existed). PDFs are rasterized in the **browser** (`public/scripts/pdf-page-to-image.js`), so this module only ever sees an image. **The quality gate is deliberately OFF here** (no `reviewImageQuality` injected): measured on a clean five-room plan, both views ran the full 3 attempts and settled at 80/100, so the gate degenerated from "usually one call" into "always three calls for best-of-3" on the priciest model — and the single un-selected draw was no worse. `maxAttempts` stays at 3 so a transient provider error is still retried; the reviewer branch stays wired and specced so re-enabling is one word in `server.js`. |

**`lib/chat/`** — AI Designer chat orchestration

| Module | Responsibility |
|---|---|
| `chat-upload-prep.js` | Pre-routing prep for `/api/chat-upload`: multipart upload → GPT-ready messages + routing completion (`runUploadRouting`, which also owns the unsupported-image retry). |
| `chat-request-prep.js` | Pre-routing prep for `/api/chat` (the JSON mirror of `chat-upload-prep`): dedup diagnostics, history-image detection, message-tag application, OpenAI message assembly, payload logging, and the routing call (`runChatRouting` — the counterpart to `runUploadRouting`, minus the image-format retry, which only makes sense where a file was uploaded). It returns `{ routingError }` rather than throwing, because `/api/chat` answers a model outage with its own 500 body carrying a user-facing `response` string. |
| `welcome-message-handler.js` | The `GET /api/welcome-message` handler (generic vs. AI-personalized greeting). |
| `chat-upload-error.js` | Pure helper building the "unsupported file type" body for the `/api/chat-upload` catch block. |
| `chat-pipeline.js` | **Pure wiring**: composes the five dispatch sub-modules below into the 7-method interface both chat handlers consume (`applyMemoryActions` / `runGenerateRequests` / `resolveRecalledImage` / `resolveRequestedImage` / `runCadRequests` / `runStagingRequests` / `buildDesignerResponse`). |
| `chat-memory.js` | Applies the model's memory store/forget decisions. **The routing model decides**: `memories: { stores, forgets }` is a required field of `DESIGNER_ROUTING_SCHEMA`, so remembering costs no extra model call. `lib/data/memory.js` is storage only — it once held a second OpenAI call for this and never used it. Change memory *behaviour* in the schema + system instruction, not in the store. |
| `chat-image-retrieval.js` | Retrieves an existing history image by index (recall for display; request for optional GPT analysis). |
| `chat-image-dispatch.js` | Produces new images: text-to-image generation and floor plan → render. The CAD half also owns that render's **accounting** — `incPromptCount`, the gallery row, and the disclosure stamp params — because none of it happens anywhere else on this path (staging's copies live in `chat-staging.js`). |
| `chat-staging.js` | Runs the model's staging request(s), with the chat-vs-upload divergence injected via callbacks. |
| `chat-response.js` | Pure response assembly: awaits image annotations and builds the final JSON body. |
| `chat-history.js` | **Barrel** re-exporting the four history/image-resolution modules below (kept so existing import sites are stable); no logic of its own. |
| `chat-history-sanitize.js` | Conversation-history hygiene: strip unsupported image types, dedup messages, collapse history images to text placeholders. |
| `chat-image-collection.js` | The image index-space primitive (`collectImagesFromHistory`) plus retrieval/index queries and the GPT image-context builder. |
| `chat-image-classification.js` | Furniture-vs-room heuristics over filename/annotation + "add furniture to room" intent detection. |
| `chat-dual-upload.js` | Splits a "room + furniture" dual upload into a room buffer + furniture buffers (from multipart files or message content). |
| `chat-base-image-staging.js` | Folds the user's thumbnail selection + text intent into the staging params; resolves which history image a CAD/add-furniture request targets. |
| `chat-routing.js` | Parses the model's routing completion and classifies chat intent. |
| `chat-sse.js` | Server-Sent Events plumbing for streamed chat responses. |

**`lib/logger.js`** (root) — the diagnostic logger

The single funnel for operator-facing stdout/stderr (`logger.debug/info/warn/error`).
A raw `console.*` in `routes/`, `lib/`, or `server.js` is a lint **error** (`no-console`).
Verbosity: `LOG_LEVEL` (`debug|info|warn|error|silent`) wins; else `DEBUG_MODE` raises the
floor to `debug`; else the floor is `info`. Distinct from `lib/services/logging.js` (the
CSV business-event writer) — don't conflate the two.

## Error handling

Route handlers are `async`, and on **Express 4** a rejected promise from an async handler
is **not** forwarded to error middleware — it surfaces as an `unhandledRejection` and the
request hangs. Two pieces close that gap:

- **`createAsyncRouter()`** ([`lib/http/async-router.js`](../../lib/http/async-router.js)) —
  every route file builds its router with this instead of `express.Router()`. It wraps each
  terminal handler so an escaped rejection is routed to `next(err)`.
- **A final catch-all** in `server.js` (after the Sentry hook) — turns any error reaching
  Express's pipeline into a clean JSON `500`. Without it, an unhandled error falls through
  to Express's built-in handler, which renders the full stack trace to the client.

The same argument applies one step earlier, to requests that never reach a handler at all:
an unmatched *route* used to fall through to Express's built-in 404 (`Cannot GET /whatever`).
[The 404 handler](#the-404-handler) closes that half.

Within a handler, emit error responses through **`sendError(res, status, msg, { code, details, ref })`**
([`lib/http/http-helpers.js`](../../lib/http/http-helpers.js)) so every error body has the same
shape (`{ error }`, optionally `code` / `details` / `ref`).

### A caught exception never goes in the body

A 5xx says *that* something broke, never *what*. `details` is for fixed strings written in
the source (an operator hint, a validation reason); it is **not** a channel for
`error.message`. That was the house style at ~19 sites, and it handed the caller whatever
`sharp`, the Gemini/OpenAI SDKs, `better-sqlite3`, `fs` or Stripe had put there — absolute
server paths, table names, model and quota state, upstream prose. The AI Designer's SSE
error handler did not even read the field; it renders a fixed localized apology.

Instead, log the error under a reference and return only the reference:

```js
} catch (error) {
  sendError(res, 500, 'Failed to retrieve prompt logs', { ref: reportError('admin.promptlogs', error) });
}
```

`reportError` ([`lib/http/error-ref.js`](../../lib/http/error-ref.js)) logs the error whole —
stack included — beside a random 8-char reference and returns it, so the client gets
`{ error, ref }`. It **replaces** the site's own `logger.error` call rather than joining it.
A user quoting `ref 3f9a1c02` in a bug report is strictly more than `details` ever gave
support: a bare message carried no request context and could not be located in the logs.

`test/http/error-leak.test.js` scans every response-building call in `routes/` and `lib/`
and fails the build on `.message` / `.stack` inside one, so the old form cannot come back
in the next catch block. Multer's 400s are the documented exception (its fixed message
table describes the caller's own upload) and are allowlisted there by exact snippet.

## Routers (`routes/`)

Each is a factory returning a router (built with `createAsyncRouter()`), mounted in `server.js`.

| Router | Owns |
|---|---|
| `public.js` | SEO files (`robots.txt`, `sitemap.xml`), landing/status pages, `/health`, hero-stat counts, contact/bug logging, `/api/send-email`, hosted-image serving (`/i/:id`), email-open pixel. |
| `i18n.js` | The localized-URL pages: `/es`, `/fr/guides.html`, … rendered server-side per language from `public/languages/*.json` (`lib/i18n/`). Mounted before `public.js`; prefixes are disjoint from every other route. See [`i18n.md`](i18n.md). |
| `auth.js` | `register` / `verify` / `login` / `logout` / `me` / `forgot-password` / `reset-password` / `google`, plus the staging-banner controls. |
| `admin.js` | `endpoint_key`-gated log/data exports and hosted-image management (see [`endpoints.md`](../reference/endpoints.md)). |
| `staging.js` | Core AI: `process-image`, `mask-edit`, `segment`, `validate-image`, `stage-by-endpoint-key`. |
| `chat.js` | AI Designer chat: `/api/chat`, `/api/chat-upload`, `welcome-message`. |
| `billing.js` | Stripe checkout, customer portal, `stripe-webhook`, enterprise checkout. |

Not in the table, because it is not a router: `referrals.js` (operator-created campaign
short-URLs) is mounted **after** all of the above, and the 404 handler after that.

## The 404 handler

[`lib/http/not-found.js`](../../lib/http/not-found.js) answers everything no route and no
static file claimed. It negotiates on the request:

- **`/api/*`, or any client that does not accept HTML** (fetch, XHR, curl) → `sendError(res, 404, 'Not found')`,
  the same JSON shape as every other error on the server.
- **Everything else** → `public/404.html`, at HTTP status `404`, with `Cache-Control: no-cache`.
  The first path segment picks the locale, so `/es/nope` is Spanish and `/nope` is English.

Three decisions in it are load-bearing and each looks arbitrary on its own:

> **It is a plain `app.use`, not a `createXRouter` factory.** `routes/referrals.js` matches
> `/:slug`, and the only reason an operator-created campaign link cannot shadow a real page
> is that it is mounted after every other router — a rule
> `test/server/router-mount-order.test.js` enforces by scanning `server.js` for
> `create\w+Router(` and asserting the last one is `createReferralRouter`. A router mounted
> behind it would trip that guard for no reason: this handler claims no paths, it answers
> what is left. The name `createNotFoundHandler` keeps the guard meaningful.

> **`public/404.html` carries no `<link rel="canonical">` and no `og:url`.** `applySeoHead`
> in `lib/i18n/render-page.js` anchors the hreflang cluster to the canonical tag and the
> `og:locale` block to `og:url`; with neither present both steps no-op. That is how one
> source file serves eleven locales while emitting zero `hreflang` — a page reachable at
> every unknown URL has no canonical address to advertise. Adding a canonical back silently
> resurrects the whole cluster. See [`i18n.md`](i18n.md#the-localized-page-set).

> **English is rendered, not `sendFile`d.** 404.html's asset URLs are relative
> (`styles/styles.css`, `scripts/…`), and this handler answers at *every* path depth. Sent
> raw, a 404 at `/blog/nope` resolves them against `/blog/` and renders unstyled and
> scriptless. `renderLocalizedPage` injects `<base href="/">`, so the English branch goes
> through the same renderer as every locale rather than short-circuiting.

One hole is accepted rather than closed: `express.static` mounts before every router and
has no `extensions` option, so `/404.html` is still reachable as a plain file with a
**200**. No route can intercept it. `<meta name="robots" content="noindex, follow">` on the
page is the mitigation.

Covered by `test/routes/not-found.test.js`, which full-boots the real `server.js` — a
handler defined by its position in the pipeline proves nothing when mounted alone.

## Configuration & secrets

Loaded by [`load-env.js`](../../load-env.js) (imported first in `server.js`, before any
secret is read). Every secret resolves from its env var, falling back to a gitignored
`.txt` file. Full reference: [`environment-variables.md`](../reference/environment-variables.md).

## Data & persistence

State lives under `data/` (or the Render `/data` disk when present, detected via the
`RENDER` env var):

- **SQLite (`better-sqlite3`, one shared connection via `lib/data/db.js`):** `auth-store.db`
  holds all structured state — auth (`users`, `sessions`, …; **sensitive**),
  `enterprise_domains`, `memories`, `uptime_state`, `stripe_events`. WAL + transactions, so writes are
  atomic and per-row. Each store imports its legacy JSON (`auth-store.json`,
  `enterprise-domains.json`, `memories.json`, `uptime.json`) once on first boot, then
  keeps it as a frozen rollback fallback.
- **Append-only CSV logs:** prompts, chats, contacts, masks, bug reports, email opens.
- **Uploads:** `hosted-images/`, served via `GET /i/:id`.

Full detail in [`data-stores.md`](../reference/data-stores.md). See the **Known
limitations** section of the [README](../README.md#known-limitations): still
single-instance only (SQLite is single-writer).

## Frontend

Plain HTML/CSS/vanilla JS in `public/`, served as-is — **no build step** (a deliberate,
standing decision; see [below](#decision-no-frontend-build-step)). Pages `fetch` the
JSON API on the same origin. UI text is translated from `public/languages/*.json` — each
language server-rendered at its own URL (`/es`, `/fr/…`) for SEO, and applied client-side
for dynamic content; see [`i18n.md`](i18n.md). Note that `public/styles/styles.css` is
partially minified; edit it carefully.

The browser side has its own architecture guide — the page/entry/island model and the
standing decision to use vanilla ES modules instead of a component framework — in
[`frontend.md`](frontend.md).

## Decision: no frontend build step

**Stagify ships its frontend source unbundled, and that is a deliberate, standing
decision — not a stage we simply haven't finished.** The browser receives exactly what
lives in `public/`: hand-written HTML, CSS, and native ES-module JavaScript
(`<script type="module">`). There is no bundler, transpiler, or minifier and no
`npm run build`; the pipeline is `npm install` → `npm test` → `start`, with nothing in
between.

**Why this is the right default here:**

- **Nothing in the frontend needs a build.** It is a multi-page app — each page loads a
  few small vanilla-JS modules, with no npm frontend packages and no shared dependency
  graph to resolve. The problems bundlers exist to solve (node-module resolution,
  TS/JSX transpile, collapsing a large import tree) don't arise.
- **Native ESM runs as-authored** in every browser we target, so `import`/`export`
  needs no transpilation. The big page scripts have since migrated to native modules
  (`public/scripts/`, loaded `type="module"`), with cohesive logic extracted into
  per-page submodules — still no build step, moving *toward* this model, not away from it.
- **What ships is what you debug.** Browser line numbers match the repo, there are no
  source maps to generate, and you can edit a file and refresh. This also keeps the
  "extraction is behaviour-preserving" refactors honest.
- **Per-file caching stays granular.** Static assets are served
  `Cache-Control: public, max-age=31536000, immutable` and busted by rename / `?v=`
  (see [`caching.md`](../reference/caching.md)). A bundle would fold unrelated files
  into one cache key, so a one-line change would re-download everything.
- **The wire cost is already covered** by `compression` (gzip/brotli, `lib/http/app-middleware.js`) plus
  HTTP/2 multiplexing on Render — the two wins a bundler would buy (smaller bytes, fewer
  round-trips) without owning a toolchain to get them.
- **No build means no build to break, version, or maintain** — no bundler config, no
  transpile-target drift, and no new failure mode between a green test and a live deploy.

**What we accept in exchange:**

- **No JS minification or tree-shaking.** Files ship at authored size (gzip/brotli
  offsets most of the difference). `styles.css` is hand-minified for the same reason —
  edit it carefully.
- **Browser-native only.** No TypeScript *source*, no JSX, and no npm frontend package
  unless it is vendored into `public/` by hand. (The `.js` is still statically
  **type-checked** via `checkJs` + JSDoc — but as a linter that emits nothing, so it
  stays a check, not a build step. See [`testing.md`](testing.md#type-checking).)
- **More requests per page** — mitigated by HTTP/2 + caching, not eliminated.

> **When to reopen this — and only then:** the frontend takes on a real dependency graph
> or npm UI libraries that need resolution/bundling; we want TypeScript or JSX; a client
> framework is adopted (currently *deferred* in favour of incremental vanilla "islands",
> not planned); or measured load time becomes dominated by JS request count/size in a
> way HTTP/2 + compression cannot fix. Absent one of those triggers, the answer to
> "should we add a build step?" is **no** — don't re-litigate it per-PR.

## Staging prompt assembly

`generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture)` in
[`lib/staging/prompts.js`](../../lib/staging/prompts.js) builds the text sent to the image
model. It concatenates, **in this order**:

1. **The removal clause** — either "remove all existing furniture first" or the
   keep-existing-furniture block, depending on `removeFurniture`.
2. **The base text** — `promptMatrix[roomType][furnitureStyle]`, falling back to that
   room's `standard` entry, then to a generic `Stage this <roomType> professionally.`
   **Exception:** when `furnitureStyle === 'custom'` and an `additionalPrompt` is present,
   the user's own text replaces this entirely and the matrix is never consulted.
3. **The keep-furniture clarifier** — reframes the matrix's shopping list as *style*
   guidance so existing pieces aren't swapped out (omitted when removing).
4. **`ROOM_TYPE_CONSTRAINTS[roomType]`** from
   [`room-constraints.js`](../../lib/staging/room-constraints.js), if the room has one —
   see below.
5. **The global blocks** — preserve-architecture, defect-free staging, image framing,
   targeted-edit rule.
6. **The priority suffix** — a non-custom `additionalPrompt`, appended last.

### Where per-room rules belong

A room type's *style* text goes in `promptMatrix.js`. A room type's **hard rules** go in
`ROOM_TYPE_CONSTRAINTS` in
[`room-constraints.js`](../../lib/staging/room-constraints.js). The distinction is not
cosmetic — two paths skip or outrank the matrix, and a constraint placed there is silently
lost on both:

- **Custom style bypasses the matrix** (step 2 above), so matrix-resident rules vanish
  exactly when a user types a freeform request.
- **The removal clause is prepended before the matrix text** (step 1), so
  "remove all existing furniture" outranks anything the matrix says about keeping
  something.

`Dorm` is the worked example: a college dorm's university-issued desk, bed frame/posts,
wardrobe and dresser cannot be changed by the student, so a staging that restyles them is
useless. Those rules sit in `ROOM_TYPE_CONSTRAINTS` at step 4 — after the removal clause,
and applied to every style — and say so explicitly ("overrides every other instruction
above"). [`test/staging/prompts.test.js`](../../test/staging/prompts.test.js) pins both the custom-style
and remove-furniture cases, including the block **ordering**.

### Adding a room type

A room type is a cross-cutting change. Miss a step and it fails *quietly* — the wrong
prompt, or an English label, not an error:

1. **[`lib/staging/promptMatrix.js`](../../lib/staging/promptMatrix.js)** — add the key
   with **all 8 style entries** (`standard`, `modern`, `midcentury`, `scandinavian`,
   `luxury`, `coastal`, `farmhouse`, `custom`) and extend the JSDoc union on the export.
2. **[`lib/staging/room-constraints.js`](../../lib/staging/room-constraints.js)** — only
   if the room has non-negotiable rules (see above). Most don't.
3. **The AI Designer routing enum** — `DESIGNER_ROUTING_SCHEMA.properties.staging.items.properties.roomType.enum`
   in `prompts.js`, **plus the same list spelled out in prose** in both
   `buildChatSystemInstruction` and `buildChatUploadSystemInstruction`. Omitting it here
   doesn't error: the model just picks `Other`, which has no matrix entry, so chat
   requests for that room stage from the generic prompt.
4. **[`public/index.html`](../../public/index.html)** — a `.option` in `#room-type-select`.
   The `data-value` is the **English** key and is what the API receives; `data-lang` only
   controls the visible label. See [`frontend.md`](frontend.md#the-custom-select).
5. **All 11 language packs** — `roomTypes.<camelCaseKey>` in every
   `public/languages/*.json`.
6. **Tests** — [`test/i18n/room-types-i18n.test.js`](../../test/i18n/room-types-i18n.test.js) already
   guards steps 1, 3, 4 and 5 against each other, so a missed step fails the build. Add
   prompt-behavior tests to `test/staging/prompts.test.js` if you added step 2.

No rebuild is needed (`build-i18n-seo.js` covers locales and pages, not room types).

## Exterior prompt assembly (the Exterior Studio)

The Exterior Studio does not go through `generatePrompt` at all. It has no room type and no
furniture style — it *removes* things from a photograph and relights it, where interior
staging *invents* a room. `buildExteriorPrompt(options)` in
[`lib/staging/exterior-prompts.js`](../../lib/staging/exterior-prompts.js) concatenates,
**in this order**:

1. **The requested edits** — the time-of-day and sky clauses plus any cleanup clauses, one
   bullet each. Every option is **opt-in**: a preset set to `keep` and an unticked toggle
   contribute *nothing*. A silent no-op, deliberately — "leave the sky unchanged" reads to
   an image model as an instruction to do something about the sky.
2. **The user's free text**, as `ALSO APPLY …`. When there are no other edits it becomes
   the whole request instead, so "remove the bin bags" is not padded with a generic
   correction pass that ends "change nothing else" and contradicts it.
3. **The realism block** — the failure modes *this* edit produces (halos along the
   roofline, sky showing through solid walls, shadows that disagree with the new sky), not
   the interior ones.
4. **`IMAGE_FRAMING_PRESERVATION_RULES`**, shared with `generatePrompt` — one definition of
   "do not move the camera".
5. **`EXTERIOR_PRESERVATION_RULES`, last**, and last is the point: it claims to override
   everything above it, including the user's own words, which is only true if nothing
   follows it. Same ordering contract `ROOM_TYPE_CONSTRAINTS` relies on.

`EXTERIOR_PRESERVATION_RULES` has **two tiers**, and the split is the product decision.
Tier 1 is the property itself — structure, roofline, windows, landscaping, power lines,
resurfacing, neighbouring land — and **no request may reach it**, because those change what
a buyer walks up to and the listing agent answers for it under NAR Article 12. Tier 2 is
surface finish (paint, cladding), which the free-text box *may* override, mirroring
`generatePrompt`'s own "unless the user explicitly requested it".

Two more things differ from the interior path, both on `StagingParams`:

- **`promptOverride`** — supplies the whole prompt, so `generatePrompt` never runs. Without
  it the fallback would be `generatePrompt('Exterior', …)`, and `Exterior` has no
  `promptMatrix` entry, so it would stage *furniture onto a driveway* from the generic
  prompt and return a plausible-looking image.
- **`skipQualityReview`** — turns off the review-and-reshoot loop. Scoring three attempts
  is worth it when the model is inventing a room; on this path a re-roll returns a
  different sky, not a better one. The retry on a *thrown* provider error is unaffected,
  and the render is **not** marked `_qaDegraded` (that flag means the reviewer broke).

The option vocabulary lives in three places at once — the `<select>` values in
`public/exterior-studio.html`, the clause tables in `exterior-prompts.js`, and
`exteriorStudio.*` in all 11 language packs. None of them fails loudly alone, so
[`test/i18n/exterior-options-i18n.test.js`](../../test/i18n/exterior-options-i18n.test.js)
ties them together.

## Conventions & gotchas

- **Factory + DI everywhere.** New shared logic should be a `createX(deps)` factory,
  wired at the `server.js` composition root — not a global.
- **New route files use `createAsyncRouter()`**, never `express.Router()`, and report
  errors via `sendError()`. See [Error handling](#error-handling).
- **Diagnostics go through `logger`**, not `console.*` (a raw `console` in `routes/`/`lib/`/
  `server.js` is a lint error). `lib/services/logging.js` is a separate thing — the CSV
  business-event writer, not a stdout logger.
- **ESM, no `__dirname`.** Derive paths from `import.meta.url`.
- **Everything is type-checked (`checkJs` + JSDoc).** Backend and frontend both run under
  `tsc --noEmit` inside `npm test`, with **zero `@ts-nocheck`** — a type error blocks the
  deploy. Add JSDoc types to new code; don't reach for a `@ts-nocheck` escape hatch. See
  [`testing.md`](testing.md#type-checking).
- **No frontend build — on purpose.** Write browser-native HTML/CSS/ESM; don't reach
  for a bundler, transpiler, or npm frontend package. The reasoning and the (narrow)
  conditions that would reopen it are in [Decision: no frontend build step](#decision-no-frontend-build-step).
- **Extraction is ongoing.** `server.js` is being split into `routes/` + `lib/`;
  changes are meant to be behavior-preserving. The `route-inventory` test guards
  against accidentally dropping a route during a refactor.
- **Deploys are manual.** `render.yaml` sets `autoDeploy: false`, so a push does **not**
  ship — you deploy from the Render dashboard. The build still runs the test suite, so a
  red test blocks the deploy. See [`../operations/deployment.md`](../operations/deployment.md)
  and [`testing.md`](testing.md).
