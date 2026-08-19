# to-build/ — source masters for served assets (KEEP)

**Do not delete this directory as "unused." It is intentional.**

This holds the **lossless PNG / source masters** that the web-optimized assets
in `public/` are exported from:

| Source here | Ships as |
|---|---|
| `to-build/media-png/**` | `public/media-webp/**` (lossy WebP) |
| `to-build/media-png/logo/**` | the favicons + logo images in `public/` |
| `to-build/Iridescent background/` | source for the animated background effect |

### The exception: WebP-derived copies

For a few sets the arrow above runs **backwards** — the WebP is the original encode and the
PNG beside it is a pixel-identical copy, made so the image is editable at all. These are
model output that was written straight to WebP; no lossless origin was ever saved, so the PNG
buys re-cropping and re-exporting, **not** fidelity. Do not sharpen or upscale one expecting
detail to come back.

| Set | Where the pixels actually came from |
|---|---|
| `media-png/Homepage/Restage/r01–r100.png` | the pool generators → `webp({quality:74})`. (`empty.png` is a *real* master — see that folder's README.) |
| `media-png/Homepage/Gallery/room-*.png` | Fal.ai `flux/dev`, WebP-first |
| `media-png/blog/exterior-{before,after}.png` | same |
| `media-png/background-poster.png` | a frame of `public/background.mp4` — if it ever changes, re-extract from the video rather than editing this PNG |
| `media-png/instagram/*.png` | Instagram's CDN, via the legacy `/p/<shortcode>/media/?size=l` redirect. The posts were published before any master was kept; see that folder's README for the refetch command |

`media-webp/demos/**` has no PNG at all, also by design: its masters are the `.webp` under
`to-build/demos/assets/`. See `to-build/demos/README.md`.

### Why it looks unused (and isn't)
The running Express server never imports or serves these files, so a
text/grep search for references finds **zero** — that is expected. They are
**build *inputs*, not runtime assets.** The WebP files in `public/` are lossy,
web-optimized exports; you cannot cleanly reverse them back to an editable
master. Keeping the PNGs here is what lets the images be re-cropped, recolored,
or re-exported at a different quality later.

If deploy/clone weight ever becomes a concern, move these to Git LFS or a
separate `stagify-assets` repo — do **not** simply delete them.

### The logo marks export at quality 90, not 78

`media-png/logo/*.png` are the product marks — the badge beside a plan name (`Pro64x64` on
the Stagify+ card, `Enterprise64x64` on the enterprise hero, `Api64x64` for the developer
API) and the favicons. They ship as `public/media-webp/logo/<same name>.webp`:

```
sharp(src).webp({ quality: 90 }).toFile(out)
```

**90, deliberately.** The two build scripts below use 78, which is right for a 1600px
photo and wrong here: these are painted at 18–64 px, where lossy ringing around the mark's
edge is visible at a glance. 90 lands each file within a few percent of its siblings
(`Enterprise32x32` is 1026 B, `Api32x32` is 1018 B), and lossless is roughly 60% larger for
no visible gain. Keep the alpha — the marks sit on coloured cards.

`*-full.png` is the full-resolution artwork the sized marks are cut from, and is **not**
served; there is no `-full.webp` and there should not be one.

`test/frontend/logo-marks.test.js` fails the build if a sized master has no WebP beside it,
if a served mark has no master to re-export from, or if a file's pixels disagree with the
size in its name. That guard exists because a master added without its export is otherwise
invisible — nothing references `to-build/`, so a grep finds nothing either way, and the gap
only shows up as a broken image the day someone wires the mark into a page.

### Masters with a scripted export

Most of these are exported by hand. One set has a build script, so re-run it rather
than exporting by eye:

| Master | Script | Produces |
|---|---|---|
| `media-png/blog/cover-N.png` | `node scripts/build-blog-thumbs.js` | `public/media-webp/blog/cover-N-thumb.webp` (800×450) |

The blog covers ship at **two** sizes. `cover-N.webp` (1600×900) is the article hero and
is exported by hand as usual; `cover-N-thumb.webp` is the card thumbnail used by the
`/blog/` grid and the homepage's "from the blog" strip, where the image is painted about
400 px wide. Serving the hero into those cards cost ~1.2 MB across the ten articles.

After replacing a cover master, re-export the hero **and** re-run the script. Because
`media-webp/` is served `immutable` for a year, a regenerated thumb under the same
filename will not reach returning visitors — rename it or add a `?v=`, exactly as
`docs/reference/caching.md` requires for every other image here.
