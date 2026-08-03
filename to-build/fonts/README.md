# fonts/ — how `public/fonts/` is regenerated (KEEP)

**Do not delete this directory as "unused." It is intentional.**

This folder holds no binaries — the fonts themselves live in `public/fonts/` and
are committed. What lives here is the **recipe**, because the files in
`public/fonts/` are not hand-made and must not be hand-edited.

## What is in `public/fonts/`

21 files: **Inter, 3 weights (400/600/700) × 7 unicode subsets** (`latin`,
`latin-ext`, `cyrillic`, `cyrillic-ext`, `greek`, `greek-ext`, `vietnamese`),
woff2 only. They come verbatim from the npm package
[`@fontsource/inter`](https://www.npmjs.com/package/@fontsource/inter).

## Why subsets and not one file

Until 2026-08-03 this was three fused `inter-all-*` builds (98–107 KB each,
every script in one file, no `unicode-range`) plus three `.woff` fallbacks. Two
of the woff2 files were preloaded in `public/index.html` at `as="font"`, which
Chrome fetches at **Highest** priority — *above the LCP image*. So every
visitor spent 205 KB of the critical path, at the highest priority on the page,
to render ASCII. On PageSpeed's mobile profile (~200 KB/s) that is ~1 s.

With `unicode-range`, the browser downloads only the subsets it actually paints:

| Locale | Fetches | Bytes |
|---|---|---|
| en/es/fr/it/pt/de/nl | `latin` | ~24 KB per weight |
| ru | `latin` + `cyrillic` | ~32 KB per weight |
| zh/ja/ko | `latin` only | Inter has **no CJK glyphs**; these already fall through to the system stack in `font-family` |

The `.woff` fallbacks were deleted outright (410 KB on disk). Every browser
that can run this site's `<script type="module">` supports woff2, so nothing
could ever fetch them.

## Regenerating

`@fontsource/inter` is deliberately **not** a dependency — this is a one-off
asset export, not a build step (see `docs/guides/architecture.md` on the
no-build-step decision). Install it transiently, copy, remove:

```sh
npm install @fontsource/inter --no-save    # --no-save keeps package.json/lock clean
# copy inter-{latin,latin-ext,cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-{400,600,700}-normal.woff2
#   from node_modules/@fontsource/inter/files/  ->  public/fonts/
rm -rf node_modules/@fontsource
```

## The one rule

The `unicode-range` values in the `@font-face` block at the top of
`public/styles/styles.css` are **copied verbatim** from
`node_modules/@fontsource/inter/{400,600,700}.css`. Do not retype or "tidy"
them. A single wrong range does not throw — it silently drops those characters
to the system font, which is exactly the kind of bug nobody notices for months.
If you change the subset set, re-derive the block from the package's own CSS
rather than editing by hand.
