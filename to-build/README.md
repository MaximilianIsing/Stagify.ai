# to-build/ — source masters for served assets (KEEP)

**Do not delete this directory as "unused." It is intentional.**

This holds the **lossless PNG / source masters** that the web-optimized assets
in `public/` are exported from:

| Source here | Ships as |
|---|---|
| `to-build/media-png/**` | `public/media-webp/**` (lossy WebP) |
| `to-build/media-png/logo/**` | the favicons + logo images in `public/` |
| `to-build/Iridescent background/` | source for the animated background effect |

### Why it looks unused (and isn't)
The running Express server never imports or serves these files, so a
text/grep search for references finds **zero** — that is expected. They are
**build *inputs*, not runtime assets.** The WebP files in `public/` are lossy,
web-optimized exports; you cannot cleanly reverse them back to an editable
master. Keeping the PNGs here is what lets the images be re-cropped, recolored,
or re-exported at a different quality later.

If deploy/clone weight ever becomes a concern, move these to Git LFS or a
separate `stagify-assets` repo — do **not** simply delete them.
