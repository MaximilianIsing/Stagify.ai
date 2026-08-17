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
| `exterior-studio.html` | `scripts/exterior-studio-app.js` | `scripts/exterior-studio/` |

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
  [`test/frontend/app/app-helpers.test.js`](../../test/frontend/app/app-helpers.test.js).
- **Shared stores** — cross-island state and persistence. Example: the Masking Studio's
  [`scripts/masking-studio/session-store.js`](../../public/scripts/masking-studio/session-store.js)
  owns the IndexedDB save/restore choreography for the whole studio.

**Cross-page shared modules** live outside the `<page>/` folders, because more than one
entry imports them. A `scripts/app/…` file importing from `scripts/ai-designer/…` is the
shape to avoid; promote instead. Two shapes, by size:

- **Single files at `scripts/` root** for one self-contained concern: `toast.js`,
  `escape-html.js`, `mask-core.js`, `heic-convert.js`, `i18n-routing.js`,
  `unstageable-message.js`, and the generated `locale-data.js` (see
  [`i18n.md`](i18n.md) — do not edit it by hand).
- **A `scripts/<subsystem>/` folder** when the shared thing is a cohesive set rather than
  one file. [`scripts/mask/`](../../public/scripts/mask/) is the worked example: the mask
  editor's brush, viewport pinning, processing overlay, reference photo, sizing, refine
  maths, `/api/mask-edit` request and phase copy, shared by the main tool's
  [`app/stage-mask-editor.js`](../../public/scripts/app/stage-mask-editor.js) and the AI
  Designer's [`ai-designer/mask-editor.js`](../../public/scripts/ai-designer/mask-editor.js).
  Eight files at `scripts/` root would have said nothing about belonging together.

What stays per-page is what genuinely differs. The two mask editors keep their own DOM
ownership (one builds its dialog at runtime, the other binds to static markup), their own
commit destinations, and their own modes — and their own phase machines, which are mostly
DOM toggling and would need about as much configuration as they'd save. Share the
algorithms and the data; leave the wiring.

### Shared chrome: the header and footer are copied by hand, on purpose

The site header (`<header class="site-header">`, ~37 lines) is duplicated into **12**
`public/*.html` files, and the site footer (Privacy · Terms · Status · ©) into **6**.
This looks like the obvious thing to extract, and periodically gets flagged as such.
**It cannot become a runtime include.**
[`lib/i18n/render-page.js`](../../lib/i18n/render-page.js) is a *pure string transform
over the static English HTML* — so chrome injected by client-side JS would never be
server-side translated, and `/es`, `/fr/guides.html` … would ship an English header to
crawlers and to no-JS clients. The markup has to stay literal in every file.

Note the shape of that constraint: it rules out a *runtime* partial, not a *build-time*
one. [`scripts/build-i18n-seo.js`](../../scripts/build-i18n-seo.js) already rewrites
these files in place (idempotent, anchor-based, drift-tested), and a header injector
could follow the same pattern. That has not been done — it fixes no bug and adds a build
step that is deliberately *not* wired into `scripts/build.sh` — but it is the shape to
reach for if nav churn ever justifies it. What is **not** available is pointing the
renderer at the English pages: `express.static` is mounted in
[`app-middleware.js`](../../lib/http/app-middleware.js) well before any router and
already answers `/` and every `*.html`.

Because the markup must stay duplicated, **the guard is the fix**, and each block has one:

| Block | Guard |
|---|---|
| Whole header | [`test/frontend/site-header-parity.test.js`](../../test/frontend/site-header-parity.test.js) |
| Staging dropdown sub-block | [`test/frontend/staging-menu.test.js`](../../test/frontend/staging-menu.test.js) |
| Header `aria-label` i18n | [`test/i18n/nav-aria-i18n.test.js`](../../test/i18n/nav-aria-i18n.test.js) |
| Whole footer | [`test/frontend/site-footer-parity.test.js`](../../test/frontend/site-footer-parity.test.js) |

All four share discovery and extraction via
[`test/helpers/nav-pages.js`](../../test/helpers/nav-pages.js), so they cannot disagree
about *which* pages carry a block — a guard that quietly narrows its own file list keeps
passing while checking less, which is the failure mode it exists to prevent. Two traps
that helper already handles, and any future scan over this markup must too: comment
bodies are masked length-preservingly (`gallery.html` quotes the header's opening tag
inside a comment), and blocks are matched by **tag depth**, because several pages nest
further `<header>` elements inside the page body.

The footer is the cautionary tale. It went unguarded until 2026-08-10 and drifted into
three variants — `guides.html` and `404.html` lost their `data-lang` attributes entirely
and shipped an English footer on all eleven locales, while two rival year mechanisms
(`id="year"` in `app.js` vs `.footer-year` + `scripts/footer-year.js`) meant the block
could not be one shape. Every key involved already existed in all eleven packs; only the
attributes were missing. Two sanctioned variations remain, each pinned by a named
constant in the spec: `gallery.html`'s `id="gal-nav"`, the empty `.nav-trailing` on the
three marketing pages, and `enterprise.html`'s class-styled `.ent-site-footer`.

**When you add a page with this chrome, copy the block verbatim and run `npm test`** —
the guards will tell you what you dropped. When you change the chrome, change it in every
file; there is no shortcut, by design.

**User-facing messages go through [`scripts/toast.js`](../../public/scripts/toast.js)**
(`showToast(msg, type)` / `showErrorToast(msg)`) — the single message channel for all
three studios. It self-creates its `#toast-host`, so a page needs no markup for it, but
it **does** need to link [`styles/toast.css`](../../public/styles/toast.css). Do not
reach for native `alert()`: it blocks the page, ignores the language pack's styling, and
until recently was the main staging tool's entire error channel. The one deliberate
exception is `heic-convert.js`'s "Converting photo…" indicator — a reference-counted
progress spinner of indefinite duration, which is a different thing from a transient
message and stays separate.

**Anything interpolated into an `innerHTML` string goes through
[`scripts/escape-html.js`](../../public/scripts/escape-html.js)** (`escapeHtml(value)`) —
the one escaper, re-exported under the names the call sites already used
(`admin/helpers.js`'s `esc`, `profile-menu/dom-utils.js`'s `esc`,
`ai-designer/format.js`'s `escapeHtml`). It escapes `&<>` **and both quote styles**,
because values also land inside quoted attributes (`title="…"`, `aria-label="…"`) where
a bare quote closes the attribute early.

Prefer `textContent` or the `el()` builder when you are only inserting text — that
needs no escaping and cannot be got wrong. Reach for `escapeHtml` when you are
genuinely assembling markup.

There were three implementations before, and the admin one was `String(s || '')` — a
no-op wearing a security name, wired into three `innerHTML` sinks. Every argument
happened to be a literal, so nothing was exploitable; the hazard was the next person
writing `esc(user.email)` and believing it was handled. **Do not add a fourth copy** —
`test/frontend/escape-html.test.js` walks `public/scripts/` and fails on any second
hand-rolled escaper.

**Translated strings count as data here too.** `lang(...)` values are team-authored, so
this is not an XSS question — it is a translator writing `&`, `<`, or a quote and silently
mangling the markup. Every `lang()` value that `profile-menu.js` concatenates into its
dropdown is wrapped in `esc()`, attributes and element content alike, and the same spec
scans that file and fails on a bare one. Escaping only the attribute sites reads like a
considered decision when it is really the next oversight waiting to be copied.

**Worked example — the admin dashboard.** `/admin` is the fullest instance of this
pattern: an entry (`admin.js`) that owns auth and fetching, table islands
(`admin/renderers.js`), two chart-panel islands (`admin/overview.js`, `admin/insights.js`),
and two DOM-free logic modules (`admin/analytics.js` for aggregation, `admin/charts.js`
for the hand-rolled SVG) that are unit-tested without a browser. See
[`admin-dashboard.md`](admin-dashboard.md).

**3. Standalone page scripts** — the non-interactive pages (marketing, legal, status,
guides) load small independent scripts (`carousel.js`, `home-reveal.js`, `count-up.js`,
the `language-*.js` i18n helpers, …). No entry/island structure — there is no app state
to compose.

### The custom select

`initCustomSelect(rootSelector)`
([`scripts/app/custom-select.js`](../../public/scripts/app/custom-select.js)) wires a
`.custom-select` root — the room-type and furniture-style pickers in the stage modal. It
is a plain exported function (no app state) returning `{ value, set }`, and yields a no-op
handle when the root is absent, so pages without the modal keep working.

The markup contract:

```html
<div id="room-type-select" class="custom-select" data-value="Bedroom">
  <button class="select-trigger"><span class="select-value" data-lang="roomTypes.bedroom">Bedroom</span>…</button>
  <div class="select-menu hidden" role="listbox">
    <div class="option" data-value="Bedroom" data-lang="roomTypes.bedroom">Bedroom</div>
  </div>
</div>
```

**`data-value` is the wire value and stays untranslated** — `initCustomSelect` mirrors the
picked option's `data-value` onto the root, and that is what gets submitted. `data-lang`
controls only the visible label. Never derive a submitted value from displayed text.

**Options with extra chrome** (the `New` badge on the Dorm room type) need a different
shape, because `data-lang` sets `textContent` and would wipe any nested markup on every
language switch. Put the badge *beside* a label span rather than inside it, and leave the
option element itself without a `data-lang`:

```html
<div class="option option--with-badge" data-value="Dorm" role="option">
  <span class="option-label" data-lang="roomTypes.dorm">Dorm</span>
  <span class="option-badge" data-lang="common.newBadge">New</span>
</div>
```

`initCustomSelect` reads `.option-label` when present (otherwise the whole option), so the
trigger shows `Dorm` rather than `DormNew`, and copies that span's `data-lang` onto the
trigger so a later language switch re-renders the *selected* room, not the authored
default. The same sibling-span shape is what the SSR renderer needs — a `data-lang` on the
wrapper would swallow the badge server-side too (see [`i18n.md`](i18n.md)). Covered by
[`e2e/stage-room-type.spec.js`](../../e2e/stage-room-type.spec.js).

**Reacting to a pick.** Pass `{ onChange }` as the second argument to be notified when the
user selects an option: `initCustomSelect('#room-type-select', { onChange: fn })`. It fires
only on a real pick, **not** on the programmatic `set()` — a caller using `set()` already
knows the value it just wrote, and firing there would re-enter whatever sync logic that
caller is in the middle of.

### The remove-furniture gate

The stage modal's **Remove existing furniture** checkbox is gated by two conditions owned
by two different files — the plan (Stagify+/Enterprise only, applied by `auth.js` on every
auth change) and the room type (a dorm's issued furniture is fixed, applied by `app.js` on
every select change).

Both funnel through
[`scripts/app/remove-furniture-gate.js`](../../public/scripts/app/remove-furniture-gate.js),
which recomputes the whole rule from scratch, so there is **exactly one writer**. Don't
add a second place that toggles `#remove-furniture-row`: `applyUserToUI()` runs from eight
call sites (login, logout, profile menu, Google sign-in, after a staging run), and any of
them would re-reveal the row while a no-removal room is still selected.

Two things worth knowing before touching it:

- **Hiding the row is not enough — the checkbox must be cleared.**
  `staging-pipeline.js` reads `#remove-furniture.checked` directly, so a hidden-but-checked
  box still submits `removeFurniture=true`. The gate clears it and dispatches `change`,
  which is also what puts the variation slider back and hides the keep-furniture box.
- **The rule is a pure function** (`removalAllowed(isPro, roomType)`) so it is unit-tested
  without a DOM — [`test/frontend/app/remove-furniture-gate.test.js`](../../test/frontend/app/remove-furniture-gate.test.js).
  The browser-level wiring is covered by
  [`e2e/stage-room-type.spec.js`](../../e2e/stage-room-type.spec.js).

To make another room type drop the control, add its key to `ROOM_TYPES_WITHOUT_REMOVAL`.

### The staging wait: one abort, three meanings

`staging-pipeline.js` arms a `STAGING_TIMEOUT_MS` (3 min) ceiling and shows
`#stage-cancel-btn` for the life of the request. Before that there was neither — no
client timeout and no `server.setTimeout` — so a provider that hung left the progress
bar frozen at 70% for as long as the socket stayed open, with nothing to click. The
guides answered that with "refresh after a minute", which throws away renders that are
still legitimately running (a Stagify+ job is several variations, each of which may
retry for quality).

The subtle part is that **three different things abort the same fetch** and they must
not be reported alike: a photo the stageability pre-check refused, the ceiling, and the
user pressing Cancel. `explainAbort` is the one place that decides which — the
pre-check's own reason wins, a timeout paints a message, and a cancel paints nothing at
all and is marked `stagingMessageShown` so the caller doesn't stack an error banner over
something the user deliberately did.

The ceiling is injectable (`stagingTimeoutMs`) purely so a test can drive it. Note that
`test/frontend/app/staging-pipeline.test.js` squashes timers, but only those **under
10 s** — collapsing a three-minute ceiling to 1 ms made it fire during every test and
abort each fetch before it could be settled.

### The download resolution menu

`createDownloadMenu(deps)`
([`scripts/app/download-menu.js`](../../public/scripts/app/download-menu.js)) owns **both**
halves of the split button in the staged-result viewer: the plain `Download Result` button
and the caret beside it that opens a size picker. It reuses the custom select's
`.select-menu` / `.option` classes, but the rows are built in JS rather than authored in
markup, because each one shows its own computed pixel dimensions.

```html
<div class="viewer-actions">
  <button id="new-upload" class="btn btn-ghost">
    <strong class="label-full"  data-lang="modal.staging.uploadAnother">Upload Another</strong>
    <strong class="label-short" data-lang="modal.staging.uploadAnotherShort">Reupload</strong>
  </button>
  <div id="download-split" class="download-split">
    <button id="download-btn" class="btn btn-primary" disabled>
      <strong class="label-full"  data-lang="modal.staging.downloadResult">Download Result</strong>
      <strong class="label-short" data-lang="modal.staging.downloadResultShort">Download</strong>
    </button>
    <button id="download-size-toggle" class="btn btn-primary download-caret" disabled …>…</button>
    <div id="download-size-menu" class="select-menu download-size-menu hidden" role="menu"></div>
  </div>
</div>
```

Five rules worth knowing before touching it:

- **Both buttons ship `disabled` in the markup.** The island flips them on when a staged
  result exists and back off on reset, driven by a `MutationObserver` on `canvas1`'s
  `width` attribute — so the enable/disable rule lives in one place instead of being
  threaded through every site in `app.js` that stages, resets, or switches version.
- **Readiness is the width ATTRIBUTE, never `canvas.width`.** An unsized `<canvas>`
  reports the HTML default `300x150`, not `0`, so `canvas.width > 0` is true on a blank
  page. That is how the control first shipped enabled before anything was staged (and is
  where a stray `300x150` download comes from). See `canvasIsReady`.
- **`Original` matches the upload's long edge, not both dimensions.** The staged output's
  aspect ratio is a snapped Gemini bucket and can differ from the upload's by a few
  percent; forcing both would stretch the room. Each row therefore displays the size it
  will actually deliver, which may not equal the upload's.
- **Never use `img.decode()` to measure the upload.** It is tied to the rendering pipeline
  and never settles in a backgrounded tab, which leaves the menu awaiting forever and
  simply never opening — no error, no menu. `probeDimensions` uses `onload`/`onerror`
  behind a timeout; a failed probe costs only the `Original` row.
- **Each action carries BOTH labels; CSS picks one.** Below 600px the viewer header has to
  fit the Before/After toggle *and* both actions on one row — about 317px at a 375px
  viewport. The full wording does not fit at any sane padding, so mobile shows
  `.label-short` (`Reupload` / `Download`) and hides `.label-full`; desktop does the
  reverse. Both live in the markup rather than JS swapping `textContent`, so `data-lang`
  keeps translating them and the SSR renderer sees both (see [`i18n.md`](i18n.md)) —
  which means a new language needs `uploadAnotherShort` and `downloadResultShort`, not
  just the full keys. The mobile block also sets `.viewer-actions { display: contents }`,
  promoting both actions into `.viewer-header`'s flex flow so all three controls share
  one row instead of being boxed together.
- **The three controls are flush and fill the row exactly.** `gap: 0` plus equal
  `flex: 1 1 auto` on the toggle, `#new-upload` and `.download-split`, so the ~20px the
  tightened labels leave over is shared between them rather than pooling as holes — zero
  gap, both outer edges flush to the header. Note `#new-upload` sets its grow in the same
  rule that releases the global mobile `width:100%/max-width:280px`; splitting those into
  two rules lets the later same-specificity one silently clobber the grow.
- **Positional CSS on a bare `.download-size-menu` selector does nothing.** `.select-menu`
  is declared later in `styles.css` at the same specificity, so its `left: 0` beats any
  `left`/`right` set on `.download-size-menu` — which is why the menu stayed anchored to
  the split's LEFT edge and ran off-screen on mobile once the split got narrow, clipping
  the dimensions column. The mobile block right-aligns it via
  `.download-split .download-size-menu` (one class deeper, so it actually wins) plus a
  `max-width: calc(100vw - 24px)` backstop. Anchor from that selector, not the bare one.
- **The fit is tight, and deliberately degrades rather than overflows.** `flex-wrap` stays
  on, so an over-long translation or a very narrow phone drops the split to a second row —
  where it still grows to full width, so there are no holes there either. Verified at
  320–600px and in all 11 languages. If you lengthen either short label, re-check French:
  `Télécharger` is the binding constraint and is not meaningfully shortenable, which is
  why the French reupload label is the terser `Changer`.

Sizes are multipliers of what the model actually produced. Upscaling is plain
interpolation and adds no real detail, so rows state their true pixels rather than
implying otherwise. Pure logic covered by
[`test/frontend/app/download-menu.test.js`](../../test/frontend/app/download-menu.test.js).

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
- **New factory island?** Type its `deps` bag — see the next section.

### Type the dependency bag, or the wiring is unchecked

`tsconfig.frontend.json` runs with `noImplicitAny: false` for the rollout, so a factory
written as `createX(deps)` with no JSDoc gets `deps: any` — and every key destructured
out of it is `any` too. That is not a cosmetic gap. It means `npm run typecheck`, which
gates the deploy, proves **nothing** about the entry↔island seam: a renamed state field,
a dropped dependency, or a callback invoked with the wrong arity all type-check clean and
fail in the browser instead.

The Masking Studio is the worked example, because it is the extreme case: eight islands
share one mutable store and seven of them write to it. The shape is written down once in
[`scripts/masking-studio/types.d.ts`](../../public/scripts/masking-studio/types.d.ts)
(`MsState`, `MsLayer`, and friends — same `.d.ts` idiom as the backend's
[`lib/types/`](../../lib/types)), the entry annotates its store literal with it, and each
island types its bag against it:

```js
/**
 * @param {{
 *   state: import('./types.js').MsState,
 *   baseCanvas: HTMLCanvasElement,
 *   setZoom: (nz: number, focal?: { x: number, y: number } | null) => void,
 *   …
 * }} deps
 */
export function createDrawTools(deps) {
```

The AI Designer has no equivalent shared store — the entry hands each island getters and
callbacks instead — but the conversation history and the image objects derived from it
recur across its islands, so those live in
[`scripts/ai-designer/types.d.ts`](../../public/scripts/ai-designer/types.d.ts)
(`AdImage`, `AdHistoryEntry`). The `scripts/app/` islands needed no shared file at all:
their bags are DOM refs and callbacks, typed inline.

Three things to know before you write one:

- **Derive the types from the implementations, not from the wiring comment.** The islands
  used to carry a hand-maintained `// deps: { … }` header listing their keys. Four had
  already drifted — `layers-ui`, `generate-pipeline`, `upload` and `stage-mask-editor` each
  took one more dependency than their comment admitted. Those lists are gone now; the
  `@param` is the contract, and unlike a comment it is checked. The header comments that
  survive describe *what the island is for*, which is the part a type cannot say.
- **The layer shape has one producer.** `createLayer` in `layers.js` returns `MsLayer`, and
  `deserializeLayer` in `session.js` rehydrates through it. Keep those in step with the
  typedef rather than describing a layer a second time.
- **Cast at the entry, not by loosening the island.** `document.getElementById` yields
  `HTMLElement` and `querySelector` yields `Element`, so a bag that honestly wants an
  `HTMLInputElement` will not accept them. Widening the island's type to match hides what
  it actually needs; a `/** @type {HTMLInputElement} */ (…)` cast where the element is
  resolved keeps the island's contract honest. That was already the house style in
  `ai-designer-app.js` before this rule existed.

Stay permissive where a union would only fight the code. `AdHistoryEntry.role` is `string`,
not `'user' | 'assistant' | 'system'`, because entries are assembled from variables at
half a dozen sites — the union produced widening errors at every construction and caught
no real bug. The same reasoning is why `lib/types/*.d.ts` says it is permissive by design.

[`test/frontend/island-deps-typed.test.js`](../../test/frontend/island-deps-typed.test.js)
is the ratchet. It asks the real TypeScript checker for each factory's parameter type
(not a grep for `@param` — a text scan is satisfied by any comment that mentions the
token, so it would pass with the annotation deleted) and asserts set equality against a
debt ledger of the factories still untyped. **That ledger is now empty**, and every
injected factory under `public/scripts/` is typed — the studios, the shared `scripts/mask/`
slices, the admin panels and the profile menu. Adding an entry is allowed but is a
deliberate, reviewable act: it means shipping wiring that nothing checks.

Because an empty ledger is also what a *broken scan* produces, a second assertion pins the
whole factory population by name. Add a factory, add it there too.

### Dialogs built in JS need their ARIA written by hand

A dialog assembled in JavaScript gets none of the review attention the markup ones get:
nobody reading the HTML sees it, and there is no jsdom in the test setup to render it.
The AI Designer mask editor (`scripts/ai-designer/mask-editor.js`, built lazily on first
open) shipped that way — no `role="dialog"`, no `aria-modal`, no `aria-labelledby`, and a
close button whose only content was a `×`, so screen readers announced it as "times".

A dialog here owes four things:

1. `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at its heading's
   `id`. (Toggling visibility with `display:none` already removes it from the
   accessibility tree, so no `aria-hidden` juggling is needed on top.)
2. An **`aria-label` on any glyph-only button**, with the glyph itself wrapped in
   `aria-hidden="true"` so it isn't appended to the name. Use the `common.close` key —
   it is already translated in all 11 packs. A JS-built dialog has no `data-lang-attr`
   pass over it, so it has to look the key up itself (see `mask-editor-i18n.js`).
3. **Focus moved into the dialog on open and restored to the opener on close.** Without
   it, focus stays on the control behind the overlay: the dialog is never announced, and
   Escape/Tab act on the page underneath. A Tab trap is not a substitute — it only reacts
   once Tab is pressed. Guard the restore on `opener.isConnected`; committing an edit can
   replace the element that opened the dialog.
4. A test. `test/frontend/dialog-a11y.test.js` reads the source of every studio dialog
   (markup and JS alike) and fails the deploy if any of this goes missing;
   `e2e/ai-designer-a11y.spec.js` checks the live elements and the focus round-trips,
   which source-reading cannot.

All four studio dialogs now do this: both mask editors, `#bug-report-popup`, and
`#image-modal`. The lightbox's close control had to become a `<button>` first — it was
a `<span>`, so it was not keyboard-reachable at all.

> **Adjacent gap:** the lightbox's *trigger* is a bare `<img>` with a click handler, so
> the dialog still cannot be opened from the keyboard. Fixing that means making the
> thumbnail a real control, which is a layout change rather than an attribute, so it is
> deliberately not bundled with the dialog fix.

### Classic scripts run before deferred modules

`ai-designer.html` loads `scripts/ai-designer-model-selector.js` as a **classic**
`<script>`, so it executes during parsing — *before* the deferred
`<script type="module">` entry that defines the functions it wants to call. Anything the
module exposes on `window` therefore does not exist yet when the classic file runs.

The failure mode is quiet and specific: **passing a bare identifier as a callback
evaluates it immediately.**

```js
closeBtn.addEventListener('click', closeImageModal);   // ReferenceError, right here
closeBtn.addEventListener('click', function () {       // fine — resolved when clicked
  if (typeof window.closeImageModal === 'function') window.closeImageModal();
});
```

The first form threw before the listener was ever attached, so the lightbox's "×" did
nothing for as long as it existed, while Escape and click-outside kept working (they
resolve the name inside their own handler bodies). Because the file is classic — no
`import`/`export` — it is **not linted**, so `no-undef` never flagged it. Two more of
these are live in the same file today: `setTimeout(updateMaskEditorTranslations, …)` at
two call sites, and the bug-report submit handler's references to `conversationHistory`,
`lang` and `showToast`.

### Nothing blocks the parser in `<head>` without a reason

With no bundler, every page hand-lists its `<script>` tags, so a copy-pasted tag
inherits whatever attributes the page it came from had — and a mistake propagates by
duplication rather than showing up in one config file. A synchronous `<script src>` in
`<head>` stops HTML parsing until it is fetched and executed, which also delays
discovery of the stylesheet links below it.

A short allow-list is permitted to do it, because each has to act before anything paints:
`ai-designer-gate.js` and `gallery-gate.js` (viewport redirects), `faq-redirect.js` (a
meta-refresh stub), `preview-gate.js` (applies the cached-Pro page shape — see *Paid pages
RESHAPE* below), and `session-class.js` (sets `html.has-session` so the nav's Gallery tab
does not pop in a round trip late). Everything else in a `<head>` carries `defer`, `async`,
or is a module. The list lives in
[`head-scripts.test.js`](../../test/frontend/head-scripts.test.js), each entry with its
reason, and it has been shrinking: `masking-studio-gate.js` and `exterior-studio-gate.js`
were both on it and are gone.

The Google Ads tag (`scripts/gtag.js`) was the exception that proved the rule: it sat
synchronous and **first** in `<head>` on all 19 public pages, ahead of every stylesheet
link, for a file that only queues two `dataLayer` entries and appends an already-async
loader. It is `defer` now — and `defer` rather than `async` on purpose, because the tag
is first in the document and defer preserves order, so `window.gtag` is guaranteed to
exist before any other deferred or module script runs. That is the contract a future
conversion snippet will depend on.

`test/frontend/head-scripts.test.js` walks every page under `public/` and fails the
deploy on an unexplained blocking tag; adding one means adding it to that file's
allowlist with its reason.

### Two upload formats are converted in the browser, not on the server

The upload pipeline can only handle formats a browser can decode and the vision models
accept. Two common ones miss, and both are fixed client-side rather than by adding a
server dependency:

| Module | Handles | Vendored library |
|--------|---------|------------------|
| `scripts/heic-convert.js` | iPhone HEIC/HEIF → JPEG. Most browsers cannot decode HEIC, and the flows need a decodable image for the instant preview and the `<canvas>` paint. | `scripts/vendor/heic2any.min.js` (~1.3 MB) |
| `scripts/pdf-page-to-image.js` | Floor-plan PDF → PNG of **page 1**. The server has never been able to read a PDF: `lib/chat/chat-upload-prep.js` accepts `application/pdf` and reduces it to the placeholder `[File: … Content cannot be directly read]`, so it never becomes an image and can never be rendered — while the product copy promised exactly that. | `scripts/vendor/pdf.min.js` (~370 KB) + `scripts/vendor/pdf.worker.min.js` (~1.1 MB) |

They share one shape, and it is worth copying for a third:

- **Self-hosted, never a CDN.** `script-src` is a real allowlist with no third-party JS
  host on it, so a CDN import is dead on arrival. The bundles live in
  `public/scripts/vendor/` (unlinted by design — see the note in `eslint.config.js`).
- **Lazy.** The vendor bundle is only fetched the first time a user actually picks a file
  of that type, so ordinary JPEG/PNG uploads pay nothing for either. The module itself is
  a few KB and is the only thing on the page at load.
- **Pure helpers exported at module scope, the browser wiring in an IIFE below.** That is
  what makes the decisions unit-testable under `node --test` (`isPdf`/`sniffPdf`/
  `scaleForPage`, `isHeic`/`sniff`) while the DOM half is exercised in a real browser.
  Both files therefore sit around 40–50% line coverage on purpose; the uncovered block is
  the IIFE, which node cannot execute at all.
- **Content beats extension.** Both sniff the leading bytes and pass a mislabelled file
  through untouched, because a real PNG named `.pdf` handed to the PDF renderer just
  throws.
- **`window.*` bridge + `globals.d.ts`.** `window.StagifyPdf` / `window.StagifyHeic` are
  cross-file names, so each needs an entry in `public/scripts/globals.d.ts` or the
  frontend typecheck fails.

One CSP trap worth knowing: pdf.js spawns its parser in a **Web Worker** loaded from
`scripts/vendor/pdf.worker.min.js`. That is covered by `worker-src 'self'` in
`lib/http/app-middleware.js`. Tightening that directive would make floor-plan PDFs
*hang* rather than error, because a blocked worker is not a failed fetch.

And one testing trap: pdf.js's `page.render()` drives itself with
`requestAnimationFrame`, which **never fires in a backgrounded tab**. A browser-automation
check that opens the page in a hidden tab will sit in `render()` forever and look like a
deadlock in our code. Foreground the tab, or pass `intent: 'print'` to make pdf.js skip
its rAF scheduling for the check only.

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
  `admin.css`, `getpro.css`, `reset-password.css`, `index.css`, `not-found.css` (the 404
  page — full chrome, so it loads `styles.css` and its colours must be tokenized). Legal pages share
  `legal.css` (privacy + terms) and `enterprise-msa.css`. A page file may declare its own
  local custom properties where its palette/scale genuinely differs from the site's —
  `admin.css` does, on `.page-admin`, for the dashboard's denser data UI.
- **Shared feature CSS — opt-in per page.** Small files a page links only if it uses the
  feature: `auth.css` (nav + auth-modal UI, on ~10 pages), `carousel.css`,
  `star-border.css`, `home-text-animate.css`, `demo-player.css`, `toast.css` (required by
  any page importing `scripts/toast.js`). A page pulls in only the feature CSS it actually
  renders, so no page carries the whole site's styles.

A given page therefore links `styles.css` + (usually) `auth.css` + its own `<page>.css`
+ any feature files it needs. Overlap between base and page files is deliberate and tiny
(a page-level `html`/`body`/scrollbar override for a full-bleed studio, a repeated
`.hidden` utility) — not copied rule sets.

### Design tokens — and the one rule about where they work

The palette lives in `styles.css`'s `:root`. Use `var(--token)` for colour; do not write
a hex literal that already has a token.

**A token only works on a page that loads the sheet defining it.** This is the whole
reason the rule needs stating: `color: var(--brand)` where `--brand` is undefined does
not fall back — the **entire declaration is dropped**, silently, on that page only. Four
sheets are served to pages that do *not* load `styles.css` and therefore keep literals on
purpose:

| Sheet | Served to |
|---|---|
| `legal.css` | `privacy.html`, `terms.html` |
| `enterprise-msa.css` | `legal/enterprise-msa.html` |
| `getpro.css` | `getpro.html` |
| `blog.css` | the blog (it carries its own `:root`) |

`demo-player.css` is excluded for a different reason: it is a **byte-identical copy of
`to-build/demos/demo-player.css`**, so edits belong in the master and the next export
overwrites the served file.

A page file may still define local custom properties where its palette genuinely differs
(`admin.css` does, on `.page-admin`). What it should not do is re-spell a shared value:
`--adm-accent: var(--brand)` rather than `--adm-accent: #2563eb`.

**The palette is descriptive.** It was rewritten from a survey of what the sheets already
painted with, not chosen top-down. A review had flagged that the big sheets "ignore the
tokens" — the real cause was that the tokens described a palette the app did not use:
`#2563eb` appeared **183 times across 16 files with no token at all**, while
`--primary` (`#1e40af`) appeared 22. `admin.css` had independently named the same two
blues privately, which is why it alone looked tokenized. Adding `--brand*`, `--slate*`,
`--muted-light` and `--danger` is what made the substitution possible; `--primary` was
deliberately **not** redefined to `#2563eb`, since 22 existing `var(--primary)` uses
would have changed colour.

[`test/frontend/css-tokens.test.js`](../../test/frontend/css-tokens.test.js) enforces all
of it: no hard-coded colour that has a token (in sheets where the palette is in scope),
every `var()` resolving on every page that serves it, and the `demo-player.css` copy
staying byte-identical. Custom properties set from JS (`el.style.setProperty('--ar', …)`)
and `var(--x, fallback)` uses are exempt — neither can cause the silent drop.

**Deliberately not enforced:** duplicate top-level selectors and `!important`. Both were
in the same review finding, and both are usually legitimate here — `a,b { shared } b {
specialize }` reads as a "duplicate" to any scanner, and `styles.css`'s machine-merged
shape means one element's rules are grouped by value rather than by element. A test would
report the cascade working as designed. The cost is readability, not correctness, and
un-merging a 3,200-line sheet with no visual-regression coverage is not worth it.

**Non-render-blocking (lazy) CSS.** Pages split their stylesheets by criticality. On
`index.html`, `styles.css` / `carousel.css` / `home.css` load normally (render-blocking);
the below-the-fold ones (`auth.css`, `star-border.css`, `home-text-animate.css`,
`demo-player.css`) ship as `media="print"` with a `data-lazy-css` attribute so they
**don't block first paint**, and [`scripts/lazy-css.js`](../../public/scripts/lazy-css.js)
promotes each to `media="all"` once fetched. A `<noscript>` block links them the normal
way for the no-JS path. The promotion is an external script rather than an inline
`onload=` handler on purpose — it keeps the page under the CSP's `script-src-attr 'none'`
(no `unsafe-inline`).

The helper is page-agnostic (it was called `index-lazy-css.js` back when the homepage was
its only caller), so adopting the pattern elsewhere needs no JS change: mark the `<link>`
`media="print" data-lazy-css`, include the script after it, and **copy the `<noscript>`
fallback across as well** — the flip is the only thing that ever loads those sheets, so
without it a no-JS visitor gets none of them.

### Paid pages RESHAPE, they do not redirect

Every Stagify+ page used to load a render-blocking `*-gate.js` that `location.replace`d
anyone without a token, plus a one-line inline
`<style>html.<x>-gate-pending body{visibility:hidden!important}</style>` that hid the whole
document until the plan check answered. It worked as an affordance and was a terrible front
door: **Googlebot carries no token either**, so those pages bounced the crawler despite a
full canonical / hreflang / JSON-LD setup — the SEO work earned nothing — and a curious
visitor who clicked the tool in the nav was answered with a pricing table rather than with
what the tool does.

Four pages now show one of three views on a **single URL** instead:

| | anonymous | signed-in free | Stagify+ |
|---|---|---|---|
| `exterior-studio.html` | pitch + CTA | *the same page* | the studio |
| `masking-studio.html` | pitch + CTA | *the same page* | the studio |
| `ai-designer.html` | pitch + CTA | *the same page* | the studio |
| `basic-mask.html` | pitch + CTA | *the same page* | an "Open Basic Mask" button |

Free deliberately gets the **same page** as anonymous. Both studios used to raise a
full-screen, undismissable "this is a Stagify+ feature" dialog instead, which fired the
moment somebody created an account — so for a new account it was the first thing the
product ever said — and it covered the very copy meant to do the selling. Do not re-add
one; the hero's "Get Stagify+ to use it" button is the whole ask.

Three pieces, and each page names its own ids:

- [`preview-access.js`](../../public/scripts/preview-access.js) — the pure predicate
  (`previewView`), one idempotent writer (`applyPreviewView`), the factory that binds them
  to a page (`createPreviewAccess`), and `settlePreview`, which is the paint-wait-paint
  dance every entry point does around `/api/auth/me`.
- [`preview-gate.js`](../../public/scripts/preview-gate.js) — one render-blocking classic
  script, mounted as `<script src="scripts/preview-gate.js"
  data-pending-class="ms-pro-pending">`. It reads the plan `auth.js` cached last visit and
  pre-applies the Pro shape before first paint, so a subscriber never watches the pitch
  paint and vanish a round trip later. It **never navigates**.
- a per-page `<x>/access.js` (four lines) binding the ids, imported by `auth.js` so
  `applyUserToUI()` re-runs it on every auth change — signing OUT has to put the pitch back.

`ai-designer.html` is the exception that still redirects, and only on **viewport**: the
studio is a desktop layout, so `ai-designer-gate.js` sends ≤768px to the home page before
anything else runs. It therefore cannot mount the shared gate (which never navigates) and
carries that file's body inline after its width check. The known cost is that a phone never
reaches its pitch, so that preview earns nothing from mobile search; revisit together with
the desktop-only decision, not on its own.

The pre-paint class must switch **`display`, never `visibility`** — `styles.css`'s i18n
anti-FOUC rule (`body.language-loaded [data-lang] { visibility: visible }`, specificity
(0,2,1)) matches every translatable element and would silently un-hide it again — and each
selector needs an **id**, or it ties with `[hidden]` and loses on source order.

None of it is a security boundary. `requireProAccount` on each render route is; revealing
controls is an affordance, and nothing may authorize on the cached plan. Three guards hold
the arrangement together:
[`preview-access.test.js`](../../test/frontend/preview-access.test.js) sweeps all four
bindings against the shipped markup,
[`preview-gate.test.js`](../../test/frontend/preview-gate.test.js) runs the gate's real
source and asserts it never touches `location`, and the `data-staging-preview` guard in
[`test/frontend/staging-menu.test.js`](../../test/frontend/staging-menu.test.js) *runs* each
preview page's head gate as a signed-out desktop visitor and fails if it navigates. That
last one is behavioural rather than a source scan precisely because of the AI Designer: a
grep for `location.replace` cannot tell a viewport redirect from an auth redirect.

### `var` is an extraction artifact — sweep it, don't pick at it

Much of `public/scripts/` still declares with `var`, left over from when these were classic
`<script>` files (see the unminify/ESM-conversion history): **491 across 34 files** as of
2026-07-28, down from 587/37. `admin/renderers.js` has 88, `status.js` 45,
`demo-player.js` 38. New code uses `const`/`let`.

The 96 that went were `profile-menu.js` (21) and `profile-menu/auth-modal.js` (75) — **not**
a counter-example to the sweep rule below. `auth-modal.js` was being rewritten anyway (the
element-handle cache, and the sign-in hand-off bug in the next section), and new code is
`const`/`let` by the same rule; `profile-menu.js` followed so the island isn't half-and-half
with its own submodule. `profile-menu/google-signin.js` still has its `var`s and is left for
the sweep. That is the shape of a legitimate exception: the file was open for a behavioural
reason, and it came with the [first tests][pm-tests] this surface has ever had.

[pm-tests]: ../../test/frontend/profile-menu/auth-modal.test.js

`eslint.config.js` sets `ecmaVersion: 2022` but enables **neither `no-var` nor
`prefer-const`**, so `var` is currently legal rather than debt — worth knowing before
filing it as a violation.

**Convert them in one sweep, or not at all.** Modernizing a file or two on the way past
trades "consistently old" for "randomly mixed", which is harder to read than either and
makes the next reviewer file the same finding against whatever is left. The whole thing is
one command plus four judgement calls:

```bash
npx eslint public/scripts --rule '{"no-var":"error","prefer-const":"error"}' --fix
```

That reports 589 problems and fixes **587 automatically** (585 `no-var` + both
`prefer-const`). ESLint deliberately declines exactly **two**, and they are the only ones
needing a human: `admin/helpers.js:43` (`export var ICONS` — an exported binding, so check
no importer reassigns it before making it `const`) and
`profile-menu/auth-modal.js:362`. Afterwards, add both rules to `eslint.config.js` so it cannot drift
back, and verify with `npm run typecheck` — `checkJs` turns the two dangerous conversion
mistakes (a `let` referenced outside the block it was declared in, and a redeclaration in
one scope) into hard errors, which is what makes an otherwise-untested sweep safe.

**Timing matters more than usual**: it rewrites 37 files at once, so run it when nobody
else has work open under `public/scripts/`.

### The auth modal's element handles

`auth-modal.js` used to re-query ~20 `getElementById`s per mode toggle. They are now
resolved once by `els()`, which caches **keyed on the modal root**: one lookup per access
confirms the cached handles still belong to the `#auth-modal` currently in the document, so
if anything ever replaces the modal the handles rebuild instead of writing into a detached
tree. A plain module-scope cache would have been fine today — nothing removes the node —
but it would have been fine *by accident*, and this costs one lookup to not depend on that.

Worth being straight about the payoff: those were O(1) id-map lookups on a human click, so
**this bought readability, not speed**. The reason to do it was that the alternative —
twenty `document.getElementById` calls interleaved with the logic — is what hid the
`stageModal` assignment that relied on `var` hoisting reaching it from an earlier branch,
and the dead `__stagifyPendingStaging` check described below.

### The sign-in → staging hand-off

`openAuthModal(true)` sets `window.__stagifyPendingStaging` so a visitor who clicked
"Stage" while signed out gets the staging dialog back after authenticating. **The flag must
be read before `closeAuthModal()`, which clears it.** All three success paths — password
login, email verification, and Google sign-in — read it *after* the close until 2026-07-28,
so the hand-off was dead: the modal shut and nothing opened, with no error. The sibling
`__stagifyPendingPlusRedirect` was already captured up-front for exactly this reason, which
is what makes the omission easy to miss on a read-through.

If you add a fourth way to complete sign-in, route it through `completeSignIn()` in
`auth-modal.js` rather than repeating the sequence; it captures both flags in the right
order. Covered by `test/frontend/profile-menu/auth-modal.test.js` at the unit level and by
`e2e/stage-signin-entry.spec.js` in a real browser — the latter drives the whole path the
visitor takes (upload button → auth modal → sign in → stage dialog → a staged request),
which is what the unit shim cannot: the flag has to survive two modules and reach the real
`#stage-modal` on the page.

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
  attributes — server-side per-language URL and client-side for dynamic nodes (see
  [`i18n.md`](i18n.md)); a template/vDOM layer would have to reconcile with that scanner
  across 11 languages — a large, cross-cutting mechanical cost.
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
