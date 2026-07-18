# Testing

Two suites, deliberately kept separate:

- **Unit / integration** — the **built-in Node test runner** (no Jest, no Mocha, no extra
  dependencies) over `test/**/*.test.js`. This is the suite that **gates the Render deploy**.
- **End-to-end** — [Playwright](https://playwright.dev) browser smokes under `e2e/`, run on
  their own. Held *out* of the deploy gate so occasional browser flake can't block a release
  (see [End-to-end (browser) tests](#end-to-end-browser-tests) below).

```bash
npm test         # npm run typecheck, then node --test "test/**/*.test.js"  (both gate deploy)
npm run typecheck # tsc --noEmit (backend) + scripts/typecheck-frontend.js (frontend) — see Type-checking below
npm run test:e2e # playwright test                   — browser smokes of the two studios
npm run lint     # eslint . --max-warnings=0  (backend + frontend ES modules — see Linting below)
```

> **Tests gate deployment.** `render.yaml`'s build command is `sh scripts/build.sh`,
> which runs `npm install` then `npm test`, so a failing test **blocks the Render
> deploy**. Keep the suite green — a red test is a stuck release, not just a warning.
> Note `npm test` runs **`npm run typecheck` first** (`tsc --noEmit` + the frontend
> checkJs pass), so a *type* error blocks the deploy exactly like a failing test does —
> see [Type-checking](#type-checking). (Lint isn't part of the Render build, but it **is**
> an enforced, blocking CI check — see below.)

## Philosophy

Tests are cheap, hermetic, and aimed at the regressions that actually hurt: silent auth
bypasses, revenue bugs, a server that won't boot, and broken static/asset references.
**Nothing contacts a paid API, spends money, or needs real secrets** — the server
degrades gracefully when unconfigured, and billing/auth logic is exercised over throwaway
temp-dir stores with hand-built event objects.

## The test harnesses

`test/helpers/` holds the shared harnesses (none are `*.test.js`, so they're never run as
specs). Three styles, cheapest first:

**Router-mount** — `staging-app.js`, `chat-app.js`, `auth-app.js`, `billing-app.js`,
`admin-app.js`. Each mounts **one real router factory** (`routes/*.js`) on a bare
`express()` app with its dependency bag faked, listens on an ephemeral port, and returns
`{ baseUrl, …, close }` so the test drives it with `fetch`. This exercises the actual
handlers — auth gate, body parsing, validation, response shaping, error mapping — with the
slow/external clients (Gemini/OpenAI, Stripe, Resend email, Google OAuth) swapped for
deterministic in-process fakes: no full boot, no network, no secrets. How much is faked
varies with what's under test:

- `auth-app.js` keeps a **real temp-dir SQLite store** + the real auth-helpers, so a
  register→verify→login round-trip is genuine — only the email sender and Google OAuth are
  faked.
- `billing-app.js` fakes the Stripe SDK and event handler outright, to isolate the
  webhook signature check + route control flow.
- `admin-app.js` keeps the **real** `protectLogs` access-key guard (that gate is the
  router's whole security story) and fakes the stores behind an in-memory manifest + temp dir.

`fake-ai.js` provides the scripted AI stub the staging/chat harnesses use.

**Full-boot** — `server.js` (not a `*.test.js`) exports `startServer(extraEnv)`, which:

- picks a free port from the OS (so tests never collide with a dev server),
- spawns the **real** `server.js` as a child process with `NODE_ENV=test` and any
  `extraEnv` overrides,
- resolves once the child logs `Server running on port …` (20s boot timeout),
- returns `{ baseUrl, output(), close() }`.

Boot/HTTP smokes use this to hit the whole app end-to-end.

**Direct import** — pure-logic tests import a `lib/` module (or an extracted frontend
helper) directly and point it at a temp directory; no server at all.

## What's covered

The files are informally tiered from cheapest/most-fundamental to broader:

| Tier | File | Covers |
|---|---|---|
| 0 | `smoke.test.js` | The server boots and `GET /health` returns `200 {status:'healthy'}`. The most common outage ("it doesn't start") caught first. |
| 1 | `static.test.js` | No server, no network: `server.js` + every `lib/*.js` parses; client scripts parse; **local asset references in `public/*.html` exist on disk**; every language file is valid JSON and **covers `english.json`'s keys**; `sitemap.xml`/`manifest.json` are well-formed. |
| 2 | `guards.test.js` | Access-guard status codes — log/admin routes 403 without a key, endpoint-key routes 403, Pro-only routes 401 without a session. Guards against silent auth bypass. |
| 2 | `auth-store.test.js` | Auth correctness: register→login round-trip, email-code gating, salted/hashed passwords, session validate/logout, single-use password reset, non-enumerating reset, free-tier + mobile-IP usage recording. |
| 2 | `auth-store-sqlite.test.js` | SQLite specifics: on-disk persistence, the one-time `auth-store.json` → SQLite migration (user-data safety), and the `exportStore`/`importStore` round-trip behind the admin backup. |
| 2 | `db.test.js` | The `lib/data/db.js` layer: the WAL/pragmas it sets and that data actually persists to disk. |
| 2 | `stripe-webhooks.test.js` | Billing lifecycle over hand-built events: checkout upgrades to Pro (by ref or email), `subscription.deleted` downgrades, `updated`→active restores Pro, enterprise routes to the enterprise store. Catches "paid but no Pro" / "churned but still Pro". |
| 2 | `enterprise-store.test.js` | Domain activation (idempotent, case-insensitive), subscription-state sync, usage counting. |
| 2 | `staging-endpoints.test.js` | Staging contracts without any AI call: `validate-image` rejects bad input (400) and fails open (200) when the reviewer is disabled; `process-image` requires a session for desktop. |
| 2 | `public-endpoints.test.js` | Public surface smoke: JSON endpoint shapes, SEO/landing files serve, static content types, unknown routes 404, a helmet header is present. |
| 2 | `i18n.test.js` | The localized-URL layer (`lib/i18n/` + `routes/i18n.js`): the config is consistent, the page renderer applies translations + `<base>` + canonical/hreflang + link rewriting, the client routing helpers resolve prefixes correctly, live `/es` & `/fr/…` routes render in-language (301/404 edges), and **drift guards** fail if the committed `sitemap.xml` or the English pages' baked-in hreflang is stale (rebuild with `scripts/build-i18n-seo.js`). |
| 2 | `auth-route.test.js` | The auth **routes** over a real temp-dir store (email/Google faked): register→verify→login→`/me`→logout round-trip, `{ok:false}`→status mapping (400/401), the `/api/auth/me` gate (401 `AUTH_REQUIRED`), and the staging Google-disable (403 `STAGING_DISABLED`). |
| 2 | `billing-route.test.js` | The Stripe **route** layer (faked SDK): the webhook rejects unconfigured / missing-signature / bad-signature **before** dispatch, a verified event dispatches and acks `{received:true}`, and the customer-portal + enterprise-checkout auth/validation gates (incl. 409 on a duplicate domain). |
| 2 | `admin-route.test.js` | The admin **routes** with the real access-key guard: no/wrong key → 403 (unconfigured → 500, fail-closed), the hosted-image host/list/unhost lifecycle (writes + deletes real files), snapshot downloads, and the memory/uptime reset actions. |
| 2 | `chat-route.test.js` | The `/api/chat` handler (faked OpenAI + image steps): the auth gate, the routing-completion parse, and the SSE-vs-`res.json` streamMode decision. |
| — | `route-inventory.test.js` | Refactor safety net: asserts every **critical route is still registered** (responds with anything but 404 for its method). Guards the `server.js` → `routes/*` extraction. |
| — | `async-router.test.js` | The `createAsyncRouter()` error-handling safety net: a rejecting async handler reaches the catch-all as a clean `500` instead of hanging the request. |
| — | `uptime.test.js` | Pure math of the uptime monitor: window percentages, coverage, bucket classification, incident coalescing/pruning. |

The table is a **representative selection**, not the full list — the suite has grown to
~65 files as `server.js` is extracted into `lib/` and pure frontend logic is pulled into
testable helpers. Most `lib/` modules now have a matching `*.test.js` (e.g. `logger`,
`logging`, `http-helpers`, `erase`, `image-review`, `image-annotation`, `hosted-images`),
as do the extracted frontend helpers — the `masking-studio-*` islands plus pure slices like
`heic-convert` (content-type sniffing), `count-up` (counter width/easing math), and
`version-carousel` (version-history cap). Run `npm test` for the authoritative set.

## Writing a new test

- Name it `test/<thing>.test.js` so the glob picks it up.
- Use Node's runner API:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';

  test('does the thing', () => {
    assert.equal(2 + 2, 4);
  });
  ```

- **Prefer pure-logic tests** against a `lib/` module (or an extracted frontend helper)
  with a temp dir — they're fast and need no server.
- **To exercise one router's handlers** without a full boot, mount it with the matching
  `test/helpers/<router>-app.js` harness: fake its dependency bag, then `fetch` the
  ephemeral port. This is the pattern used for `staging`, `chat`, `auth`, `billing`, and
  `admin`. Reach for `startServer()` from `test/helpers/server.js` only when you must boot
  the **whole** app (cross-router wiring, real middleware order).
- **Never require real keys or make paid API calls.** Configure the child via `extraEnv`
  to force deterministic paths (e.g. `GPT_KEY=''` disables the OpenAI reviewer so
  `validate-image` takes its documented fail-open branch).
- If you add a route the frontend or an integration depends on, add it to
  `route-inventory.test.js` so a future refactor can't silently drop it.

## Debugging a failing run

- Run one file: `node --test test/auth-store.test.js`.
- A boot test that times out prints the child server's captured stdout/stderr in the
  failure message (via the harness `output()`), which usually shows the real cause
  (bad import, thrown error on startup).

## End-to-end (browser) tests

Playwright specs under [`e2e/`](../../e2e/) drive the **real** frontend in a real Chromium
against a **real** `node server.js` — but every `/api/*` call the studios make is intercepted
and fulfilled with a canned response, so **no AI is invoked, nothing costs money, and no
secrets are needed**. Config: [`playwright.config.js`](../../playwright.config.js) (`testDir:
./e2e`, so any `e2e/*.spec.js` is picked up automatically — no registration needed).

```bash
npm run test:e2e                                  # all specs (boots the server for you)
npx playwright test e2e/masking-studio.spec.js    # one file
```

**Getting past the pro gate.** Both studios redirect anonymous users to the upsell page, so
they can't be driven on a plain static server. [`e2e/fixtures.js`](../../e2e/fixtures.js)'s
`seedProSession(page)` seeds an auth token into `localStorage` at first paint and mocks `GET
/api/auth/me` → a Pro user, so the page reveals instead of redirecting. This is how gated
flows (the mask editor, session resume) are exercised without a real account or backend auth.

What's covered today (all green — 8 tests across 5 specs):

| Spec | Covers |
|---|---|
| `ai-designer.spec.js` | Happy path — a chat turn renders the assistant text reply / a staged image. |
| `ai-designer-errors.spec.js` | A failed `/api/chat` shows a **retryable** error bubble, Retry re-sends and recovers, and a 403 (not Stagify+) shows a **non-retryable** error. |
| `masking-studio.spec.js` | Happy path — upload → paint a mask → prompt → Apply Edit renders a result. |
| `masking-studio-errors.spec.js` | A 500 from `/api/mask-edit` flips the area to a visible **Failed** state with a retry. |
| `masking-studio-resume.spec.js` | Session persistence — paint + prompt is saved to IndexedDB, survives a reload, and the Resume dialog restores the photo, layer, prompt, and painted mask. |

**Writing an e2e spec.** Name it `e2e/<thing>.spec.js`, call `seedProSession(page)` in a
`beforeEach` if the page is gated, `page.route('**/api/…')` **every** backend call it makes
(never hit a real provider), and assert on user-visible DOM. Reuse the room-photo and
tiny-PNG fixtures from `e2e/fixtures.js`.

## Type-checking

```bash
npm run typecheck   # tsc --noEmit (backend) && node scripts/typecheck-frontend.js (frontend)
```

The whole codebase is **type-checked as plain JS + JSDoc** (`checkJs`), with **no build
step** — `tsc` runs purely as a linter (`noEmit`, compiles nothing; `node server.js`
still runs the untouched `.js`). `npm test` runs this **before** the Node test runner, so
a type error **blocks the Render deploy** just like a red test. There are **zero
`@ts-nocheck` opt-outs** — every in-scope file is genuinely checked, and a new file is
checked from day one.

Two scopes, one per environment (both deliberately loose for now — `strict: false`,
`noImplicitAny: false` — to be tightened once stable):

- **Backend** — [`tsconfig.json`](../../tsconfig.json), Node types. Covers `server.js`,
  `instrument.js`, `load-env.js`, `lib/**`, `routes/**`, plus the shared ambient typedefs
  in [`lib/types/*.d.ts`](../../lib/types/). Run directly as `tsc --noEmit`.
- **Frontend** — [`tsconfig.frontend.json`](../../tsconfig.frontend.json), DOM libs +
  [`public/scripts/globals.d.ts`](../../public/scripts/globals.d.ts) (ambient `Window`
  augmentation). Its file list can't be a static glob (ESM-ness is content-based, not
  path-based), so [`scripts/typecheck-frontend.js`](../../scripts/typecheck-frontend.js)
  discovers the ES modules with the **same** collector ESLint uses
  ([`scripts/collect-esm-frontend.js`](../../scripts/collect-esm-frontend.js)) and hands
  them to `tsc` via a throwaway temp config. **Lint scope and type-check scope are
  therefore identical** — every file we lint we also type-check, and vice-versa. Classic
  shared-global scripts and `vendor/*.min.js` bundles have no `import`/`export`, so they
  fall out of both.

## Linting

```bash
npm run lint     # eslint . --max-warnings=0
```

ESLint uses a flat config ([`eslint.config.js`](../../eslint.config.js)):

- **Two scopes, both linted.**
  - *Backend* — `eslint.config.js`, `server.js`, `load-env.js`, `instrument.js`, `routes/**`,
    `lib/**`, `test/**` (Node globals).
  - *Frontend* — the ES modules under `public/scripts/`, **auto-discovered**: the config scans
    that tree at load and lints any file with a top-level `export` or static `import … from`
    (browser globals). As classic `<script>` files migrate to ES modules they start being linted
    automatically — no config edit needed. Files with neither marker (the render-blocking gate
    scripts like `masking-studio-gate.js`, and generated/vendor bundles like `demo-data.js`,
    `vendor/*.min.js`) match no block and stay unlinted — currently 7 of the 75 files under
    `public/scripts/`; the other 68 are linted **and** type-checked.
- **No blanket `public/**` ignore.** Only `node_modules`, `ds-bundle`, `supademo-local`,
  `to-build`, and `*.min.js` are ignored outright. `public/**` is deliberately *not* ignored:
  ESLint can't un-ignore files beneath a `/**`-ignored ancestor, so a broad ignore would make the
  frontend allowlist unreachable. Classic scripts stay out by matching no `files` block, not by
  being ignored.
- **Deliberately lenient.** Both scopes use `@eslint/js`'s recommended set plus `no-unused-vars`
  as a **warning** (an `_`-prefixed name is intentionally unused). The frontend scope also allows
  empty `catch {}` and unused caught-error bindings (`no-empty {allowEmptyCatch}`,
  `no-unused-vars {caughtErrors:'none'}`) — deliberate best-effort swallows in the UI code.

## Continuous integration

Two independent pipelines run on the default branch:

- **GitHub Actions** ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) — on
  every push and PR to `main`, in **two parallel jobs**:
  - `test` — `npm ci`, then `npm test` (which type-checks **then** runs the unit suite),
    then `npm run lint`. All blocking: a type error, a failing unit test, or any lint
    warning/error (`--max-warnings=0`) fails the build.
  - `e2e` — `npm ci`, installs Chromium (`npx playwright install --with-deps chromium`),
    then `npm run test:e2e`. Isolated in its own job so the heavier, occasionally-flaky
    browser run doesn't slow the fast unit gate. Blocking in CI, but see the deploy note.
- **Render** — the deploy build runs `sh scripts/build.sh` (which runs `npm test`), so a
  failing **unit** test **blocks the production deploy**. Neither the Playwright e2e job nor
  lint is part of the Render build.

Net: a **type error or a red unit test** blocks both CI and the deploy (both run inside
`npm test`). A lint finding or a failing **e2e** test blocks CI (so it can't reach a clean
`main`) but does **not** block the Render deploy — by design, so browser flake can never
wedge a release.
