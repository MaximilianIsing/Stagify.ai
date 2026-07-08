# demos/ — authoring master + preview for the guide walkthroughs (KEEP)

**Do not delete this directory as "unused." It is intentional.**

This is the **source/authoring workspace** for the interactive product
walkthroughs shown on the Guides page. It is a self-contained bundle exported
from Supademo, plus a standalone preview harness:

- `demos.json` / `demos.js` — the walkthrough data (`window.SUPADEMO_DEMOS`).
- `demo-player.js` / `demo-player.css` — the player used by the preview.
- `index.html` — a standalone preview that runs the player from `file://`
  (open it directly in a browser; no server needed).
- `assets/**` — the WebP step screenshots for each walkthrough.

### What it exports to (the served copies live in `public/`)

| Source here | Ships as (served) |
|---|---|
| `demos.json` (`SUPADEMO_DEMOS`) | `public/scripts/demo-data.js` (`STAGIFY_DEMOS`) |
| `demo-player.js` | `public/scripts/demo-player.js` (byte-identical copy) |
| `demo-player.css` | `public/styles/demo-player.css` (byte-identical copy) |
| `assets/**` (`assets/free/step-01.webp`) | `public/media-webp/demos/**` (`media-webp/demos/free/step-01.webp`) |

### Why it looks unused (and isn't)
The Express server never imports or serves this folder — only `public/` is
served — so a grep for references finds **zero**. That is expected. These are
**build inputs**, not runtime assets.

### Canonical vs. copy
The **served** file is `public/scripts/demo-player.js`; the copy here is the
authoring/preview master. They are kept in sync by hand: **if you edit the
player or the walkthrough data here, re-export the matching `public/` files**
(copy `demo-player.{js,css}` across, regenerate `demo-data.js` from
`demos.json`, and export any new `assets/**` frames to
`public/media-webp/demos/**`). If you'd rather have drift caught automatically,
a byte-identity test under `test/` can assert the two player copies match.
