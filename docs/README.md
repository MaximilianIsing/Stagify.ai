# Stagify.ai

AI-powered virtual staging and interior design for real estate. Upload a photo of
an empty or dated room and get a professionally staged result in about eight
seconds. Also includes an **AI Designer** (chat-to-stage, and CAD/PDF floor plans →
photorealistic 3D renders) and a **Masking Studio** for pixel-precise edits.

This README is the entry point for the `docs/` folder. See also:

- [`environment-variables.md`](environment-variables.md) — every env var, with a copy-paste `.env`.
- [`endpoints.md`](endpoints.md) — HTTP API reference.

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
- **Server:** Express 4 — a single monolithic `server.js` that serves both the static
  frontend and the JSON API.
- **Frontend:** Plain HTML/CSS/vanilla JS in `public/`. **No build step, no framework,
  no bundler** — files are served as-is.
- **Image processing:** `sharp`.
- **AI:** Google Generative AI (Gemini) for staging/renders, OpenAI for the chat assistant.
- **Email:** Resend. **Billing:** Stripe. **Auth:** local accounts + Google Sign-In.
- **Security middleware:** `helmet` (CSP), `cors`, `express-rate-limit`.

## Repository layout

```
.
├── server.js                # The whole backend: routes, AI calls, auth, billing, logging
├── load-env.js              # Zero-dependency .env loader (imported first, before any secret)
├── render.yaml              # Render deploy config (build runs `npm test`)
├── package.json             # Scripts, deps, Node engine
├── lib/                     # Backend modules imported by server.js
│   ├── auth-store.js        # User accounts, sessions, registration codes, daily limits
│   ├── cad-handling.js      # CAD/PDF floor plan → 3D render (AI Designer)
│   ├── enterprise-store.js  # Enterprise domains + metered usage tracking
│   ├── promptMatrix.js      # Room-type × style staging prompt templates
│   └── stripe-webhooks.js   # Stripe subscription lifecycle handling
├── public/                  # Static frontend (HTML pages, scripts, styles, assets, i18n)
├── data/                    # Runtime state: JSON stores + CSV logs (see Data & persistence)
├── test/                    # `node --test` suite (unit + smoke)
├── demos/, ds-bundle/,      # Guide/demo assets and design-system bundle
│   OG_Image/, to-build/
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
gitignored). Copy the template from [`environment-variables.md`](environment-variables.md)
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
npm start        # node server.js       → http://localhost:3000
npm run dev      # nodemon server.js    → auto-restart on change
npm test         # node --test          → run the test suite
```

`server.js` serves the static site (`/`, `/index.html`, etc.) and the JSON API from
the same port (default `3000`, override with `PORT`).

## Configuration & secrets

All runtime configuration is environment-variable driven, loaded by `load-env.js`
before any secret is read. The full, commented list lives in
[`environment-variables.md`](environment-variables.md). Highlights:

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
- **Persistence:** flat JSON/CSV files under `data/` (see below) — no database.
- **i18n:** UI strings live in `public/languages/*.json` (11 languages) and are applied
  client-side by `language-loader.js` / `language-switcher.js`; prices remain USD.

## Backend modules

`server.js` is the orchestrator; the reusable pieces are in `lib/`:

| Module | Responsibility |
|---|---|
| `auth-store.js` | User accounts, sessions (30-day), email registration codes, per-day generation limits. JSON-backed via `data/auth-store.json`. |
| `cad-handling.js` | Converts CAD/PDF floor plans into photorealistic 3D room renders (the AI Designer pipeline), using Gemini. |
| `enterprise-store.js` | Tracks enterprise domains and metered usage for enterprise billing. |
| `promptMatrix.js` | The prompt templates for each room-type × furniture-style combination used when staging. |
| `stripe-webhooks.js` | Handles Stripe subscription lifecycle events (checkout completed, subscription updated/canceled, etc.). |

## Frontend

Everything the browser loads is under `public/`:

- **Pages:** `index.html` (the staging tool + marketing home), `ai-designer.html`,
  `masking-studio.html`, `stagify-plus.html`, `enterprise.html`, `guides.html`,
  `faq.html`, `contact.html`, `admin.html`, legal pages, etc.
- **Scripts (`public/scripts/`):** e.g. `app.js` (main staging tool), `auth.js`,
  `mask-core.js` (shared masking canvas math), `count-up.js` (hero stats),
  `carousel.js`, `home-reveal.js`, and the `language-*.js` i18n helpers.
- **Styles (`public/styles/`):** `styles.css` (partially minified — edit with care),
  `home.css`, `carousel.css`, and per-feature CSS.
- **i18n (`public/languages/`):** one JSON file per language; `english.json` is the
  source of truth for keys.
- **Assets:** `media-webp/`, `fonts/`, `background.mp4`, `bimi-logo.svg`, icons,
  `sitemap.xml`, `robots.txt`, `manifest.json`.

## Data & persistence

State is stored as flat files in `data/` (no database):

| File | Contents |
|---|---|
| `auth-store.json` | User accounts, hashed passwords, session tokens. **Sensitive.** |
| `enterprise-domains.json` | Enterprise domain registrations + usage. |
| `memories.json` | Per-user chat assistant memory. |
| `hosted-images/` | User-hosted image uploads served via `/i/:id`. |
| `*_logs.csv` | Append-only logs: prompts, chats, contacts, masks, bug reports, email opens. |

On Render, when a persistent disk is mounted at `/data`, these are written there
instead of the repo `data/` folder (detected via the `RENDER` env var). The log/admin
endpoints that read these files are protected by `endpoint_key`.

## HTTP API

Served from `server.js` on the same origin. Full reference: [`endpoints.md`](endpoints.md).
Rough groups:

- **Core AI:** `POST /api/process-image` (stage), `/api/mask-edit`, `/api/segment`,
  `/api/process-pdf`, `/api/validate-image`, `/api/stage-by-endpoint-key`.
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
npm test
```

Uses the built-in Node test runner (`node --test`) over `test/**/*.test.js`. Current
suites: `auth-store`, `guards`, `smoke`, `static`, and `stripe-webhooks`, with shared
setup under `test/helpers/`.

> **The test suite gates deployment** — `render.yaml`'s build command runs
> `npm install && npm test`, so a failing test blocks the Render deploy. Keep tests green.

## Deployment

Deployed on **Render** as a single web service, configured by [`render.yaml`](../render.yaml):

- **Build:** `npm install && npm test` (tests must pass to deploy).
- **Start:** `npm start`.
- **Auto-deploy:** on push to the default branch (`autoDeploy: true`).
- **Env:** `NODE_ENV=production` is set in `render.yaml`; secrets like
  `GOOGLE_AI_API_KEY` are `sync: false` (entered in the Render dashboard, never committed).
- **Persistence:** a disk mounted at `/data` holds the JSON/CSV state across deploys.

Because pushing to the default branch triggers a production deploy, treat pushes as
releases.

## Known limitations

The persistence layer is deliberately simple (flat JSON/CSV files, no database), which
has real consequences you must design around:

- **Single instance only.** All state lives in `data/` (or the Render `/data` disk).
  Running more than one server instance concurrently will corrupt that shared state —
  **do not scale horizontally** without first moving to a real shared datastore.
- **No atomic writes, no backups.** Stores like `auth-store.json` are rewritten in
  place; an interrupted or overlapping write can lose data, up to the **entire user
  table**. Back up `/data` before risky operations, and prefer low-traffic windows for
  anything that mutates it.
- **No schema migrations.** Changes to the shape of the JSON stores are manual.

## Security notes

- **Never commit secrets.** `.env` and the `*.txt` key files are gitignored; real
  secrets belong in the Render dashboard.
- `data/auth-store.json` contains password hashes and session tokens — handle with care.
- Admin/log endpoints are protected by `endpoint_key`, compared in constant time.
- CSP is enforced via `helmet` (toggle with `DISABLE_CSP=1` only to debug a blocked
  resource); CORS is limited to `ALLOWED_ORIGINS`; auth/email/generation endpoints are
  rate-limited (`RL_AUTH` / `RL_EMAIL` / `RL_GEN`).
