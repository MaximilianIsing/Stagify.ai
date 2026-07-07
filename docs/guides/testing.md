# Testing

The suite runs on the **built-in Node test runner** — no Jest, no Mocha, no extra
dependencies.

```bash
npm test        # node --test "test/**/*.test.js"
npm run lint    # eslint .  (backend only — see Linting below)
```

> **Tests gate deployment.** `render.yaml`'s build command is
> `npm install && npm test`, so a failing test **blocks the Render deploy**. Keep the
> suite green — a red test is a stuck release, not just a warning. (Lint does **not**
> gate anything yet — see below.)

## Philosophy

Tests are cheap, hermetic, and aimed at the regressions that actually hurt: silent auth
bypasses, revenue bugs, a server that won't boot, and broken static/asset references.
**Nothing contacts a paid API, spends money, or needs real secrets** — the server
degrades gracefully when unconfigured, and billing/auth logic is exercised over throwaway
temp-dir stores with hand-built event objects.

## The test harness

`test/helpers/server.js` (not a `*.test.js`, so it's never run as a spec) exports
`startServer(extraEnv)`. It:

- picks a free port from the OS (so tests never collide with a dev server),
- spawns the **real** `server.js` as a child process with `NODE_ENV=test` and any
  `extraEnv` overrides,
- resolves once the child logs `Server running on port …` (20s boot timeout),
- returns `{ baseUrl, output(), close() }`.

Boot/HTTP tests use this to hit the actual server; pure-logic tests import a `lib/`
module directly and point it at a temp directory.

## What's covered

The files are informally tiered from cheapest/most-fundamental to broader:

| Tier | File | Covers |
|---|---|---|
| 0 | `smoke.test.js` | The server boots and `GET /health` returns `200 {status:'healthy'}`. The most common outage ("it doesn't start") caught first. |
| 1 | `static.test.js` | No server, no network: `server.js` + every `lib/*.js` parses; client scripts parse; **local asset references in `public/*.html` exist on disk**; every language file is valid JSON and **covers `english.json`'s keys**; `sitemap.xml`/`manifest.json` are well-formed. |
| 2 | `guards.test.js` | Access-guard status codes — log/admin routes 403 without a key, endpoint-key routes 403, Pro-only routes 401 without a session. Guards against silent auth bypass. |
| 2 | `auth-store.test.js` | Auth correctness: register→login round-trip, email-code gating, salted/hashed passwords, session validate/logout, single-use password reset, non-enumerating reset, free-tier daily limits, anonymous mobile IP cap. |
| 2 | `stripe-webhooks.test.js` | Billing lifecycle over hand-built events: checkout upgrades to Pro (by ref or email), `subscription.deleted` downgrades, `updated`→active restores Pro, enterprise routes to the enterprise store. Catches "paid but no Pro" / "churned but still Pro". |
| 2 | `enterprise-store.test.js` | Domain activation (idempotent, case-insensitive), subscription-state sync, usage counting. |
| 2 | `staging-endpoints.test.js` | Staging contracts without any AI call: `validate-image` rejects bad input (400) and fails open (200) when the reviewer is disabled; `process-image` requires a session for desktop. |
| 2 | `public-endpoints.test.js` | Public surface smoke: JSON endpoint shapes, SEO/landing files serve, static content types, unknown routes 404, a helmet header is present. |
| — | `route-inventory.test.js` | Refactor safety net: asserts every **critical route is still registered** (responds with anything but 404 for its method). Guards the `server.js` → `routes/*` extraction. |
| — | `uptime.test.js` | Pure math of the uptime monitor: window percentages, coverage, bucket classification, incident coalescing/pruning. |

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

- **Prefer pure-logic tests** against a `lib/` module with a temp dir — they're fast and
  need no server. Reach for `startServer()` from `test/helpers/server.js` only when you
  must exercise real routing/middleware.
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

## Linting

```bash
npm run lint     # eslint .
```

ESLint uses a flat config ([`eslint.config.js`](../../eslint.config.js)):

- **Backend only.** It lints `server.js`, `load-env.js`, `routes/**`, `lib/**`, and
  `test/**`. The frontend (`public/scripts/*.js`) is **intentionally not linted yet** —
  those are classic `<script>` files that share globals across files, so `no-undef` /
  `no-unused-vars` would flood with false positives until they get a browser-specific
  config. `node_modules`, `public`, `ds-bundle`, `demos`, and `*.min.js` are ignored.
- **Deliberately lenient.** It's `@eslint/js`'s recommended set plus `no-unused-vars`
  as a **warning** (an `_`-prefixed name is treated as intentionally unused). The plan
  is to tighten once the backend baseline is clean.

## Continuous integration

Two independent pipelines run on the default branch:

- **GitHub Actions** ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) — on
  every push and PR to `main`: `npm ci`, then `npm test` (**blocking**), then
  `npm run lint` (**non-blocking**, `continue-on-error: true` — it reports findings but
  never fails the build). Remove that flag once the backend is lint-clean to enforce it.
- **Render** — the deploy build runs `npm install && npm test`, so a failing test
  **blocks the production deploy**. Lint is not part of the Render build.

Net: a red test blocks both CI and the deploy; a lint finding currently blocks neither.
