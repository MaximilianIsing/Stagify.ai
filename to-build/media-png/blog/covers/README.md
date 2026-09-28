# covers/ — how the localized blog covers are generated (KEEP)

**Do not delete this directory as "unused."** Nothing imports it at runtime, by design: it
is the **recipe** for `public/media-webp/blog/cover-N.<lang>.*`, which are generated and
must not be hand-edited.

```sh
node scripts/build-blog-covers.js                      # every cover, every language
node scripts/build-blog-covers.js --cover=cover-10 --lang=es   # one, while iterating
```

## What this solves

Nine of the seventeen blog covers have English words burned into the picture. Served unchanged
under `/es/blog/…` they put English type on the most widely-seen asset the article has — the
`og:image` a reader meets in a Slack unfurl or a search result *before* the page itself. The
script repaints those regions and redraws the type per language.

**The English covers are never touched.** Only `cover-N.<lang>.webp` and its `-og.jpg` /
`-thumb.webp` derivatives are written. `lib/i18n/blog-covers.js` swaps the URLs at render
time; a cover with no variant for a language keeps its English image.

## Every cover with words is localized

All eight. Two of them were written off at first as impossible, and both turned out not to
be — the note is kept because the reasoning was wrong in an instructive way:

- **cover-11** (`fsbo-listing-photos`) looks like lettering on a yard sign inside the
  photograph. It is not: the sign is a flat vector card composited on top — navy header
  band, white body, hairline rule, blue strapline — and it plates like any other overlay.
  The plates sit *inside* the board rather than over it, so its rounded corners and drop
  shadow survive untouched.
- **cover-14** (`home-staging-cost`) is a step chart, and the fear was that its annotations
  sit *on* the plotted fill and could not be covered without erasing chart. Measured rather
  than eyeballed, every label sits on one of exactly two flat fields — the canvas `#111827`
  or the fill `#1d293c` — and the plates fit between the gridline at y 475 and the step line
  at y 547 / y 503 without touching either. The axis numbers (30/60/90/120) are figures, not
  words, so they are simply left alone.

The lesson for the next cover: sample the pixels before concluding a region cannot be
repainted. "Text inside the artwork" and "text on a flat plate that happens to sit over
artwork" look identical at a glance and are completely different jobs.

Eight covers are pure photography with no text, so there is nothing to localize. cover-17 (`virtual-staging-before-and-after`) is one of them on purpose: its before/after split carries a wordless slider handle instead of labels, so the English image serves every language.

**cover-16** (`which-virtual-staging-style`) was authored for this pipeline rather than
retro-fitted to it: a white header bar and a dark footer band, with the three photographs
running edge to edge between them. Every plate is a whole bar, so none of them can touch a
photograph however long a translation runs. Its three labels are the app's own
`furnitureStyles.*` names, read out of `public/languages/<lang>.json` rather than written
here, because they name options the reader has to find in the picker.

## How a recipe works

`covers.json` describes each cover; `text/<lang>.json` holds its words. A cover is drawn in
four passes:

1. **plates** — rectangles that cover the burned-in English so it can be redrawn. Either a
   flat `fill`, or `rowFrom: <y>`, which copies one clean row of the original and stretches
   it down the plate.

   **Prefer `rowFrom`.** It was added for cover-12's gradient band — no flat colour matches a
   gradient, and the band is vertically uniform, so one row *is* the whole band — but it is
   the better default for a *flat* region too. The colours you measure come from the lossless
   PNG master; the base the script composites onto is the served **WebP**, which is lossy.
   Its `#1d293c` is actually `#1c293c` and its `#111827` is `#111727`. One step off is
   invisible in a swatch and plainly visible as a rectangle outline on a large flat dark
   field — which is exactly how cover-14's first render came out. `rowFrom` samples the base
   itself, so it matches whatever the encoder produced, region by region. Every plate on
   cover-11 and cover-14 uses it. Pick a row inside the plate's own field that is clean
   across the plate's full width.
   Plates are deliberately as small as the text they replace — cover-7's straddle its slider
   rather than covering it, because the slider is artwork and repainting means redrawing, and
   cover-11's stop short of the sign's rounded corners for the same reason.
2. **rules** — hairlines a plate wiped out.
3. **circles** — small solid marks, drawn as geometry rather than as a bullet *character*:
   the variable Noto builds have no U+25CF, and a missing glyph renders as a tofu box.
4. **items** — the type. Either a `key` (one block, wrapped and shrunk to fit its box) or
   `runs` (several styles on one baseline, scaled as a group).

`y` is a **baseline**, not a box top. `anchor: "bottom"` pins the *last* line instead of the
first, which is what keeps a headline sitting on the rule beneath it whether a language
needs one line or three. `noWrap` shrinks instead of wrapping — right for the label/value
rows of a card, where a wrapped row stops lining up with the row beside it and pushes the
last one out through the bottom.

### Measuring a new cover

The geometry in `covers.json` was read off the pixels, not guessed. Sample the image for
the flat region a plate must cover, then find the ink bands inside it — rows containing
dark (or, on a dark canvas, light) pixels — and their x-extents. A band's height gives the
type size: a run with no descender is a cap height (`size ≈ h / 0.714`); one with a
descender is cap + descender (`size ≈ h / 0.924`). Its bottom is the baseline.

## Fonts

Noto Sans (Latin + Cyrillic) plus Noto Sans SC/JP/KR, from
`to-build/disclosure-badges/fonts/` — the same files that directory already downloads for
the disclosure badges, under the same OFL-1.1 licence. They are **not committed**; see
`to-build/disclosure-badges/README.md` for the download commands, or set `BADGE_FONT_DIR`.

Two deliberate choices, both inherited from that README rather than rediscovered:

- **Not sharp's text API.** It goes through pango + fontconfig, and when no font is found it
  does not throw — it returns a fully transparent layer. A cover that silently renders its
  headline to nothing is worse than shipping English. `@napi-rs/canvas` registers a font
  *file* and fails loudly.
- **Not Inter.** Inter is the site's face but has no CJK glyphs, so a localized set cannot
  use it without rendering zh/ja/ko as tofu. The localized covers are therefore set in Noto
  while the English ones stay Inter. Nobody sees both, and the alternative is worse.

## After regenerating

`scripts/build-blog-covers.js` rewrites `lib/i18n/blog-covers-manifest.js`, which records
which variants exist. Commit it with the images — `test/i18n/blog-covers.test.js` fails if
the manifest and the files on disk disagree, which is what stops a half-rendered set from
shipping as a broken image in one language nobody checks.
