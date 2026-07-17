# Stagify.ai

AI-powered virtual staging and interior design for real estate. Upload a photo of
an empty or dated room and get a professionally staged result in about eight
seconds. Also includes an **AI Designer** (chat-to-stage, and CAD/PDF floor plans →
photorealistic 3D renders) and a **Masking Studio** for pixel-precise edits.

This README is the entry point for the `docs/` folder. See also:

- [`guides/architecture.md`](guides/architecture.md) — how the server is structured (composition root, `routes/` + `lib/`, request lifecycle).
- [`guides/frontend.md`](guides/frontend.md) — the browser side: the page/entry/island model and why it's vanilla ES modules, not a component framework.
- [`guides/security.md`](guides/security.md) — auth model, request-size/DoS hardening, rate limits, CSP/CORS, and secret handling.
- [`guides/i18n.md`](guides/i18n.md) — the client-side translation system and how to add a language.
- [`guides/testing.md`](guides/testing.md) — the test suite and how it gates deployment.
- [`reference/endpoints.md`](reference/endpoints.md) — HTTP API reference.
- [`reference/environment-variables.md`](reference/environment-variables.md) — every env var, with a copy-paste `.env`.
- [`reference/data-stores.md`](reference/data-stores.md) — the SQLite / JSON / CSV files, their shapes, where they live, and the single-instance caveats.
- [`reference/caching.md`](reference/caching.md) — static asset `Cache-Control` policy, Render edge caching, and the rename/`?v=` cache-busting rule.
- [`operations/deployment.md`](operations/deployment.md) — deploy runbook, staging vs production, `/data` backup, and rollback.

---

## Table of contents

- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Running the app](#running-the-app)
- [Configuration & secrets](#configuration--secrets)
- [Architecture](#architecture)
- [Backend modules](#backend-modules)
- [Frontend](#frontend)
- [Data & persistence](#data--persistence)
- [HTTP API](#http-api)
- [Third-party integrations](#third-party-integrations)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [Security notes](#security-notes)

---

## Tech stack

- **Runtime:** Node.js ≥ 18, ES modules (`"type": "module"`).
- **Server:** Express 4 — a composition-root `server.js` that mounts route modules
  (`routes/*.js`) and wires shared `lib/` dependencies, serving both the static
  frontend and the JSON API from one origin.
- **Frontend:** Plain HTML/CSS/vanilla JS in `public/`. **No build step, no framework,
  no bundler** — files are served as-is.
- **Image processing:** `sharp`.
- **AI:** Google Generative AI (Gemini) for staging/renders, OpenAI for the chat assistant.
- **Email:** Resend. **Billing:** Stripe. **Auth:** local accounts + Google Sign-In.
- **Security middleware:** `helmet` (CSP), `cors`, `express-rate-limit`.

## Repository layout

```
.
├── server.js                # Composition root: loads config, wires deps, mounts routes/, serves static
├── instrument.js            # Sentry init (always imported before server.js via `node --import`; no-op when SENTRY_DSN is unset)
├── load-env.js              # Zero-dependency .env loader (imported first, before any secret)
├── render.yaml              # Render deploy config (build/start run the scripts below)
├── litestream.yml           # Litestream config: replicate the SQLite DB to Cloudflare R2
├── scripts/                 # Deploy scripts
│   ├── build.sh             # Render build: npm install → npm test (gate) → fetch litestream
│   └── start.sh             # Render start: restore DB from R2 if empty → replicate → run app
├── package.json             # Scripts, deps, Node engine
├── routes/                  # Express route modules, mounted by server.js
│   ├── public.js            # Home/SEO/status pages, health, counters, contact, email, bug reports
│   ├── auth.js              # Register/login/Google/logout/reset, /getpro, /api/auth/config
│   ├── billing.js           # Stripe webhook, customer portal, enterprise config + checkout
│   ├── staging.js           # process-image, validate-image, mask-edit, segment
│   ├── chat.js              # AI Designer: chat, chat-upload, welcome-message
│   └── admin.js             # /admin + log/JSON exports + image hosting (endpoint_key gated)
├── lib/                     # Shared modules (factory + dependency-injection pattern)
│   ├── logger.js            # Diagnostic logger — the single stdout/stderr funnel (LOG_LEVEL)
│   ├── config/              # config.js (secrets), model-config.js, runtime-flags.js
│   ├── data/                # db.js (shared SQLite conn), auth-store, enterprise-store, memory, counters, uptime-monitor
│   ├── http/                # async-router, http-helpers (sendError), http-guards, rate-limiters, uploads, app-middleware
│   ├── image/               # image-primitives, image-annotation, image-review, erase, hosted-images
│   ├── services/            # ai-clients, auth-helpers, email, logging (CSV), stripe-webhooks
│   ├── staging/             # prompts, promptMatrix, staging-pipeline, staging-generation, virtual-staging-handler, mask-edit, segment, cad-handling
│   └── chat/                # chat-pipeline (wiring) + memory/image-retrieval/image-dispatch/staging/response dispatch, request-prep, upload-prep, welcome-message-handler, history, routing, sse
├── public/                  # Static frontend (HTML pages, scripts, styles, assets, i18n)
├── data/                    # Runtime state: one SQLite DB (all structured state) + CSV logs (see Data & persistence)
├── test/                    # `node --test` suite (unit + smoke + route inventory)
├── e2e/                     # Playwright browser smokes of the two studios (npm run test:e2e)
├── ds-bundle/               # design-system bundle (generated)
├── to-build/                # source masters: media-png, OG_Image, demos (see to-build/README.md)
└── docs/                    # You are here
```

## Prerequisites

- Node.js ≥ 18 and npm.
- API keys for the features you want to exercise (all optional except Gemini for the
  core staging flow) — see [Configuration & secrets](#configuration--secrets).

## Local setup

```bash
npm install
```

Then provide configuration. The simplest path is a project-root `.env` file (it is
gitignored). Copy the template from [`environment-variables.md`](reference/environment-variables.md)
and fill in what you need. At minimum, staging requires a Gemini key:

```dotenv
GOOGLE_AI_API_KEY=your_key_here
```

Secrets can alternatively be supplied as local `.txt` files (e.g. `key.txt`,
`stripe_secret_key.txt`) — see the env doc for the full mapping. `load-env.js` never
overwrites a variable already present in the real environment, so host-provided
config always wins.

## Running the app

```bash
npm start         # node server.js       → http://localhost:3000
npm run dev       # nodemon server.js    → auto-restart on change
npm test          # typecheck + node --test → unit/integration suite (gates deploy)
npm run typecheck # tsc --noEmit (checkJs) → backend + frontend type-check, no build
npm run test:e2e  # playwright test       → browser smokes (e2e/, real Chromium)
npm run lint      # eslint . --max-warnings=0
```

`server.js` serves the static site (`/`, `/index.html`, etc.) and the JSON API from
the same port (default `3000`, override with `PORT`).

## Configuration & secrets

All runtime configuration is environment-variable driven, loaded by `load-env.js`
before any secret is read. The full, commented list lives in
[`environment-variables.md`](reference/environment-variables.md). Highlights:

- **AI:** `GOOGLE_AI_API_KEY` (Gemini, required for staging), `GPT_KEY` (OpenAI, chat).
- **Billing:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
  `ENTERPRISE_PRICE_ID`.
- **Auth:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Email:** `RESEND_API_KEY`.
- **Admin:** `endpoint_key` (guards the log/admin endpoints — note the lowercase name).
- **Debug:** `DEBUG`, `EMAIL_DEBUG`, `STATS_DEBUG` (+ `DEBUG_ROOMS` / `DEBUG_USERS`).

Every secret has a `.txt` file fallback for local dev; the server reads the env var
first, then the file.

## Architecture

Stagify is a **static frontend + JSON API monolith**. There is no client framework
and no server-side rendering — `public/` is plain HTML that talks to `server.js` over
`fetch`.

- **Request flow:** browser loads a static HTML page → vanilla JS (`public/scripts/`)
  calls JSON endpoints → `server.js` validates, calls the relevant AI/billing/email
  provider, persists to `data/`, and responds.
- **Secret resolution:** each secret resolves from its env var, falling back to a
  local `.txt` file (handy for local dev; production uses the host dashboard).
- **Persistence:** SQLite (`auth-store.db`) for accounts/sessions, plus flat JSON/CSV
  files under `data/` for everything else (see below).
- **i18n:** UI strings live in `public/languages/*.json` (11 languages) and are applied
  client-side by `language-loader.js` / `language-switcher.js`; prices remain USD.

## Backend modules

`server.js` is a composition root: it reads config, constructs the shared stores/
helpers, and mounts the route modules in `routes/` (`public`, `auth`, `billing`,
`staging`, `chat`, `admin`), injecting the reusable pieces from `lib/`. `lib/` is
grouped into subdirectories by concern (full breakdown in
[`guides/architecture.md`](guides/architecture.md#backend-modules-lib)):

| Area | Key modules |
|---|---|
| `lib/config/` | `config.js` (secrets, env → `.txt` fallback), `model-config.js`, `runtime-flags.js` (`DEBUG_MODE` / `IS_STAGING` flags). |
| `lib/data/` | `db.js` (the single shared `better-sqlite3` connection), `auth-store.js` (accounts/sessions, **SQLite-backed**), `enterprise-store.js`, `memory.js`, `counters.js`, `uptime-monitor.js`. |
| `lib/http/` | `async-router.js` (`createAsyncRouter()`), `http-helpers.js` (`sendError`, sensitive headers), `http-guards.js` (`endpoint_key`), `rate-limiters.js`, `uploads.js` (multer), `app-middleware.js` (helmet/CORS/compression + body-parse/static, wired from `server.js`). |
| `lib/image/` | `image-primitives.js` (`sharp`), `image-annotation.js`, `image-review.js` (quality gate), `erase.js`, `hosted-images.js`. |
| `lib/services/` | `ai-clients.js` (Gemini/OpenAI/Resend), `auth-helpers.js`, `email.js`, `logging.js` (append-only **CSV** business logs), `stripe-webhooks.js`. |
| `lib/staging/` | `prompts.js`, `promptMatrix.js`, `staging-pipeline.js` (quality-retry loop), `staging-generation.js` (`processStaging`/`processImageGeneration`) + `virtual-staging-handler.js` (from `server.js`), `mask-edit.js` / `segment.js` (from `routes/staging.js`), `cad-handling.js` (CAD/PDF → 3D). |
| `lib/chat/` | `chat-pipeline.js` (pure wiring) composing `chat-memory.js` / `chat-image-retrieval.js` / `chat-image-dispatch.js` / `chat-staging.js` / `chat-response.js`; pre-routing `chat-upload-prep.js` / `chat-request-prep.js` / `welcome-message-handler.js` / `chat-upload-error.js`; `chat-history.js` (barrel over `chat-history-sanitize.js` / `chat-image-collection.js` / `chat-image-classification.js` / `chat-dual-upload.js` / `chat-base-image-staging.js`), `chat-routing.js`, `chat-sse.js`. |
| `lib/logger.js` | The **diagnostic** logger — the single `logger.debug/info/warn/error` stdout funnel (`LOG_LEVEL`). Distinct from `services/logging.js` (CSV). |

## Frontend

Everything the browser loads is under `public/`:

- **Pages:** `index.html` (the staging tool + marketing home), `ai-designer.html`,
  `masking-studio.html`, `stagify-plus.html`, `plus-welcome.html` (post-checkout
  "Welcome to Stagify+" confirmation — the Stripe Payment Link's after-payment
  redirect target and the Google Ads conversion page), `enterprise.html`,
  `guides.html`, `contact.html`, `admin.html`, legal pages, plus legacy redirect
  stubs (`pro.html` → `stagify-plus.html`, `faq.html` → `index.html#faq`). Which
  pages are indexed vs `noindex` vs redirect stub — and how `robots.txt`,
  `sitemap.xml`, and `rel="canonical"` stay in sync — is documented in
  [`reference/endpoints.md`](reference/endpoints.md#public-pages--seo-no-api-key).
- **Scripts (`public/scripts/`):** e.g. `app.js` (main staging tool), `auth.js`,
  `mask-core.js` (shared masking canvas math), `count-up.js` (hero stats),
  `carousel.js`, `home-reveal.js`, and the `language-*.js` i18n helpers.
- **Styles (`public/styles/`):** a site-wide base `styles.css` (partially minified — edit
  with care) plus per-page (`home.css`, `ai-designer.css`, …) and opt-in per-feature
  (`auth.css`, `carousel.css`, `demo-player.css`, …) files, linked à la carte per page.
  See [`guides/frontend.md`](guides/frontend.md#styles) for the tiers, the lazy
  (non-render-blocking) CSS on the home page, and the FOUC auth gates.
- **i18n (`public/languages/`):** one JSON file per language; `english.json` is the
  source of truth for keys.
- **Assets:** `media-webp/`, `fonts/`, `background.mp4`, `bimi-logo.svg`, icons,
  `sitemap.xml`, `robots.txt`, `manifest.json`.

## Data & persistence

State is stored in `data/` — **one SQLite database** for all structured state, plus flat
files for logs and uploads. Full detail: [`reference/data-stores.md`](reference/data-stores.md).

| File | Contents |
|---|---|
| `auth-store.db` | **SQLite** (`better-sqlite3`, WAL) — the single app database, one shared connection (`lib/data/db.js`). Tables: auth (`users`, `sessions`, …, **sensitive**: hashed passwords + session tokens), `enterprise_domains`, `memories`, `uptime_state`. Each store imports its legacy JSON once on first run, then leaves it as a frozen fallback. |
| `hosted-images/` | User-hosted image uploads served via `/i/:id`. |
| `*_logs.csv` | Append-only logs: prompts, chats, contacts, masks, bug reports, email opens. |
| `*.json` (legacy) | `auth-store.json`, `enterprise-domains.json`, `memories.json`, `uptime.json` — pre-SQLite stores, now frozen import fallbacks. |

On Render, when a persistent disk is mounted at `/data`, these are written there
instead of the repo `data/` folder (detected via the `RENDER` env var). The log/admin
endpoints that read these files are protected by `endpoint_key`.

## HTTP API

Served from `server.js` on the same origin. Full reference: [`endpoints.md`](reference/endpoints.md).
Rough groups:

- **Core AI:** `POST /api/process-image` (stage), `/api/mask-edit`, `/api/segment`,
  `/api/validate-image`, `/api/stage-by-endpoint-key`.
- **Auth:** `/api/auth/register`, `/register/verify`, `/login`, `/logout`, `/me`,
  `/forgot-password`, `/reset-password`, `/google`.
- **Billing:** `/api/billing/customer-portal`, `/api/billing/stripe-webhook`,
  `/api/enterprise/create-checkout`.
- **Chat:** `/api/chat`, `/api/chat-upload`, `/api/welcome-message`.
- **Images/hosting:** `/api/host-image`, `/api/hosted-images`, `GET /i/:id`.
- **Misc:** `/api/contact-count`, `/api/prompt-count`, `/api/bug-report`,
  `/api/send-email`, `/health`, `/api/health`.
- **Admin/logs (gated by `endpoint_key`):** `/promptlogs`, `/chatlogs`, `/contactlogs`,
  `/masklogs`, `/bugreports`, `/authstore`, `/enterprise-domains`, `/memories`, etc.

## Third-party integrations

| Provider | Used for | Key(s) |
|---|---|---|
| Google Generative AI (Gemini) | Staging & 3D renders | `GOOGLE_AI_API_KEY` |
| OpenAI | Chat assistant | `GPT_KEY` |
| Resend | Transactional email | `RESEND_API_KEY` |
| Stripe | Subscriptions & metered enterprise billing | `STRIPE_*`, `ENTERPRISE_PRICE_ID` |
| Google Identity | "Sign in with Google" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |

Each integration degrades gracefully: if its key is missing, that feature is disabled
rather than crashing the server.

## Testing

```bash
npm test         # typecheck (tsc --noEmit) then node --test over test/**/*.test.js (gates deploy)
npm run test:e2e # end-to-end — Playwright browser smokes under e2e/
```

Full detail in [`guides/testing.md`](guides/testing.md):

- **Type-check** — `npm test` first runs `npm run typecheck`: `tsc --noEmit` over the
  backend plus a frontend checkJs pass. The whole codebase is type-checked as plain JS +
  JSDoc (`checkJs`, **no build step**, **zero `@ts-nocheck`**); a type error blocks the
  deploy like a red test.
- **Unit / integration** — the built-in Node test runner over `test/**/*.test.js`, with
  shared setup under `test/helpers/`. Fast, hermetic, no real keys or paid API calls.
  `route-inventory.test.js` boots the server and asserts every critical route is still
  registered — a safety net for the route extraction.
- **End-to-end** — [Playwright](https://playwright.dev) specs under `e2e/` drive the real
  studios in a real Chromium with every `/api/*` call mocked (no AI, no cost). Covers the
  AI Designer and Masking Studio happy paths, their error paths, and session resume.

> **`npm test` gates deployment** — `render.yaml`'s build runs `sh scripts/build.sh`
> → `npm test`, so a type error **or** a failing unit test blocks the Render deploy. The
> Playwright e2e job runs in GitHub CI but is kept out of the deploy gate (browser flake
> must never wedge a release). Keep both green.

## Deployment

Deployed on **Render** as a single web service, configured by [`render.yaml`](../render.yaml):

- **Build:** `sh scripts/build.sh` — `npm install`, the `npm test` gate, then downloads the Litestream backup binary.
- **Start:** `sh scripts/start.sh` — restores the DB from Cloudflare R2 if the disk is empty, then runs the app under continuous Litestream replication (see [`operations/deployment.md`](operations/deployment.md)).
- **Auto-deploy:** off (`autoDeploy: false`) — a push does **not** deploy on its own; deploys are triggered manually from the Render dashboard.
- **Env:** environment variables (including secrets like `GOOGLE_AI_API_KEY`) are
  entered in the Render dashboard, never committed — `render.yaml` intentionally carries
  no `envVars` block (see [`reference/environment-variables.md`](reference/environment-variables.md)).
- **Persistence:** a disk mounted at `/data` holds the SQLite database (`auth-store.db`)
  and the CSV logs across deploys.
- **Static caching:** assets are served with per-type `Cache-Control` headers; Render
  edge caching can be enabled safely on top — see [`reference/caching.md`](reference/caching.md).

Auto-deploy is off, so pushing to the default branch does **not** release on its own —
start each deploy manually from the Render dashboard (the build reruns `npm test`, so a
red test still blocks it).

## Known limitations

The persistence layer is deliberately simple — a single SQLite database for all
structured state plus flat CSV logs — which has real consequences you must design
around:

- **Single instance only.** All state lives in `data/` (or the Render `/data` disk).
  SQLite is single-writer, so running more than one server instance concurrently will
  corrupt shared state — **do not scale horizontally** without first moving to a
  client/server datastore (e.g. Postgres). (The rate limiter and uptime timer are
  in-memory single-instance state too.)
- **Structured state is durable.** Accounts, sessions, enterprise domains, memories, and
  uptime all live in `auth-store.db` with WAL + transactions — atomic, per-row writes,
  no whole-file rewrite. Still back up `/data` before risky operations, and copy the
  `.db` **with its `-wal`/`-shm` sidecars**. (Render disk snapshots must **not** be used
  to restore SQLite — export/copy the DB instead.)
- **No schema migrations.** Changes to the SQLite schema or the JSON store shapes are
  manual.

## Security notes

- **Never commit secrets.** `.env` and the `*.txt` key files are gitignored; real
  secrets belong in the Render dashboard.
- `data/auth-store.db` contains password hashes and session tokens — handle with care.
- Admin/log endpoints are protected by `endpoint_key`, compared in constant time.
- CSP is enforced via `helmet` (toggle with `DISABLE_CSP=1` only to debug a blocked
  resource); CORS is limited to `ALLOWED_ORIGINS`; auth/email/generation endpoints are
  rate-limited (`RL_AUTH` / `RL_EMAIL` / `RL_GEN`).
