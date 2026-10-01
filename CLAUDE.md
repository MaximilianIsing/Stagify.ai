# Stagify.ai — repo orientation for agents

AI virtual-staging web app. Node/Express (ESM) backend + static multi-page
frontend in `public/`. Entry point: `server.js`.

## Layout
- `server.js`: composition root, builds the shared stores/helpers and mounts middleware
  (`lib/http/app-middleware.js`, limiters in `lib/http/rate-limiters.js`) and routers. It is
  at its 650-line ESLint cap, so new logic goes in a `routes/` or `lib/` factory.
- `routes/` — Express routers (`chat`, `staging`, `auth`, `public`, `billing`, `i18n`, …).
  The admin console's routers live in `routes/admin/` (`index.js` is the main one; the
  rest are sibling routers split off because it is at its line cap).
  New route files create their router with `createAsyncRouter()` (`lib/http/async-router.js`),
  the shared factory. On Express 5 it is a plain `express.Router()`: async-handler
  rejections reach the catch-all error handler in `server.js` natively.
- `lib/` — extracted modules (auth store, prompts, chat pipeline, logging, i18n renderer, etc.).
- `public/` — everything served to browsers (HTML, styles, scripts, fonts, media).
- `test/` — `node --test` suite (unit/integration; gates the deploy). Specs live in
  **subfolders mirroring the source tree** (`test/data/`, `test/routes/`, `test/frontend/app/`,
  …); `test/helpers/` holds the shared harnesses. The glob is `test/**/*.test.js`, so a new
  folder needs no registration — see `docs/guides/testing.md` for which folder to use.
- `e2e/`: Playwright browser smokes of the studios, staging tool, home page, gallery and
  more (`npm run test:e2e`, all `/api/*` mocked). Separate from the deploy-gating
  `npm test`; runs in its own GitHub CI job.

## Logging — two separate things, don't conflate them
- `lib/logger.js` — the **diagnostic logger**: the single funnel for operator-facing
  stdout/stderr. Levels `debug < info < warn < error`; import it (`import { logger }
  from '.../logger.js'`) and call `logger.debug/info/warn/error(...)`. A raw
  `console.*` in `routes/`, `lib/`, or `server.js` is a lint **error** (`no-console`),
  so this is enforced, not merely a convention. The only files allowed to touch
  `console` directly are `lib/logger.js` itself, the bootstrap layer
  (`lib/config/runtime-flags.js`, `load-env.js`) that runs beneath it, `test/`, and
  `scripts/` (build/CI tools whose stdout is their interface).
  Verbosity: `LOG_LEVEL` (debug|info|warn|error|silent) wins; otherwise `DEBUG_MODE`
  (env `DEBUG`, from `.env` locally) raises the floor to `debug`; otherwise the floor is
  `info`. So production prints info/warn/error and drops debug. Guard expensive
  debug-only work with `if (DEBUG_MODE)` (or `logger.debugEnabled`) so it is skipped,
  not just suppressed.
- `lib/services/logging.js` — **not** a diagnostic logger despite the name. It is the
  **CSV business-event writer** (`logPromptToFile` / `logMaskEditToFile` /
  `logChatToFile` append rows to the `.csv` logs). A data sink, not a stdout stream.
  Reach for `logger` for diagnostics; reach for `logging` only to record analytics rows.

## Localized URLs (i18n SEO) — config-driven, with a build step
Each language is served at its own URL (`/es`, `/fr/guides.html`, …), **rendered
server-side** by `routes/i18n.js` + `lib/i18n/render-page.js` from the existing
`public/languages/*.json`. English stays at the root as plain static files.
`lib/i18n/locales.js` is the **single source of truth** for the language set and the
localized page set. After changing either (or a page's canonical), **rerun
`node scripts/build-i18n-seo.js`** — it bakes the `hreflang` cluster into the static
English pages, regenerates `public/sitemap.xml`, and regenerates
`public/scripts/i18n/locale-data.js`, the browser's copy of the language set (prefix maps,
BCP-47 codes, flags, browser-tag detection). The frontend must import its language
tables from `locale-data.js` — never re-list languages by hand; that is how five
copies accumulated. Drift tests in `test/i18n/i18n.test.js` and
`test/i18n/locale-data.test.js` fail (blocking the deploy) if you forget, and the
latter also checks the per-page switcher markup, which is the one part the build
cannot generate. Full guide: `docs/guides/i18n.md`.

The **blog is localized too, but through its own packs**: article prose would triple the
size of the shared `languages/*.json` that every page downloads, so each article and the hub
carry `public/blog/i18n/<slug>/<lang>.json`, merged under a `post.*` / `hub.*` namespace at
render time. The matrix is **sparse** — an article exists in the languages it has packs for
— and the generated `lib/i18n/blog-i18n-manifest.js` is the single record of which, read by
the baked hreflang clusters, the sitemap, the routes and the hub's card grid alike. Add or
remove a pack with `scripts/blog-pack.js`, then **rerun the build**. The build also bakes
each blog page's topbar `.blog-langs` picker (`lib/i18n/blog-langs.js`) — the blog's own
no-JS language switcher, since blog pages load none of the client i18n stack. Full guide:
`docs/guides/i18n.md`.

Most strings resolve from markup via `data-lang`, but a few are looked up in JS against a
server value. `errors.unstageable.*` is the one to remember: `/api/validate-image` rejects
an upload with a stable category **code** from `lib/staging/unstageable.js`, and the browser
localizes that code, falling back to the server's English. So **adding a rejection category
means adding the key to all 11 packs** — `test/i18n/unstageable-i18n.test.js` blocks the deploy
if you don't, because the English fallback would otherwise hide the omission.

## Intentionally-kept source assets — DO NOT delete as "unused"
These are **design/build source masters**, not runtime code. The server never
references them, so a grep for usages returns nothing **by design** — that alone
does NOT mean they are junk. `to-build/` collects them, and each subfolder has
its own README:
- `to-build/media-png/` — PNG masters for the WebP images served from `public/media-webp/`.
- `to-build/OG_Image/` — Photoshop master for `public/og-image.png`.
- `to-build/media-png/blog/covers/` — the recipe (geometry + per-language text) for the
  localized blog covers `public/media-webp/blog/cover-N.<lang>.*`, rendered by
  `scripts/build-blog-covers.js`. The English covers are never overwritten.
- `to-build/demos/` — authoring master + standalone preview for the guide
  walkthroughs; exports to `public/scripts/guides/demo-data.js`, the served
  `demo-player.{js,css}`, and `public/media-webp/demos/`.
- `to-build/fonts/`: recipe for the subset fonts in `public/fonts/`.
- `to-build/disclosure-badges/`: recipe for `lib/image/badges/`, rendered by
  `scripts/build-disclosure-badges.js`.
- `to-build/brand/`: brand masters copied into `public/brand/` by `scripts/build-brand-kit.js`.
- `to-build/Iridescent background/`: retired background prototype; nothing loads it.

Before proposing to remove any file because it "isn't referenced," check whether
it is a *build input* (a source master, config, or asset) rather than a runtime
dependency. If unsure, ask — don't assume unreferenced == deletable.

## Data & deploy
- **Where state lives on disk** is decided in exactly one place, `lib/data/data-dir.js`
  (`resolveDataDir`) — Render's mounted `/data` vs `<baseDir>/data`. Import it (directly
  or via the `db.js` re-export); do NOT re-derive `process.env.RENDER && fs.existsSync('/data')`,
  which used to be copy-pasted at ten sites. `test/data/data-dir.test.js` fails the build
  on a second copy.
- All structured state lives in **one SQLite database** (`auth-store.db` via
  `better-sqlite3`, under `/data` on Render or `./data` locally), opened through a
  single shared connection in `lib/data/db.js`: auth (`users`, `sessions`, …),
  `enterprise_domains`, `memories`, `uptime_state`, the gallery tables, API keys and
  credits, `stripe_events`, referral links, admin sessions and access log, `blog_views`,
  and `email_optouts` (full list: `docs/reference/data-stores.md`). Each older store
  imports its legacy JSON (`auth-store.json`, `enterprise-domains.json`, `memories.json`,
  `uptime.json`) once on first boot, then leaves it as a frozen fallback. Only the
  **CSV logs** and `hosted-images/` remain flat files; gallery render bytes live in
  Cloudflare R2 (`lib/data/object-store.js`).
- Deploys to Render; the build runs `npm test`, so **a failing test blocks the
  deploy** — keep the suite green. `npm run lint` must also pass (`--max-warnings=0`) — it
  runs ESLint over all JS (backend, `public/scripts/` ES modules auto-detected via
  `import`/`export`, the classic scripts listed by name, `instagram/`, `to-build/`) and
  stylelint over all CSS plus inline `<style>` in HTML. Only generated/vendor bundles
  (`demo-data.js`, `*.min.*`) stay unlinted. A new classic `<script>` file must be added to
  its list in `eslint.config.js`.
