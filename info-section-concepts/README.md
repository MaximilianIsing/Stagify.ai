# `#learn` section — layout concepts (prototype)

Throwaway design exploration for the homepage section titled
**"What virtual staging is, and why it sells"** (`public/index.html:529-603`).

**Nothing here is wired into the app.** This folder sits outside `public/`, so the
Express static mount never serves it and no runtime code imports it. It is safe to
delete once a direction is picked — unlike `to-build/`, this is not a build input.

## How to open it

Double-click `index.html`, or:

```
start info-section-concepts/index.html
```

It runs entirely over `file://` — no server, no build step. That is also why
`concepts.js` is a **classic script, not an ES module**: `<script type="module">`
is CORS-blocked on `file://`.

## What's in it

Fourteen ways to lay out the same four info rows, stacked on one page so they can be
compared directly. **7–10 are the strips family** — each keeps what makes strips work
(photos always on show, one panel widening, a fixed height that never reflows) and
fixes a different weakness.

| # | Concept | Shape |
|---|---------|-------|
| 0 | Today | The current four stacked rows — the baseline |
| 1 | Accordion + media pane | Four headings stacked left, photo cross-fades right |
| 2 | Segmented tabs | Pill control on top, one split panel below |
| 3 | Native `<details>` | Zero JS, same pattern as the FAQ section |
| 4 | Expanding grid | 2×2 cards; the open one promotes to a full-width row |
| 5 | Image strips | Four vertical photo panels; the active one widens |
| 6 | Snap rail | Horizontal peek carousel with dots |
| 7 | **Horizontal bands** | Strips rotated 90° — nothing rotates, every title reads normally |
| 8 | **Strips + glass card** | Copy on an opaque card, not straight onto the photo |
| 9 | **Strips, wide spines** | Collapsed strips wide enough for a horizontal label |
| 10 | **Strips, auto-cycling** | 5s auto-advance with a progress bar and pause rules |
| 11 | Hero + filmstrip | One 2:1 stage, copy card over the left, thumbnails below |
| 12 | Mosaic | One feature cell plus three switchable tiles beside it |
| 13 | Chips + drawer | Four heading cards across the top, detail drawer below |

7–10 all share **one markup path** — they differ only by a modifier class on the root
(`.strips--glass`, `.strips--wide`, `.strips--auto`), so the CSS carries the difference
rather than the JS. If you pick one, the others cost nothing to drop.

Each one carries a **live height badge** measuring its rendered section height against
concept 0, so the scroll saving is measured rather than guessed. Open a panel and watch
the number move.

## Two deliberate choices

**The copy is real, not lorem.** Every concept renders from one shared `COPY` array in
`concepts.js` holding the actual strings from `public/index.html`. Two reasons: the real
sentence lengths are what decide whether a layout works, and identical copy across all
seven is what makes the height badges a fair comparison. Only the **photos** are
placeholders (`assets/photo-*.svg`).

**The photos are 4:3 gradient SVGs**, matching the aspect ratio the real
`.info-row__media img` uses, so the geometry is honest even though the pictures aren't.

## Things the prototype already demonstrates

- **`grid-template-rows: 0fr → 1fr`** for the expand animation (concepts 1 and 4)
  rather than a JS-measured pixel height. The panel then fits whatever the translated
  copy needs, with nothing to re-measure on a language switch — which matters across
  11 locales.
- **The bullet stagger is keyed off `.is-open`, not the scroll-reveal `.is-visible`.**
  In the live section (`home.css:1436-1453`) that stagger is driven by
  `home-reveal.js`'s IntersectionObserver. Collapse the panels and the class lands
  while the panel is still shut, so the animation is spent before you ever open it.
- **All four photos stay in the DOM and cross-fade** (concept 1) instead of swapping one
  `<img>`'s `src`, which would flash and refetch on every switch.

## If concept 1 is picked — the real-repo checklist

1. Keep every `data-lang` key exactly as it is. The accordion trigger is the existing
   `<h3>` wrapped in a `<button>`, so **no new visible strings** and no work across the
   11 packs. Label the widget with `aria-labelledby="learn-title"` rather than a new
   string, or `test/server/static.test.js`'s key-parity gate needs 11 pack edits.
2. `home-reveal.js:30` hardcodes `.info-row__media img` in `warmImages()`. Keep that
   class name or update that selector — otherwise image decode-warming silently stops.
3. Ship it progressively enhanced like `studio-showcase.js` does with `.shw--ready`:
   markup stays four open stacked rows until JS adds a ready class, so a script failure
   degrades to today's layout rather than to four collapsed stubs.
4. Keep the `<h3>` elements (button *inside* the heading) so the heading outline under
   `#learn`'s `<h2>` survives, and keep the `data-tx` text-animate hooks working.
5. New script goes in `public/scripts/` as ESM, registered in `index-deferred.js` near
   `home-reveal.js`, JSDoc-typed (checkJs gates the deploy), under the 650-line cap,
   with a spec under `test/frontend/`.

## Known rough edges (it's a prototype)

- Concept 4 uses `order: -1` to float the open card first, so visual order diverges from
  DOM order. Fine to look at, not fine to ship without rethinking keyboard order.
- Concept 5's collapsed titles use `writing-mode: vertical-rl`, which is not animatable,
  so the label snaps rather than tweening. Longer German strings overflow the spine.
- Concept 1's section height changes slightly between rows because the four bodies are
  different lengths. A `min-height` on the list column would pin it.
- Concept 9's collapsed spines are 172px wide, which fits the English titles. The longer
  language packs will wrap to three or four lines there — check German before committing.
- Concept 12's copy card covers a lot of the feature photo, and at phone width the stage
  has to go portrait to leave room for it. It is the weakest of the set on mobile.

## Bugs found by actually running it

Worth recording, because two of them are the kind that pass a code read:

- **`display: grid` beats `[hidden]`.** Concept 2's panels all rendered at once, so the
  tabs saved no space — it measured 1737px instead of 606px. Needs an explicit
  `.segt__panel[hidden] { display: none }`.
- **`entries[0]` is the OLDEST IntersectionObserver entry.** Concept 10's autoplay read
  entry 0 to decide whether it was on screen. A scroll that left and re-entered inside one
  callback latched it to "off screen" permanently and the carousel silently stopped for
  good. Read `entries[entries.length - 1]`.
- **Grid items default to `min-height: auto`.** Concept 12's side tiles hold in-flow
  `<img>`s, so their min-content height (720px) overrode the container's `height: 470px`
  and the mosaic overflowed. Needs `grid-template-rows: minmax(0, 1fr)` plus
  `min-height: 0` on the items.
