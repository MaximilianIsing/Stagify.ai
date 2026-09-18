# covers/ — how the localized blog covers are generated (KEEP)

**Do not delete this directory as "unused."** Nothing imports it at runtime, by design: it
is the **recipe** for `public/media-webp/blog/cover-N.<lang>.*`, which are generated and
must not be hand-edited.

```sh
node scripts/build-blog-covers.js                      # every cover, every language
node scripts/build-blog-covers.js --cover=cover-10 --lang=es   # one, while iterating
```

## What this solves

Six of the fifteen blog covers have English words burned into the picture. Served unchanged
under `/es/blog/…` they put English type on the most widely-seen asset the article has — the
`og:image` a reader meets in a Slack unfurl or a search result *before* the page itself. The
script repaints those regions and redraws the type per language.

**The English covers are never touched.** Only `cover-N.<lang>.webp` and its `-og.jpg` /
`-thumb.webp` derivatives are written. `lib/i18n/blog-covers.js` swaps the URLs at render
time; a cover with no variant for a language keeps its English image.

## The two covers that stay English, and why

- **cover-11** (`fsbo-listing-photos`) — "FOR SALE BY OWNER" is lettering on a yard sign
  inside the photograph, not an overlay. There is no layer to replace; changing it means
  regenerating the photo.
- **cover-14** (`home-staging-cost`) — a step chart whose annotations sit *on* the plotted
  fill. The "+$900 every month it sits" label overlaps the point where the fill begins, so a
  plate over it would erase part of the chart. Doing this one properly means redrawing the
  whole chart — the steps, the fill, the axis and the ticks — rather than patching it, which
  is a bigger job than the other six put together.

Seven more covers are pure photography with no text, so there is nothing to localize.

## How a recipe works

`covers.json` describes each cover; `text/<lang>.json` holds its words. A cover is drawn in
four passes:

1. **plates** — rectangles that cover the burned-in English so it can be redrawn. Either a
   flat `fill`, or `rowFrom: <y>`, which copies one clean row of the original and stretches
   it down the plate. The second exists for cover-12's gradient band: no flat colour matches
   a gradient, and the band is vertically uniform, so one row *is* the whole band.
   Plates are deliberately as small as the text they replace — cover-7's straddle its slider
   rather than covering it, because the slider is artwork and repainting means redrawing.
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
