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
