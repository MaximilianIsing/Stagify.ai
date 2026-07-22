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
   (`RL_EMAIL`), and AI-generation (`RL_GEN`) routes.
5. **`express.static('public')`** — if a file matches the URL it is served here (with
   long-lived immutable cache headers for images/fonts/media, `no-cache` for
   html/css/js/json). This is why `/` serves `public/index.html`.
6. **Routers** (`app.use(createXRouter(...))`) — the API and dynamic routes.
7. **Explicit fallback routes** and a default 404.
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
| `db.js` | The single shared `better-sqlite3` connection (WAL + pragmas) and `resolveDataDir()`. Every store opens through this. |
| `auth-store.js` | User accounts, salted+hashed passwords, 30-day sessions, email registration codes, free-tier usage. Imports a legacy `auth-store.json` once on first run. |
| `pro-grants.js` | Admin **comp grants** — one calendar month of Stagify+ with no Stripe subscription behind it. Owns the month arithmetic and the grant/revoke rules; its `applyGrantExpiry` is called from the auth-store's `rowToUser`, so a lapsed grant is downgraded on **read** rather than by a sweep job. |
| `enterprise-store.js` | Enterprise domain activation + metered usage, kept in sync with Stripe. |
| `memory.js` | Per-user AI-chat memory storage and LLM-driven memory-action evaluation. |
| `counters.js` | The prompt/contact counters shown in the hero stats. |
| `uptime-monitor.js` | Self-hosted uptime tracking (heartbeat → the `uptime_state` row in `auth-store.db`); powers `/api/status` and the status page. |

**`lib/http/`** — request/response plumbing

| Module | Responsibility |
|---|---|
| `async-router.js` | `createAsyncRouter()` — the async-safe `express.Router()` used by every route file (see [Error handling](#error-handling)). |
| `http-helpers.js` | Small pure helpers: `sendError()` (the standard JSON error shape), `setSensitiveHeaders()`, client-IP + user-identifier helpers. |
| `http-guards.js` | The `endpoint_key` guards (`protectLogs`, `stagingEndpointKeyGuard`) and the `/health` handler. |
| `rate-limiters.js` | The `express-rate-limit` configs (`RL_AUTH` / `RL_EMAIL` / `RL_GEN`). |
| `uploads.js` | The multer upload configs (staging / chat / hosted-image). |
| `app-middleware.js` | The base HTTP middleware, lifted out of `server.js`. `applyEdgeMiddleware(app)` (helmet/CSP, CORS allow-list, compression — mounted **before** the billing router) and `applyBodyAndStatic(app)` (JSON body parsing + its error handler, `express.static` — mounted **after**, so Stripe's webhook still sees the raw body). |

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
| `prompts.js` | Pure prompt/data constants for the AI Designer, staging, QA review, and image gatekeeping. Single source of truth for model-facing wording. |
| `promptMatrix.js` | The room-type × furniture-style prompt templates used when staging. |
| `staging-pipeline.js` | The generate-with-quality-retry loop (unit-testable, no real model calls). |
| `staging-generation.js` | The Gemini image-generation pipeline lifted out of `server.js`: the positional quality-gate wrapper plus `processImageGeneration` (text-to-image) and `processStaging` (virtual staging). `processStaging` pins the output shape to the nearest supported ratio (`imageConfig.aspectRatio`) so re-staging a downloaded result doesn't accumulate an aspect-ratio stretch. Both generators run the quality-gate winner through the delivery upscale (`upscaleForDelivery`, WebP ~2×) before returning, so the served image is larger than the model's ~1 MP native output. |
| `virtual-staging-handler.js` | The `/api/process-image` + `/api/stage-by-endpoint-key` multipart handler (`handleVirtualStagingMultipart`), lifted out of `server.js`: free-tier cap, two-stage furniture removal, per-variation staging, enterprise metering. |
| `mask-edit.js` | The `/api/mask-edit` request pipeline (locator overlay, reference letterboxing, quality-retry review), lifted out of `routes/staging.js`. |
| `segment.js` | The `/api/segment` magic-wand handler (Gemini box detection → normalized `box_2d`), lifted out of `routes/staging.js`. |
| `cad-handling.js` | Converts CAD/PDF floor plans into photorealistic 3D renders (AI Designer), via Gemini. |

**`lib/chat/`** — AI Designer chat orchestration

| Module | Responsibility |
|---|---|
| `chat-upload-prep.js` | Pre-routing prep for `/api/chat-upload`: multipart upload → GPT-ready messages + routing completion. |
| `chat-request-prep.js` | Pre-routing prep for `/api/chat` (the JSON mirror of `chat-upload-prep`): dedup diagnostics, history-image detection, message-tag application, OpenAI message assembly, payload logging. |
| `welcome-message-handler.js` | The `GET /api/welcome-message` handler (generic vs. AI-personalized greeting). |
| `chat-upload-error.js` | Pure helper building the "unsupported file type" body for the `/api/chat-upload` catch block. |
| `chat-pipeline.js` | **Pure wiring**: composes the five dispatch sub-modules below into the 7-method interface both chat handlers consume (`applyMemoryActions` / `runGenerateRequests` / `resolveRecalledImage` / `resolveRequestedImage` / `runCadRequests` / `runStagingRequests` / `buildDesignerResponse`). |
| `chat-memory.js` | Applies the model's memory store/forget decisions. |
| `chat-image-retrieval.js` | Retrieves an existing history image by index (recall for display; request for optional GPT analysis). |
| `chat-image-dispatch.js` | Produces new images: text-to-image generation and CAD blueprint → 3D render. |
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

Within a handler, emit error responses through **`sendError(res, status, msg, { code, details })`**
([`lib/http/http-helpers.js`](../../lib/http/http-helpers.js)) so every error body has the same
shape (`{ error }`, optionally `code` / `details`).

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

## Configuration & secrets

Loaded by [`load-env.js`](../../load-env.js) (imported first in `server.js`, before any
secret is read). Every secret resolves from its env var, falling back to a gitignored
`.txt` file. Full reference: [`environment-variables.md`](../reference/environment-variables.md).

## Data & persistence

State lives under `data/` (or the Render `/data` disk when present, detected via the
`RENDER` env var):

- **SQLite (`better-sqlite3`, one shared connection via `lib/data/db.js`):** `auth-store.db`
  holds all structured state — auth (`users`, `sessions`, …; **sensitive**),
  `enterprise_domains`, `memories`, `uptime_state`. WAL + transactions, so writes are
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
