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

## Layout

Specs are grouped into **subfolders that mirror the source tree**, so a change to a `lib/`
module has an obvious place to look (and to add to). The runner glob is `test/**/*.test.js`,
so a new folder needs no registration — just drop the file in.

| Folder | Holds | Mirrors |
|---|---|---|
| `test/server/` | Whole-app boot smokes and cross-cutting HTTP infra: `smoke`, `guards`, `static`, `json-body-limit`, `upload-limits`, `route-inventory`, `public-endpoints`. These use the full-boot `startServer()` harness (or no server at all). | `server.js` |
| `test/routes/` | **Contract** tests for one router's endpoints — mostly mounted with the matching `test/helpers/<router>-app.js` harness, though `staging-endpoints` deliberately full-boots to get the real blank-key fail-open config. | `routes/` |
| `test/chat/` | The AI Designer chat pipeline modules. | `lib/chat/` |
| `test/staging/` | Prompt building, the staging pipeline/generation, CAD handling. | `lib/staging/` |
| `test/image/` | Erase, annotation, review, primitives, hosted images. | `lib/image/` |
| `test/data/` | Auth store, SQLite layer, enterprise store, Stripe linking, memory, counters, uptime, pro grants, public-email-domain gate. | `lib/data/` |
| `test/services/` | AI clients, auth helpers, email + lifecycle emails, CSV logging, Stripe webhooks, trial lifecycle. | `lib/services/` |
| `test/http/` | Async router, guards, helpers, error references + the error-leak scan, rate limiters, uploads, CSV escaping. | `lib/http/` |
| `test/config/` | Runtime flags, model config, the diagnostic logger. | `lib/config/`, `lib/logger.js` |
| `test/i18n/` | The localized-URL layer **and** the translation **drift guards** (`room-types-i18n`, `unstageable-i18n`, `locale-data`). | `lib/i18n/` |
| `test/frontend/` | Browser logic, split **by area** rather than by exact path: `admin/`, `ai-designer/`, `app/`, `masking-studio/` (which also holds `mask-core`, the shared engine that lives a level up in the source), `mask/` for the cross-page mask-editor subsystem (`public/scripts/mask/`), and `profile-menu/` for the account dropdown + auth modal. Standalone modules and page-level guards stay at the top: `count-up`, `heic-convert`, `language-loader`, `unstageable-message`, `escape-html`, `css-tokens`, `plus-welcome`, `classic-scripts-parse`. | `public/scripts/` |
| `test/helpers/` | Shared harnesses — **not** specs. | — |

Two rules of thumb when a spec could sit in two places — both are about **what is under
test**, never which harness it happens to use:

- It belongs with the **module under test**, not the feature it serves. `public-email-domains`
  is under `data/`, not `i18n/`, even though it also asserts a translation key.
- A spec targeting **one router's endpoints** goes in `routes/`; one targeting **whole-app or
  cross-router** behavior (boot, middleware order, guards across every route, body/upload
  limits) goes in `server/`. The harness is not the tiebreaker: `routes/staging-endpoints`
  full-boots and still belongs in `routes/`, while `server/static` starts no server at all.

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
- `chat-app.js` keeps **real multer** (memory storage) as the `chatUpload` dep, because
  `/api/chat-upload` is multipart: a pass-through would leave `req.files` undefined and the
  handler would 400 before reaching anything worth testing. Tests post a genuine `FormData`
  body, so `req.files` carries real Buffers and the text fields (`conversationHistory` as a
  JSON *string*, `streamResponse` as the *string* `'true'`) arrive exactly as from a browser.

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
| 0 | `server/smoke.test.js` | The server boots and `GET /health` returns `200 {status:'healthy'}`. The most common outage ("it doesn't start") caught first. |
| 1 | `server/heading-structure.test.js` | Every page in `public/` has **exactly one non-empty `<h1>`** — the check no other gate performs, since a missing heading breaks no render, type, or lint (`ai-designer.html` shipped with none, and `guides.html` with it). Also pins that the AI Designer's `h1` is the `sr-only` one and **not** the chat's empty-state heading, which JS removes on the first message; that any `h1` carrying `data-lang` uses a key that exists in `english.json`; and that the three-page exemption list (two redirect stubs, `admin.html`'s two view shells) stays exact, so a fixed page can't quietly sit on it. |
| 1 | `server/static.test.js` | No server, no network: `server.js` + every `lib/*.js` parses; client scripts parse; **local asset references in `public/*.html` exist on disk**; every language file is valid JSON and **covers `english.json`'s keys**; `sitemap.xml`/`manifest.json` are well-formed. |
| 2 | `server/guards.test.js` | Access-guard status codes — log/admin routes 403 without a key, endpoint-key routes 403, Pro-only routes 401 without a session. Guards against silent auth bypass. |
| 1 | `data/password-hash.test.js` | The password hash **format** and its upgrade path (`lib/data/password-hash.js`): the `scrypt$N=…$<hex>` envelope round-trips, a legacy bare-hex row still verifies (nobody is signed out by the format change), a row written at a *different* cost verifies under **its** parameters rather than the current ones, and `needsRehash` is true for exactly those rows — never for an already-current row and never on a failed attempt, which would have the caller writing an unverified password. Malformed/unknown-algorithm values never verify. |
| 2 | `data/auth-store.test.js` | Auth correctness: register→login round-trip, email-code gating, salted/hashed passwords (parameter-tagged, with a legacy bare-hex row signing in and being **rehashed in place** while a failed sign-in leaves it untouched), session validate/logout, single-use password reset, non-enumerating reset, free-tier + mobile-IP usage recording. |
| 2 | `data/auth-store-sqlite.test.js` | SQLite specifics: on-disk persistence, the one-time `auth-store.json` → SQLite migration (user-data safety), the `exportStore`/`importStore` round-trip behind the admin backup, the `exportRedacted` line (no credential survives redaction, and it's an allowlist), and **tokens at rest** — session/reset tokens are stored hashed, a stored digest is not replayable as a token, and the in-place hashing migration keeps existing sessions valid while staying idempotent across reopens. Also the **index** guards: `EXPLAIN QUERY PLAN` proves the four non-token session/reset lookups SEARCH rather than SCAN (asserting the plan, not the schema — an index the planner ignores is no index), and a database whose indexes are dropped rebuilds them on the next open without signing anyone out. |
| 2 | `data/db.test.js` | The `lib/data/db.js` layer: the WAL/pragmas it sets and that data actually persists to disk. |
| 2 | `data/stripe-events.test.js` | The webhook idempotency ledger: a redelivered event id is refused once handled (and while in flight), a **released** claim is claimable again so a failed event still gets Stripe's retry, an abandoned claim reclaims after the staleness window, an id-less event is never blocked, and dedup survives a restart. The two directions matter equally — catches both "double-applied event" and "event silently swallowed". |
| 2 | `services/stripe-webhooks.test.js` | Billing lifecycle over hand-built events: checkout upgrades to Pro (by ref or email), `subscription.deleted` downgrades, `updated`→active restores Pro, enterprise routes to the enterprise store, and an enterprise checkout whose metadata names a **public email provider** activates nothing (acked, not applied — the case a replayed or dashboard-made subscription would hit). Catches "paid but no Pro" / "churned but still Pro". Also carries the **account-takeover scenarios** end to end: a checkout in a paying customer’s name is refused, so the follow-up `subscription.deleted` for the attacker’s own cancelled trial can no longer downgrade them — plus the refusal’s error-level log (ids, not the typed address), and the ordinary signed-out purchase that must keep working. |
| 2 | `data/stripe-linking.test.js` | The checkout → account mapping (`lib/data/stripe-linking.js`): reference beats email, matching is case/whitespace-insensitive, and the **email path may start a billing relationship but never replace one** — refused when the account holds a different live subscription or a comp grant, allowed for a fresh buyer, a genuine re-purchase after cancellation, and a Stripe redelivery of the same checkout. Every refusal case is paired with the allow case it must not break: too strict is the quieter failure (a real buyer pays and gets nothing). |
| 2 | `data/enterprise-store.test.js` | Domain activation (idempotent, case-insensitive), subscription-state sync, usage counting, and the **public-provider gate**: `activateDomain` refuses to write a `gmail.com` row, `isActiveDomain` grants nothing even when such a row is already stored, and — wired to the real `auth-helpers` — a user on a public domain is never upgraded to `pro`. |
| 2 | `routes/staging-endpoints.test.js` | Staging contracts without any AI call, against the real booted server: **both** paid entry points refuse an anonymous caller — `validate-image` answers `401` `AUTH_REQUIRED` (and does so *before* looking at the body, so a malformed anonymous request is a 401 and not a 400), and `process-image` requires a session for desktop. This tier can't hold a session (registration needs a mailed code), so the validator's own behaviour — 400 shapes, the `code`/`reason` relay, fail-open — is asserted in `routes/staging-routes.test.js` with the auth helper faked. Both AI keys stay blank as a belt-and-braces guard: a regressed gate would reach a disabled reviewer, not a live API (the grader is Gemini, so `GPT_KEY` alone is not enough). |
| 2 | `server/public-endpoints.test.js` | Public surface smoke: JSON endpoint shapes, SEO/landing files serve, static content types, unknown routes 404, a helmet header is present. |
| 1 | `i18n/locale-data.test.js` | The **language-set drift guards**: the committed `public/scripts/locale-data.js` matches its generator, every generated table is keyed by exactly the server locale set, each page's switcher markup lists it exactly (the one part the build cannot generate), and no frontend script goes back to hand-listing languages. Also covers the two **render-blocking studio gates**, which inline the locale-prefix regex because a deferred ES import would run after the paint they exist to beat: their `localeTarget()` is pulled out of the source and run against every prefix `locales.js` serves, only those two files may carry such a list, and their two copies must stay identical. Adding an 11th locale without updating both gates would otherwise ship green and silently redirect that language's visitors to the English root. |
| 2 | `i18n/i18n.test.js` | The localized-URL layer (`lib/i18n/` + `routes/i18n.js`): the config is consistent, the page renderer applies translations + `<base>` + canonical/hreflang + link rewriting, the client routing helpers resolve prefixes correctly, live `/es` & `/fr/…` routes render in-language (301/404 edges), and **drift guards** fail if the committed `sitemap.xml` or the English pages' baked-in hreflang is stale (rebuild with `scripts/build-i18n-seo.js`). |
| 2 | `routes/auth-route.test.js` | The auth **routes** over a real temp-dir store (email/Google faked): register→verify→login→`/me`→logout round-trip, `{ok:false}`→status mapping (400/401), the `/api/auth/me` gate (401 `AUTH_REQUIRED`), and the staging Google-disable (403 `STAGING_DISABLED`). |
| 2 | `routes/billing-route.test.js` | The Stripe **route** layer (faked SDK): the webhook rejects unconfigured / missing-signature / bad-signature **before** dispatch, a verified event dispatches and acks `{received:true}`, a **redelivered** event id is acked but handled only once (while a failed one releases its claim so the retry runs), and the customer-portal + enterprise-checkout auth/validation gates (409 on a duplicate domain; `400 PUBLIC_EMAIL_DOMAIN` for a public mailbox provider, asserted to reach Stripe **zero** times). |
| 2 | `routes/admin-route.test.js` | The admin **routes** with the real access-key guard: no/wrong key → 403 (unconfigured → 500, fail-closed), the hosted-image host/list/unhost lifecycle (writes + deletes real files), snapshot downloads, and the memory/uptime reset actions. |
| 2 | `data/pro-grant.test.js` | Admin **comp grants** (`lib/data/pro-grants.js` + the grant/revoke routes): the month arithmetic incl. the Jan-31 clamp, granting over a real temp-dir store, the grant surviving a close/reopen (it rides in `extra_json`), **expiry enforced on read** so a lapsed grant reads as `free` with no sweep job, the refusals (already-pro, Stripe subscriber), revoking early, and a Stripe checkout clearing the grant so a paying subscriber is never downgraded. |
| 2 | `data/trial-tracking.test.js` | The store side of the trial sweep (`lib/data/trial-tracking.js`), driven through the store's public API only: `listTrialCandidates` returns pro-and-mid-trial accounts only, a cancelled subscriber keeps its history but stops being swept, and an **expired comp grant is excluded even though its stored `plan` column still says `pro`** — the case that keeps the JS plan check load-bearing now the SQL pre-filters on `plan = 'pro'`. Plus an interface guard that the store hands it a **pro-only** row accessor, since the cost that narrowing avoids is invisible in behaviour. |
| 1 | `frontend/admin/admin-analytics.test.js` | The dashboard's chart aggregators (`public/scripts/admin/analytics.js`), pure and DOM-free: **local** (not UTC) day keys, zero-filled windows, the day→week→month granularity thresholds, trailing-vs-previous window deltas, and the top-N/"Other" distributions. These bugs never throw — they just draw a wrong picture — so the assertions target the quiet failures. |
| 1 | `frontend/admin/admin-analytics-users.test.js` | The dashboard's per-account joins (`public/scripts/admin/analytics-users.js`): last-active resolved across BOTH identifiers (renders key on email, chat/mask on userId), the activation funnel's nesting invariant — with the live-data regression where paid accounts outnumbered activated ones and drew a funnel step wider than its parent — and cohort cells that keep "this month hasn't elapsed" distinct from a measured 0%. |
| 1 | `frontend/admin/admin-charts.test.js` | The dashboard's SVG chart builders (`public/scripts/admin/charts.js`) against a stub `document`: one hover target per data point, geometry proportional to the values, a zero drawing nothing, axis labels thinned so they can't collide, and every chart degrading to a placeholder instead of an empty SVG. |
| 1 | `frontend/admin/admin-grant-ui.test.js` | The dashboard's grant control (`public/scripts/admin/grant.js`) against a minimal fake DOM: which of the four states renders (free → grant button, active grant → expiry + revoke, Stripe subscriber and enterprise → read-only notes), the confirm gate, the request each button sends, and the failed-request path re-enabling the button. |
| 2 | `routes/chat-route.test.js` | The `/api/chat` handler (faked OpenAI + image steps): the auth gate, the routing-completion parse, and the SSE-vs-`res.json` streamMode decision. Also pins **CAD base-image precedence** — an image in the current message beats an earlier `baseImageIndex` thumbnail pick — which is the flag the handler now resolves once instead of re-scanning `lastUserMessage.content` a second time for the CAD step. |
| 2 | `routes/chat-upload-route.test.js` | The `/api/chat-upload` handler, whose 280-line body had **no route-level coverage** — only its extracted units. Driven through real multer with a genuine `FormData` body, so it covers what only this endpoint owns: the no-files/auth/no-client guards, `conversationHistory` arriving as a JSON *string* (including the unparseable case falling back to empty rather than 500ing), `streamResponse:'true'` as a *string* form field opening SSE, the upload-only **staging synthesis** ("add this chair" + a staged image in history → stage anyway, and the mirror case that must not), the model allow-list, `imageAnnotations` keyed by filename, and an unsupported upload reaching the model as text with zero image items. |
| — | `server/route-inventory.test.js` | Refactor safety net: asserts every **critical route is still registered** (responds with anything but 404 for its method). Guards the `server.js` → `routes/*` extraction. |
| — | `http/async-router.test.js` | The `createAsyncRouter()` error-handling safety net: a rejecting async handler reaches the catch-all as a clean `500` instead of hanging the request. |
| — | `http/error-leak.test.js` | **Drift guard** against exception text in a response body. Reads the source of every response-building call in `routes/` and `lib/` — `sendError`, `writeChatSseEvent`, and any `res`-rooted `.json(`/`.send(` chain — and fails on `.message`/`.stack` inside one. `sendError(…, { details: error.message })` was the house style at ~19 sites, so the one-time cleanup is worthless without this. Multer's `400`s are allowlisted by exact snippet. The detector is itself pinned by cases for each shape the codebase actually had (including `res.status(400).send(\`…${err.message}\`)`, which an earlier version missed) and for the safe replacements. |
| — | `http/error-ref.test.js` | `reportError()`: the reference is random rather than derived (two identical errors differ, and it reveals nothing about the failure), while the log line carries the context, that same reference, and the error object whole so the stack survives. Both halves matter — a reference nobody can find in the logs would be worse than the `details` it replaced. |
| — | `data/uptime.test.js` | Pure math of the uptime monitor: window percentages, coverage, bucket classification, incident coalescing/pruning. |
| 1 | `frontend/language-loader.test.js` | `LanguageSystem.getText`'s **miss contract**, which ~20 call sites depend on and nothing covered before: a miss is `undefined`, an explicit fallback still wins (including before the pack loads — that branch runs once, so its test must be first in the file), falsy translations are real values, and `[data-lang]` / `-html` / `-attr` write hits while leaving misses' markup alone. The miss used to be the string `'Loading...'`, so both directions are pinned: that text now survives as a translation, **and** `getText(k) \|\| 'default'` reaches its default. Plus a **drift guard** that fails if any script in `public/scripts/` compares against the literal again — three of the six consumers have no unit tests, and mutation testing showed re-adding their comparison was otherwise invisible. |
| 1 | `frontend/unstageable-message.test.js` | The browser's rejection-copy resolver (`public/scripts/unstageable-message.js`) against a stubbed `LanguageSystem`: a translated code wins, an untranslated one degrades to the server's English, and no input shape ever yields an empty message. |
| 1 | `frontend/profile-menu/auth-modal.test.js` | The sign-in / create-account / forgot-password / verify-email modal (`profile-menu/auth-modal.js`) against a shim seeded from the **real template's ids** (`test/helpers/auth-modal-dom.js`), so the fixture can't drift from the markup. Written as **characterization tests before** the file was modernized, and unchanged after, which is what makes the refactor's "no behaviour change" claim checkable: mode-toggle copy and the confirm-password field (hidden *and* cleared *and* de-required), the forgot/verify panel swaps, mismatched passwords never reaching the network, and the success path storing the token exactly once. One of them started life failing — the `__stagifyPendingStaging` hand-off was dead, so signing in from "Stage this photo" opened nothing. |
| 1 | `frontend/profile-menu/profile-menu.test.js` | The dropdown's four render branches (guest / free / pro / pro-with-subscription) and that the module's IIFE boots at all — the `var`→`const` conversion's real risk is a temporal-dead-zone throw, which in an IIFE means a blank menu on every page rather than a test failure. Also pins that the account email is escaped, and that `refresh()` no-ops on pages with no menu markup. |
| 1 | `frontend/css-tokens.test.js` | The **design tokens** in `public/styles/`, as static analysis: no sheet hard-codes a colour that already has a token, every `var()` resolves to a token defined by a sheet that page also loads, and the served `demo-player.css` is still byte-identical to its `to-build/demos/` master. The scope check is the load-bearing one — an undefined `var()` does not fall back, it **drops the whole declaration**, silently and only on the page missing the defining sheet, which is exactly what a naive tokenization sweep causes in `legal.css` / `getpro.css` / `enterprise-msa.css` / `blog.css`. It found a live one on the way in: `styles.css` had `color: var(--text)`, a token that never existed. JS-set properties (`setProperty('--ar', …)`) and `var(--x, fallback)` are exempt. |
| 1 | `frontend/escape-html.test.js` | The frontend's single HTML escaper (`public/scripts/escape-html.js`): each of the five markup characters (quotes included — the profile menu interpolates into `title="…"`, where escaping only `&<>` still lets a quote close the attribute), script-tag and attribute-breakout payloads, `&`-first ordering, `null`→`''` while `0`→`"0"`, and that the admin + AI Designer names are re-exports of this exact function rather than lookalikes. Plus a **drift guard** that walks `public/scripts/` for hand-rolled escapers (an `&`→`&amp;` replace chain, or a `textContent`→`innerHTML` round trip) and fails on any second implementation — the point being that `admin/helpers.js`'s `esc` was once `String(s||'')`, a no-op named like a security function and wired to three `innerHTML` sinks. A second scan covers `profile-menu.js`, where **every** `lang()` value reaches `innerHTML` and so must be wrapped in `esc()` — content sites as much as `title=` / `aria-label=`; it carries a sanity assertion so it fails loudly rather than silently passing if the menu stops being built that way. |
| 1 | `frontend/language-loader-observer.test.js` | One guard: the i18n `MutationObserver` must drain its own records after re-applying, or a translated value containing a `data-lang` makes the pass re-trigger on its own `innerHTML` writes forever and hangs the tab. Scanned rather than driven — reaching that path needs a DOM, a `MutationObserver` and the module's `DOMContentLoaded` init, a harness larger than the line it protects. **Strips comments before scanning**: the fix's own comment names both `takeRecords()` and `disconnect()`, and the first version of this guard passed on that prose alone while the call was deleted. |
| — | `i18n/unstageable-i18n.test.js` | **Drift guard** between the rejection taxonomy (`lib/staging/unstageable.js`) and `public/languages/*.json`: every code is translated in **every** language, no pack carries a stale code, and no non-English pack still holds the English string. Needed because a missing key silently falls back to English rather than failing. |
| 1 | `data/public-email-domains.test.js` | The public-mailbox-provider gate (`lib/data/public-email-domains.js`) that stops `gmail.com` being sold as an enterprise domain. Matching is tested against the evasions someone would actually try — case, `@` prefix, a whole address, a trailing dot, a pasted URL, `mail.gmail.com` — plus the inverse (`notgmail.com`, `gmail.com.evil.co`, real brokerage domains must pass), the list's own hygiene, and the **i18n drift guard** for `enterprise.errors.publicDomain` across all 11 packs. |
| 1 | `frontend/app/remove-furniture-gate.test.js` | The stage modal's remove-existing-furniture rule (`public/scripts/app/remove-furniture-gate.js`) against a minimal fake DOM: the pure `removalAllowed(isPro, roomType)` decision, and that the DOM writer **clears the checkbox** (not just hides the row) when the control is withdrawn — the pipeline reads `.checked`, so a hidden-but-checked box would still submit `removeFurniture=true`. Also idempotence, since `applyUserToUI()` re-runs it from eight call sites. |
| 1 | `staging/prompts.test.js` | The staging/chat prompt builders (`lib/staging/prompts.js`): the chat system instructions embed their context and JSON contract, and `generatePrompt` composes the matrix text with the keep/remove-furniture branches. Also pins the **`Dorm` constraints** — that the fixed university-furniture and small-room-scale rules survive a custom style (which bypasses the matrix) and a remove-furniture request (which would otherwise strip them), including the block **ordering** that makes the override work. Asserts structure, never exact prose. |
| 1 | `frontend/app/download-menu.test.js` | The staged-result download sizes (`public/scripts/app/download-menu.js`) with `Image` stubbed: the readiness check (an unsized `<canvas>` reports the HTML default **300x150, not 0**, so the obvious `canvas.width > 0` reads "ready" on a blank page — that shipped once), `Original` matching the upload's **long edge** so a snapped-bucket aspect mismatch can't stretch the room, and the dimension probe resolving `null` on error/timeout instead of hanging (the first version used `img.decode()`, which never settles in a backgrounded tab, so the menu silently never opened). All three are quiet failures — nothing throws, the user just gets the wrong file or no menu. |
| 1 | `frontend/island-deps-typed.test.js` | **Drift guard + debt ledger** for the entry↔island seam. `tsconfig.frontend.json` runs `noImplicitAny: false`, so a factory written `createX(deps)` gets `deps: any` and the deploy-gating typecheck proves nothing about a 25-key wiring bag — a renamed state field or a dropped dependency type-checks clean and breaks in the browser. The eight Masking Studio factories are now typed against `masking-studio/types.d.ts`; this pins that and fails when a new untyped factory appears (or a listed one is typed and not removed). **Asks the real TypeScript checker for each parameter's type rather than grepping `@param`** — a text scan is satisfied by any comment mentioning the token, including this file's own prose, so it would pass with the annotation deleted. Mutation testing shaped it: an earlier version's "sanity" assertion walked the AST separately, so blinding the ledger's scan *and* emptying the ledger left both tests green; the population assertion now runs through the same scan. Eleven `app/` + `ai-designer/` factories remain on the ledger — shrink only. |
| — | `i18n/room-types-i18n.test.js` | **Drift guard** across the four places a room type must exist at once: `promptMatrix`, the `#room-type-select` options in `index.html`, the AI Designer routing enum (schema **and** the prose copy of it in both system instructions), and `roomTypes.*` in all 11 packs. Every one of these fails quietly on its own — a missing routing enum entry just reroutes to `Other` and the generic prompt, which is exactly how `Outdoors` went unreachable from chat until this guard was added. |

The table is a **representative selection**, not the full list — the suite has grown to
~90 files as `server.js` is extracted into `lib/` and pure frontend logic is pulled into
testable helpers. Most `lib/` modules now have a matching `*.test.js` (e.g. `logger`,
`logging`, `http-helpers`, `erase`, `image-review`, `image-annotation`, `hosted-images`),
as do the extracted frontend helpers — the `masking-studio-*` islands plus pure slices like
`heic-convert` (content-type sniffing), `count-up` (counter width/easing math),
`version-carousel` (version-history cap), and `download-menu` (download-size maths and the
staged-result readiness check). Run `npm test` for the authoritative set.

## Writing a new test

- Name it `test/<area>/<thing>.test.js`, picking the area from the [Layout](#layout) table
  above (mirror the source tree). The glob is `test/**/*.test.js`, so any depth is picked up
  automatically — but keep it in the folder that matches the module under test.
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
  to force deterministic paths (e.g. `GOOGLE_AI_API_KEY=''` disables the Gemini client so
  `validate-image` takes its documented fail-open branch). Blank the key of the client the
  code path actually uses — the stageability grader is **Gemini**, so `GPT_KEY=''` alone
  leaves it live and the test will hit a real API.
- If you add a route the frontend or an integration depends on, add it to
  `test/server/route-inventory.test.js` so a future refactor can't silently drop it.

## Debugging a failing run

- Run one file: `node --test test/data/auth-store.test.js`.
- Run one area: `node --test "test/routes/**/*.test.js"`.
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

**Opening the main tool's stage dialog.** Use `openStageModalViaUI(page)` — it clicks the
real hero upload button and waits for `#stage-modal`. Do **not** lift `.hidden` off the
modal with a `page.evaluate`: that was the house shortcut in nine specs, and it started
every story *after* `openFilePicker()`, the one gate deciding whether the dialog may open
(signed in → open, signed out → auth modal). Nothing drove that gate, which is how the
sign-in → staging hand-off could sit **dead** in all three sign-in paths. The signed-out
half now has its own spec, driven with `stubAnonymousAuth(page)` — the mirror of
`seedProSession` that mocks the auth endpoints but seeds **no** token.

What's covered today (all green — 79 tests across 23 specs):

| Spec | Covers |
|---|---|
| `index.spec.js` | Home page load smoke — hero stats, the custom select, and the before/after controls. |
| `i18n-observer-reentrancy.spec.js` | The i18n `MutationObserver` does not feed itself. Serves a doctored English pack whose `[data-lang-html]` value nests a `[data-lang]` span — the edit a translator could make — then inserts a translated node to kick the observer, and asserts the pass stays bounded. The **only** test that can prove this: the unit guard can scan for `takeRecords()` but not that draining stops the feedback, which needs a real DOM and a real observer. An init script wraps the `innerHTML` setter as a **circuit breaker** — after 400 writes it stops writing, so a runaway unwinds itself and fails as a clean assertion in ~6s instead of hanging the tab until the 45s timeout. Mutation-tested: deleting the drain fails it. |
| `stage-signin-entry.spec.js` | Main tool — the **signed-out entry path**, which is the app's highest-value flow and was the one thing no browser test touched: click "Upload image for free" → the auth modal (create-account mode), **not** the uploader → sign in → the stage dialog opens with the visitor's intent intact → upload and stage from it. Covers both callers of `completeSignIn()` (password login and register + emailed code), a rejected sign-in as the negative control, and the signed-in branch of the same gate. Mutation-tested against the real regression: reading `__stagifyPendingStaging` *after* `closeAuthModal()` clears it — the shape the bug had until 2026-07-28 — leaves the dialog shut and fails these. |
| `stage-reject.spec.js` | Main tool — a rejected upload surfaces the **localized** reason in the stage modal's error viewer before any generation is spent, plus an approved-upload negative control. The masking studio's reject path is a different consumer, hence the separate spec below. |
| `stage-room-type.spec.js` (2nd describe) | Main tool — the **remove-furniture gate**: the control is offered on a normal room, withdrawn when `Dorm` is picked, and restored on the way back; and a box checked *before* the switch does not still submit `removeFurniture=true`. Proves the two owners (`auth.js` plan gate, `app.js` room-type gate) actually cooperate in a real browser. |
| `stage-room-type.spec.js` | Main tool — picking a room type end to end: the `Dorm` option renders its **New** badge without leaking it into the trigger (`initCustomSelect` reads `.option-label`, not the option's whole `textContent`), and the value that reaches `/api/process-image` is the selected one. Third test drives a **localized** page and asserts the untranslated English `data-value` goes on the wire while the label shows Spanish — a translated value would miss `promptMatrix` and stage generically. |
| `ai-designer.spec.js` | Happy path — a chat turn renders the assistant text reply / a staged image. |
| `ai-designer-errors.spec.js` | A failed `/api/chat` shows a **retryable** error bubble, Retry re-sends and recovers, and a 403 (not Stagify+) shows a **non-retryable** error. |
| `ai-designer-mask-fit.spec.js` | Mask-editor sizing on a **short viewport** — regression for the dialog over-committing its height budget and clipping the photo with nothing to scroll. Asserts the whole image fits at 1280×620, still fits after entering the refine phase, and re-fits on resize. |
| `stage-mask-fab-processing.spec.js` | Main tool — the paint-brush FAB while a staging run is **in flight**: it blurs with the photo and stops taking clicks (keyboard path guarded in JS, since `pointer-events` can't cover it), then is sharp and clickable again once the run ends. `/api/process-image` is held open, never fulfilled, so the in-flight state can be inspected. |
| `masking-studio.spec.js` | Happy path — upload → paint a mask → prompt → Apply Edit renders a result. |
| `masking-studio-errors.spec.js` | A 500 from `/api/mask-edit` flips the area to a visible **Failed** state with a retry. |
| `masking-studio-reject.spec.js` | The stageability reject path: the photo enters the studio **immediately** (the response is gated open to prove it doesn't await the verdict), then is torn back out when the verdict lands. Also the browser-level proof that rejection copy is **localized** — the toast must show the language pack's wording for the returned `code`, not the server's English. |
| `masking-studio-resume.spec.js` | Session persistence — paint + prompt is saved to IndexedDB, survives a reload, and the Resume dialog restores the photo, layer, prompt, and painted mask. |
| `masking-studio-snap.spec.js` | An edit that spills past the highlight offers **Snap to object**, and accepting it consumes the suggestion. |
| `masking-studio-wand.spec.js` | Magic wand — prefetches `/api/segment` with a busy strip and paints from cache on click; a miss toasts and paints nothing; a failing segment toasts and is not cached. |

**Writing an e2e spec.** Name it `e2e/<thing>.spec.js`, call `seedProSession(page)` in a
`beforeEach` if the page is gated, `page.route('**/api/…')` **every** backend call it makes
(never hit a real provider), and assert on user-visible DOM. Reuse the room-photo and
tiny-PNG fixtures from `e2e/fixtures.js`, and reach the screen under test **through the UI**
(`openStageModalViaUI`) rather than by unhiding it — a shortcut past the entry point is how
that entry point ends up with no coverage at all.

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

## Coverage

`npm run test:coverage` ([`scripts/test-coverage.js`](../../scripts/test-coverage.js)) re-runs
the suite under V8 coverage and fails if **product-source** coverage dips below the floors in
that file. It runs in CI only — `npm test` (the deploy gate) does not measure coverage.

- **The floors are a ratchet, not a target.** They sit a few points under measured coverage so
  ordinary churn doesn't trip them. Raise them as coverage improves; **never lower them to make
  a red build pass.** Current floors — lines 85 / branches 77 / functions 84 — were set on
  2026-07-28 against a measured 88.09 / 81.04 / 86.44. Branches carry the widest margin because
  V8's branch attribution shifts most between Node minors.
- **Measure before you raise.** Node only enforces coverage thresholds on **>= 22.8**; on an
  older local Node the script prints the report and skips enforcement (CI pins Node 22-latest,
  so the gate always holds there). It also needs **>= 22.5** for `--test-coverage-exclude`, so on
  an older Node the printed summary still includes `test/` rows and reads several points high.
  To get the real number locally, emit lcov (`--test-reporter=lcov`) and sum `LF/LH`, `BRF/BRH`
  and `FNF/FNH` across the records whose `SF:` path is **not** under `test/`.

### The blind spot these floors have

V8 coverage only reports files the run actually **loaded**. A module under `public/scripts/`
that no test ever imports is in **neither the numerator nor the denominator** — it is invisible
to the floors, not averaged into them. Raising the floors can never surface it, and a new
untested frontend file lands without moving the aggregate at all.

[`test/frontend/untested-frontend-modules.test.js`](../../test/frontend/untested-frontend-modules.test.js)
is the guard for that. It walks the import graph from `test/` into `public/scripts/` and pins the
exact set of never-loaded modules as a **debt ledger** (68 of 107 files as of 2026-07-28,
excluding vendored bundles). The assertion is set equality, so it fails three ways:

| Failure | What it means | What to do |
| --- | --- | --- |
| `newlyUntested` | A frontend module arrived that no test loads | Write a test, or add it to `UNTESTED` to record the debt deliberately |
| `nowTestedOrGone` | A ledgered module gained a test, or was deleted/renamed | Remove it from `UNTESTED` — the ledger only ever shrinks |

Adding an entry is allowed; it's meant to be a visible, reviewable act rather than a silent
omission. The ledger is the thing that ratchets frontend coverage — the percentage floors can't.

## Continuous integration

Two independent pipelines run on the default branch:

- **GitHub Actions** ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) — on
  every push and PR to `main`, in **two parallel jobs**:
  - `test` — `npm ci`, then `npm test` (which type-checks **then** runs the unit suite), then
    `npm run test:coverage` (the coverage floors above), then `npm run lint`, then
    `npm audit --omit=dev --audit-level=high`. All blocking: a type error, a failing unit test,
    a coverage dip, any lint warning/error (`--max-warnings=0`), or a new high/critical
    advisory in a runtime dependency fails the build.
  - `e2e` — `npm ci`, installs Chromium (`npx playwright install --with-deps chromium`),
    then `npm run test:e2e`. Isolated in its own job so the heavier, occasionally-flaky
    browser run doesn't slow the fast unit gate. Blocking in CI, but see the deploy note.
- **Render** — the deploy build runs `sh scripts/build.sh` (which runs `npm test`), so a
  failing **unit** test **blocks the production deploy**. Neither the Playwright e2e job nor
  lint is part of the Render build.

Net: a **type error or a red unit test** blocks both CI and the deploy (both run inside
`npm test`). A lint finding, a **coverage** dip, a dependency advisory, or a failing **e2e**
test blocks CI (so it can't reach a clean `main`) but does **not** block the Render deploy —
by design, so browser flake can never wedge a release.
