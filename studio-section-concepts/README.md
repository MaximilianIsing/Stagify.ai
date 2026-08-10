# `#staging-studio` — section rework (prototype)

Design exploration for the home page section currently titled **"Drag to see what staging
does"** (`public/index.html:474-516`).

**Nothing here is wired into the app.** This folder sits outside `public/`, so the Express
static mount never serves it and no runtime code imports it. It matches no `files` block in
`eslint.config.js` and no `test/**/*.test.js` glob, so `npm run lint` and `npm test` don't
see it. It is **not** a build input (unlike `to-build/`) — but the pool images and the two
tools under `tools/` are the source of the eventual production assets, so don't bin it until
those have been moved into `public/media-webp/`.

## The pages

| File | What it is |
|---|---|
| **`deck.html`** | **The chosen direction.** One empty room + a "Stage it again" button. |
| `before-picker.html` | Step 1: six candidate "before" photos, with the reasoning. Candidate 1 won. |
| `pool-review.html` | Contact sheet of all 60 staged variations. Click a tile to mark it CUT. |
| `index.html` | The earlier 7-concept exploration that led here. Kept for the reasoning. |

Open any of them by double-clicking. They run over `file://` — no server, no build — which
is why the scripts are **classic scripts, not ES modules** (`type="module"` is CORS-blocked
on `file://`). Browser-automation tools generally refuse `file://`; if you need one, serve
the **repo root** (not this folder) on a spare port so the `../public/...` paths still
resolve, then open `/studio-section-concepts/deck.html`.

## Why the section is being replaced

1. **The page already shows the drag-wipe twice.** `#exterior-studio-demo` in the showcase
   carousel (`public/index.html:912-970`) is the same `.ba` widget, mounted by the same
   `mountWipe()` in `public/scripts/staging-studio.js`, in the same aside scaffolding.
2. **Its three bullets restate the rest of the page.** "~8 seconds" appears 8 times on the
   home page; "re-stage as often as you like" 3 times.
3. **It sells the wrong thing.** Before→after is what every competitor shows. The thing
   Stagify actually does that traditional staging cannot is *let you run it again*.

## The chosen direction — `deck.html`

One empty room. A button. First press says **"Stage this room"**; every press after says
**"Stage it again"**, and deals a different staged version of the same photo from a pool
of 60.

### Decisions baked in

- **A shuffled bag, not `Math.random()` per press.** Uniform random repeats fast — with 60
  items there's roughly a 40% chance of a duplicate inside the first eight presses, and one
  duplicate reads as "broken", not "unlucky". The pool is shuffled once and walked in order;
  on exhaustion it reshuffles, and the reshuffle is prevented from dealing the card already
  on screen. **Verified: 70 consecutive presses, the first 60 all unique, zero adjacent
  repeats, no repeat across the reshuffle boundary.**
- **Nothing is prefetched.** The section loads the empty room and stops. Each press fetches
  exactly one image (~45 KB) and only swaps once it has decoded. A visitor who never presses
  pays nothing for the pool existing — which is why 60 costs no more at load than 6 would.
- **The DOM is bounded, not timer-trimmed.** The outgoing card is removed when the next one
  arrives, not on its own 620ms exit timer. Presses outrun that timer trivially once images
  are warm; the timer-only version left **70 cards in the DOM after 70 presses**. It now
  caps at two.
- **The stack is sized 1216×832 — the source photo's own ratio**, not a rounded 3/2. The
  empty base and every staged card are the same photograph, so a 2% ratio mismatch makes the
  furniture appear to shift when a card lands.
- **The working state is a sheen, not a spinner.** The wait is one image fetch. A spinner
  would imply the render is happening live, which would be a lie — the pool is pre-generated.
- **No style caption on the card.** See the honesty note below.
- **The copy never says "shuffle".** The product has no re-roll button; you re-run, and
  because nothing pins a seed on the main staging path the result genuinely differs.
  "Stage it again" is what the product actually does.

## The assets

**Before photo** — `assets/before/1-living-oak.jpg`, 1216×832, generated with Fal.ai
`flux/dev`. Chosen over five alternatives because it is the most *stylistically
uncommitted* room: plain white walls, warm oak, no period detail, a big blank focal wall,
generous clear floor, and — critically — no hard shadow pattern where furniture goes. The
rejected candidates and the reasoning are in `before-picker.html`. It reads as either a
living room or a bedroom, so it doesn't lock the copy to one room type.

**The 60 staged variations** — `assets/pool/*.webp`, ~45 KB each, 2.9 MB total, plus
`manifest.json` recording the axes behind each one.

**They are real Stagify output.** `tools/gen-pool.mjs` drives the repo's own
`createStagingGeneration().processStaging()` against that exact photo, using the prompts in
`lib/staging/promptMatrix.js`. The only thing bypassed is `virtual-staging-handler.js` —
whose 3-variation cap, auth, rate limits, DB writes and R2 uploads are all irrelevant here.
Model: `gemini-2.5-flash-image`, i.e. the **free-tier default**, so this is what a normal
visitor's own render would look like, not Stagify+ quality.

Variation comes from six axes (palette, layout, material, rug, lighting, decor) crossed with
the 7 furniture styles, spread with coprime strides so no two entries share a combination —
verified zero duplicate axis combos across all 60.

### Regenerating or growing the pool

```
node studio-section-concepts/tools/gen-pool.mjs 0 60     # generate (skips existing files)
node studio-section-concepts/tools/regen.mjs 17,35,59    # redo specific indices
```

Both read `GOOGLE_AI_API_KEY` from `.env` (falling back to `key.txt`). To grow past 60,
raise `POOL_SIZE` and extend the axis arrays — the axes are what create the variety, and at
60 several are already reused across entries.

## Two honesty notes

**The style name is not a reliable label, so the card doesn't show one.** Each render is a
`promptMatrix` style *plus* a palette/layout/material directive, and `generatePrompt`
appends that directive after *"Prioritize the following above everything else:"* — so the
directive routinely overrides the style. In practice a render tagged `luxury` came back with
no luxury cues at all, and one tagged `coastal` came back forest green. The style stays in
`manifest.json` as provenance and off the screen as a caption.

**Roughly 8% of renders quietly deleted the architecture.** The failure was always the same:
the open doorway recess in the left wall got painted over as flat wall plus artwork. Five of
sixty (`p18`, `p36`, `p53`, `p54`, `p60`) did it. This is invisible unless you compare
against the source, so it is worth checking numerically rather than by eye — the doorway is
a fixed dark rectangle, so a render that walls it over gets much brighter there:

```
box x 215..300, y 250..540 (in 1216x832 coords)
source mean luminance 162 · healthy pool median 153 · the five failures were 181-205
```

`tools/regen.mjs` carries a hardened doorway clause that fixed all five; after regeneration
the worst render in the pool is +7.7 over source, i.e. normal furniture-shadow noise. **Any
newly generated batch should be re-checked the same way** — the clause reduces the failure
rate, it does not prove it to zero.

## If this ships — the real-repo checklist

1. **`staging-studio.js` mounts two roots.** `mountWipe()` also drives
   `#exterior-studio-demo`; only `mountExamples()` is `#staging-studio`-only. Dropping the
   wipe from this section means retiring `mountExamples()` and **keeping `mountWipe()`** for
   the showcase panel.
2. **The section must be readable before its script arrives.** `index-deferred.js` injects
   everything after `load` + `requestIdleCallback`, so a module binding `DOMContentLoaded`
   silently never initialises (`index-deferred.js:16-24`). Server-render the empty room and
   the button in the HTML; let JS only wire the press. A script failure must degrade to "an
   empty room and a dead button", never to a blank box.
3. **Register the new script in `public/scripts/index-deferred.js`** near `home-reveal.js`;
   `test/frontend/index-deferred.test.js` asserts against that real array.
4. **New script is ESM under `public/scripts/`**, JSDoc-typed (checkJs gates the deploy),
   under the 650-line cap, with a spec under `test/frontend/`. The bag logic is pure and
   easy to test — assert the whole-pool-before-repeat property directly rather than through
   the DOM. Note `staging-studio.js` currently sits in the allowed-untested list
   (`test/frontend/untested-frontend-modules.test.js:90`); a replacement should not inherit
   that exemption.
5. **i18n.** New visible strings: the eyebrow, title, subtitle, aside kicker/title/body, the
   two button labels and the counter line. `home.studio.eyebrow` ("Before & after") already
   exists and is translated in all 11 packs but is rendered nowhere — use it free. Everything
   else is 11 pack edits each, because `test/server/static.test.js` enforces cross-pack key
   parity. **The counter line interpolates a number**, so keep it a whole sentence per pack
   rather than concatenating fragments.
6. **Assets move to `public/media-webp/Homepage/Restage/`** with PNG masters under
   `to-build/media-png/`, per the convention in the root `CLAUDE.md`. The manifest becomes
   either a small JS constant or a generated file — do not ship a `fetch()` for it on the
   critical path.
7. **Keep the `data-tx` hook** on the `<h2>` (`home-text-animate.js`).
8. **Don't pair `backdrop-filter` with `overflow: hidden` on the same element** — Chrome
   stops painting descendant `<img>`s and every diagnostic still says the image is fine. The
   stack clips; the pills blur; they are deliberately different elements.

## Notes from actually running it

- **A backgrounded tab clamps `setTimeout` to ~1s and freezes CSS transitions**, so a
  press-loop driven over CDP runs ~20× slower than reality and `getComputedStyle` returns
  transition values frozen mid-flight. Use `MessageChannel` as the wait primitive when
  scripting the button, and don't read a mid-transition opacity as a bug.
- **A tool call that times out does not stop the page.** An aborted 18-press loop kept
  running and interleaved with the next one, double-recording into a shared array and
  producing a fake "2 duplicates in the first 60". Reload between scripted runs.
