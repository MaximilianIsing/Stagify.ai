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
| `demos.json` (`SUPADEMO_DEMOS`) | `public/scripts/guides/demo-data.js` (`STAGIFY_DEMOS`) |
| `demo-player.js` | `public/scripts/guides/demo-player.js` (diverged: the served copy adds localized step-dot labels) |
| `demo-player.css` | `public/styles/demo-player.css` (byte-identical copy) |
| `assets/**` (`assets/free/step-01.webp`) | `public/media-webp/demos/**` (`media-webp/demos/free/step-01.webp`) |

### Why it looks unused (and isn't)
The Express server never imports or serves this folder — only `public/` is
served — so a grep for references finds **zero**. That is expected. These are
**build inputs**, not runtime assets.

### Canonical vs. copy
The **served** file is `public/scripts/guides/demo-player.js`; the copy here is the
authoring/preview master. **The served player is now ahead of this copy**: it adds
localized step-dot labels (`stepLabel()` and a `languagechange` listener). Port those
changes back here before copying `demo-player.js` across, or the export will regress
them. No test enforces the pair. `demo-player.css` is still byte-identical.

If you edit the walkthrough data here, re-export the matching `public/` files:
regenerate `demo-data.js` from `demos.json`, and export any new `assets/**` frames to
`public/media-webp/demos/**`.
