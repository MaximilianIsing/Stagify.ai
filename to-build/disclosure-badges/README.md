# disclosure-badges/ — how `lib/image/badges/` is regenerated (KEEP)

**Do not delete this directory as "unused." It is intentional.**

Like `to-build/fonts/`, this folder holds no binaries — it holds the **recipe**.
The files in `lib/image/badges/` are generated and must not be hand-edited.

## What is in `lib/image/badges/`

One alpha PNG per language (`english.png`, `japanese.png`, …) plus
`manifest.json`. Each PNG is the language's badge tag from
`STAGING_DISCLOSURE_BADGE` (`lib/staging/staging-disclosure.js`), rendered once
at 128px SemiBold with 2px tracking as **white text on transparency**, cropped
tight to its ink horizontally and to one shared height vertically.
`lib/image/stamp-disclosure.js` scales the master down and composites it onto
the finished render when the user ticks "Label as virtually staged".

That shared height is why every language's badge comes out the same optical
size: the scale factor the stamp applies is `fontPx / 128`, so a master that was
cropped to its own ink height would render a language with no descender larger
than one with. Within the shared height each language is centred **on its own
ink**, which is what puts the text in the middle of the pill rather than
floating at the top of it.

They live under `lib/`, not `public/`, because they are **server-side render
inputs** — nothing ever serves them to a browser.

## Why pre-rendered instead of drawing text at request time

sharp can draw text (`sharp({ text: … })`), and it was the obvious approach. It
was rejected because of how it fails:

- Text goes through pango + **fontconfig discovery**. When no font is found, the
  result is not an exception — it is a valid, **fully transparent** layer. A
  legal disclosure that silently renders to nothing is worse than not shipping
  the feature.
- The `fontfile` option that would bypass discovery is a **silent no-op** on
  this repo's win32 libvips build, which has no `FcConfigAppFontAddFile` symbol.
  A correct path, a nonexistent path and a nonsense family name all produce
  byte-identical output — so a Windows dev box cannot validate the font wiring
  at all. Only the Linux container could, at runtime, in front of a paying user.
- There is no Dockerfile; Render's stock Node image is not a surface we control,
  so "a usable font will be installed" is an assumption, not a guarantee.

Pre-rendering moves all of that to a build step a human is watching, and makes
the served pixels byte-identical on every platform.

## Why not Inter

Inter is the site's font and would be the natural choice, but **it has no CJK
glyphs** (`to-build/fonts/README.md` says so too, in the context of why zh/ja/ko
fall through to the system stack in CSS). Since the badge is localized, Inter
would render `chinese`, `japanese` and `korean` as tofu boxes.

## Fonts (downloaded, not committed)

Noto Sans covers Latin + Latin-ext + Cyrillic — eight of the eleven languages.
The CJK three each get their regional font, so shared Han codepoints are drawn
with the right regional glyph variants. All are **OFL-1.1**.

Default location `to-build/disclosure-badges/fonts/` (gitignored; override with
`BADGE_FONT_DIR`). ~40 MB total, which is why they are not in the repo:

```sh
mkdir -p to-build/disclosure-badges/fonts && cd $_
base=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -sSL -o NotoSans.ttf   "$base/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf"
curl -sSL -o NotoSansSC.ttf "$base/notosanssc/NotoSansSC%5Bwght%5D.ttf"
curl -sSL -o NotoSansJP.ttf "$base/notosansjp/NotoSansJP%5Bwght%5D.ttf"
curl -sSL -o NotoSansKR.ttf "$base/notosanskr/NotoSansKR%5Bwght%5D.ttf"
```

## Regenerating

```sh
node scripts/build-disclosure-badges.js
```

Run it **whenever a string in `STAGING_DISCLOSURE_BADGE` changes**, and commit
the regenerated PNGs and `manifest.json` alongside the string change.

`test/image/badge-manifest.test.js` hashes every string against the manifest and
fails the build if you forget — without it the code would say one thing and the
pixels would keep saying the old thing, which is the exact failure this feature
exists to prevent.

## Notes for whoever changes this next

- The generator crops to **rendered alpha bounds**, never `measureText`. The
  variable Noto builds report identical advance widths for weight 400 and 600
  even though the glyphs visibly bolden, so the metrics would size the pill too
  narrow and clip the last character.
- The badge strings are **tags, not sentences** ("Virtually staged", not "This
  image has been virtually staged"). The stamp sits on the thing it describes,
  so the subject only buys width, and width is the constraint — the pill has to
  read as a caption in the corner of a listing photo, not as a bar across it.
  `test/image/badge-manifest.test.js` caps their length for that reason.
- Transparent pixels are forced to RGB white before the PNG is written. Canvas
  leaves them at RGB 0, and downscaling that would bleed black into the glyph
  edges — a grey halo around white text on every stamped image.
- The text colour is baked into the master. Changing it means re-running the
  generator, not editing the stamp module.
