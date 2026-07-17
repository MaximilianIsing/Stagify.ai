# Frontend

How the browser side of Stagify.ai is put together — the page/entry/island model,
and the standing decision to build it in vanilla ES modules rather than a component
framework. For the server side see [`architecture.md`](architecture.md); for the
translation system see [`i18n.md`](i18n.md).

## The big picture

The frontend is a **multi-page app of plain HTML + native ES modules**, served as-is
from `public/` — no framework, no bundler, no build step (that last part is its own
standing decision: [no frontend build step](architecture.md#decision-no-frontend-build-step)).
Each HTML page is independent: it loads a small set of `<script type="module">` entry
scripts, which talk to the JSON API over `fetch`.

```
public/<page>.html
   │  <script type="module" src="scripts/<page>-app.js">
   ▼
scripts/<page>-app.js         ← per-page entry (a client-side composition root)
   │  imports + wires…
   ▼
scripts/<page>/*.js           ← "islands": factories, pure helpers, shared stores
```

## Pages, entries, and islands

There are three tiers, mirroring the backend's composition-root + factory pattern
(see [`architecture.md`](architecture.md#the-composition-root--factory-pattern)) so
there is **one mental model across the stack**.

**1. Entry scripts** — one per interactive page, the client-side composition root:

| Page | Entry | Islands live in |
|---|---|---|
| `index.html` (staging tool) | `scripts/app.js` | `scripts/app/` |
| `ai-designer.html` | `scripts/ai-designer-app.js` | `scripts/ai-designer/` |
| `masking-studio.html` | `scripts/masking-studio-app.js` | `scripts/masking-studio/` |

The entry resolves the page's DOM elements once, then constructs and wires the islands
— exactly what `server.js` does with routers and `lib/` factories, but for the browser.

**2. Islands** — cohesive feature modules under `scripts/<page>/`, in three flavors:

- **Factory islands** — `createX(deps)` that owns a DOM subtree and its own state,
  returning a small API. Same factory-plus-dependency-injection shape as the backend.
  Example: [`scripts/app/furniture-refs.js`](../../public/scripts/app/furniture-refs.js)
  exports `createFurnitureRefs({ getStagingAlt })` → `{ getFiles, reset }`; the entry
  reads the accumulated files and resets them without knowing how the picker works
  inside. Factory islands stay a working no-op on pages that lack their elements.
- **Pure helpers** — no DOM, no state; deterministic transforms on their arguments, so
  they run under `node --test` with no browser shim. Example:
  [`scripts/app/helpers.js`](../../public/scripts/app/helpers.js) (`fillTemplate`,
  `dailyLimitMessage`, `roomDownloadSlug`, `dataURLToFile`, …), unit-tested in
  [`test/app-helpers.test.js`](../../test/app-helpers.test.js).
- **Shared stores** — cross-island state and persistence. Example: the Masking Studio's
  [`scripts/masking-studio/session-store.js`](../../public/scripts/masking-studio/session-store.js)
  owns the IndexedDB save/restore choreography for the whole studio.

**3. Standalone page scripts** — the non-interactive pages (marketing, legal, status,
guides) load small independent scripts (`carousel.js`, `home-reveal.js`, `count-up.js`,
the `language-*.js` i18n helpers, …). No entry/island structure — there is no app state
to compose.

### How to extend it

- **New cohesive feature on an interactive page?** Add a factory island under
  `scripts/<page>/` and wire it from the entry — don't grow the entry script inline.
- **Pure logic (formatting, validation, a slug, a template fill)?** Put it in a pure
  helper module and add a `node --test` spec. Prefer this over leaving logic inline in
  an entry script: it shrinks the entry, and it locks the behavior against regressions
  without a browser. This is an active, behavior-preserving refactor direction — e.g.
  the `{token}` interpolation and daily-limit message logic were hoisted out of
  `app.js` into `helpers.js` precisely so they could be tested.
- **Cross-island state?** Reach for (or create) a shared store island, not globals.

## Styles

CSS mirrors the JS split: one shared base plus per-page and per-feature files, linked
à la carte from each page's `<head>`. There is no CSS build/bundle either — the browser
gets the files as authored (same [no-build-step decision](architecture.md#decision-no-frontend-build-step)).

**Three tiers, same as the scripts:**

- **Site-wide base — `styles/styles.css`.** The design tokens (`:root` custom
  properties), reset, top navigation, buttons, language switcher, footer, and the custom
  scrollbar/spotlight chrome. Loaded by nearly every page. **Partially hand-minified at
  the top** (a deliberate exception to the no-minify rule — see
  [`architecture.md`](architecture.md#decision-no-frontend-build-step)), so edit it
  carefully; the lower sections are `/* === … === */`-commented and readable.
- **Per-page — `styles/<page>.css`.** One file per page's own layout: `home.css`
  (the index/marketing page), `ai-designer.css`, `masking-studio.css`, `stagify-plus.css`,
  `plus-welcome.css` (the post-checkout confirmation card), `enterprise.css`, `status.css`,
  `admin.css`, `getpro.css`, `reset-password.css`, `index.css`. Legal pages share
  `legal.css` (privacy + terms) and `enterprise-msa.css`.
- **Shared feature CSS — opt-in per page.** Small files a page links only if it uses the
  feature: `auth.css` (nav + auth-modal UI, on ~10 pages), `carousel.css`,
  `star-border.css`, `home-text-animate.css`, `demo-player.css`. A page pulls in only the
  feature CSS it actually renders, so no page carries the whole site's styles.

A given page therefore links `styles.css` + (usually) `auth.css` + its own `<page>.css`
+ any feature files it needs. Overlap between base and page files is deliberate and tiny
(a page-level `html`/`body`/scrollbar override for a full-bleed studio, a repeated
`.hidden` utility) — not copied rule sets.

**Non-render-blocking (lazy) CSS.** The heavy home page (`index.html`) splits its
stylesheets by criticality. `styles.css` / `carousel.css` / `home.css` load normally
(render-blocking); the below-the-fold ones (`auth.css`, `star-border.css`,
`home-text-animate.css`, `demo-player.css`) ship as `media="print"` with a `data-lazy-css`
attribute so they **don't block first paint**, and [`scripts/index-lazy-css.js`](../../public/scripts/index-lazy-css.js)
promotes each to `media="all"` once fetched. A `<noscript>` block links them the normal
way for the no-JS path. The promotion is an external script rather than an inline
`onload=` handler on purpose — it keeps the page under the CSP's `script-src-attr 'none'`
(no `unsafe-inline`).

**FOUC auth gates.** `ai-designer.html` and `masking-studio.html` carry a one-line inline
`<style>html.<x>-gate-pending body{visibility:hidden!important}</style>`. The gate script
([`ai-designer-gate.js`](../../public/scripts/ai-designer-gate.js) /
[`masking-studio-gate.js`](../../public/scripts/masking-studio-gate.js)) adds that class
before paint so a non-Pro visitor never flashes the studio, and the entry script removes
it once access is verified (with a ~6s safety-net redirect if the plan check stalls).
This one style **must** stay inline — it has to apply before any external CSS loads.

## Decision: vanilla ES-module islands, not a component framework

**Stagify's frontend is hand-written HTML/CSS/vanilla JS organized into ES-module
islands, and choosing *not* to adopt a client component framework (React/Vue/Svelte)
is a deliberate, standing decision — not a gap we simply haven't filled.** A framework
remains **deferred**, and the island-splitting / de-monolithing work is the chosen
alternative to one, not a way-station toward one.

This is worth writing down because at ~15k lines of vanilla JS the absence of a
component abstraction reads, at a glance, like an oversight. It isn't — here is the
reasoning, and the (narrow) conditions under which we'd revisit it.

**Why this is the right default here:**

- **The interactive surface is small and isolated.** Of ~16 pages, only three carry
  real interactivity (the staging tool, AI Designer, Masking Studio). The rest —
  marketing, legal, status, guides, auth — are essentially static content with light
  nav/i18n/auth scripts and would gain **nothing** from a component runtime. A framework
  would tax every page to benefit three.
- **The heaviest interactive code is canvas, which a framework does not simplify.** The
  largest modules — mask editing, draw tools, image viewers, viewport transforms — are
  imperative pointer/pixel code. `view = f(state)` rendering helps lists, forms, and
  modals; it does not shrink a brush engine. So the biggest files would stay roughly the
  same size after a migration.
- **A framework would force a build step.** SFC/JSX authoring requires bundling/transpile,
  which reverses the separate, deliberate
  [no-build-step decision](architecture.md#decision-no-frontend-build-step) — and with it
  the "what ships is what you debug" property and granular per-file caching.
- **i18n is DOM-coupled.** UI text is applied by scanning the document for `data-lang`
  attributes (see [`i18n.md`](i18n.md)); a template/vDOM layer would have to reconcile
  with that scanner across 11 languages — a large, cross-cutting mechanical cost.
- **The factory + DI island pattern already gives us a component boundary** — owned
  state, an explicit interface, no globals — without a runtime, a build, or a new
  dependency to track.

**The maintenance cost is real, but localized — so we manage it, not migrate for it.**
The honest downside the pattern carries is that entry scripts are procedural and can
grow (`app.js` is ~1k lines). But recent git history concentrates frontend change in
that **one** staging entry, not evenly across the 15k lines — the studio internals and
the static pages are comparatively stable. (Some of `app.js`'s churn is ordinary feature
work on the flagship tool, not pure friction.) The proportionate response is to keep
`app.js` healthy, not to re-architect the whole frontend:

- **Type safety everywhere** — the entire frontend is `checkJs` + JSDoc typed with zero
  `@ts-nocheck`, and a type error gates the deploy (see [`testing.md`](testing.md#type-checking)).
- **Pure logic is extracted and unit-tested** — branchy or reusable logic moves from the
  entry into a pure helper island with a `node --test` spec, shrinking the hotspot and
  pinning its behavior.
- **The two studios have Playwright e2e smokes** (`e2e/`) covering their happy, error,
  and resume paths with every `/api/*` mocked.
- **Islands keep each feature bounded** — new behavior lands in a new module, not as
  another 50 lines in the entry.

**If the tax ever outgrows those measures**, the escalation path — in order, and none of
it requiring a full framework or a build step — is:

1. **Native Custom Elements** for repeated UI units (layer rows, chips, toasts, modals).
   This *is* a component model, browser-native, no build. Use **light DOM (no shadow
   root)** so the global `data-lang` scanner keeps translating their contents.
2. **A tiny standalone reactive store** (`@vue/reactivity` or nanostores, both no-build)
   if cross-island `deps`-threading becomes the dominant pain.
3. **A full component framework** only if the triggers in the
   [no-build-step decision](architecture.md#decision-no-frontend-build-step) also fire
   (a real dependency graph, a desire for TypeScript/JSX source, or measured load-time
   dominated by JS in a way HTTP/2 + compression can't fix).

> **When to reopen this — and only then:** one of the escalation-step-3 triggers above
> actually fires. Absent that, the answer to "should we adopt a frontend framework?" is
> **no** — prefer another island, a pure helper + test, or (if a real component
> abstraction is needed) a native custom element. Don't re-litigate it per-PR.
