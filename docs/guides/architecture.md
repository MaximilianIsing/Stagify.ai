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
  const router = express.Router();
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

Middleware runs in registration order in `server.js`:

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

## Backend modules (`lib/`)

| Module | Responsibility |
|---|---|
| `config.js` | Reads secrets/config from env vars, falling back to local `stripe_*.txt` / `*.txt` files. |
| `auth-store.js` | User accounts, salted+hashed passwords, 30-day sessions, email registration codes, free-tier usage. **SQLite-backed** (`better-sqlite3`, `data/auth-store.db`); imports a legacy `auth-store.json` once on first run. |
| `enterprise-store.js` | Enterprise domain activation + metered usage, kept in sync with Stripe. |
| `stripe-webhooks.js` | Applies Stripe subscription lifecycle events (checkout/updated/deleted) to accounts & domains. |
| `email.js` | Sends registration-verification email; serves the email-open tracking pixel. |
| `logging.js` | CSV/file logging helpers + the prompt/contact counters shown in the hero stats. |
| `memory.js` | Per-user AI-chat memory storage and LLM-driven memory-action evaluation. |
| `promptMatrix.js` | The room-type × furniture-style prompt templates used when staging. |
| `prompts.js` | Pure prompt/data constants for the AI Designer, staging, QA review, and image gatekeeping. Single source of truth for model-facing wording. |
| `cad-handling.js` | Converts CAD/PDF floor plans into photorealistic 3D renders (AI Designer), via Gemini. |
| `chat-upload-prep.js` | Pre-routing prep for `/api/chat-upload`: multipart upload → GPT-ready messages + routing completion. |
| `chat-pipeline.js` | Post-routing dispatch shared by `/api/chat` and `/api/chat-upload`: memory writes, image generation, staging, recall, etc. |
| `uptime-monitor.js` | Self-hosted uptime tracking (heartbeat → the `uptime_state` row in `auth-store.db`); powers `/api/status` and the status page. |

## Routers (`routes/`)

Each is a factory returning an `express.Router`, mounted in `server.js`.

| Router | Owns |
|---|---|
| `public.js` | SEO files (`robots.txt`, `sitemap.xml`), landing/status pages, `/health`, hero-stat counts, contact/bug logging, `/api/send-email`, hosted-image serving (`/i/:id`), email-open pixel. |
| `auth.js` | `register` / `verify` / `login` / `logout` / `me` / `forgot-password` / `reset-password` / `google`, plus the staging-banner controls. |
| `admin.js` | `endpoint_key`-gated log/data exports and hosted-image management (see [`endpoints.md`](../reference/endpoints.md)). |
| `staging.js` | Core AI: `process-image`, `mask-edit`, `segment`, `process-pdf`, `validate-image`, `stage-by-endpoint-key`. |
| `chat.js` | AI Designer chat: `/api/chat`, `/api/chat-upload`, `welcome-message`. |
| `billing.js` | Stripe checkout, customer portal, `stripe-webhook`, enterprise checkout. |

## Configuration & secrets

Loaded by [`load-env.js`](../../load-env.js) (imported first in `server.js`, before any
secret is read). Every secret resolves from its env var, falling back to a gitignored
`.txt` file. Full reference: [`environment-variables.md`](../reference/environment-variables.md).

## Data & persistence

State lives under `data/` (or the Render `/data` disk when present, detected via the
`RENDER` env var):

- **SQLite (`better-sqlite3`, one shared connection via `lib/db.js`):** `auth-store.db`
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

Plain HTML/CSS/vanilla JS in `public/`, served as-is (no bundler). Pages `fetch` the
JSON API on the same origin. UI text is translated client-side — see
[`i18n.md`](i18n.md). Note that `public/styles/styles.css` is partially minified; edit
it carefully.

## Conventions & gotchas

- **Factory + DI everywhere.** New shared logic should be a `createX(deps)` factory,
  wired at the `server.js` composition root — not a global.
- **ESM, no `__dirname`.** Derive paths from `import.meta.url`.
- **Extraction is ongoing.** `server.js` is being split into `routes/` + `lib/`;
  changes are meant to be behavior-preserving. The `route-inventory` test guards
  against accidentally dropping a route during a refactor.
- **Deploys are manual.** `render.yaml` sets `autoDeploy: false`, so a push does **not**
  ship — you deploy from the Render dashboard. The build still runs the test suite, so a
  red test blocks the deploy. See [`../operations/deployment.md`](../operations/deployment.md)
  and [`testing.md`](testing.md).
