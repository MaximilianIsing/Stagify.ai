# previews/ — generated change previews (KEEP the folder, not the contents)

**This folder is scratch, and that is intentional.** Only this README is meant to be
committed, but the contents are **not** gitignored: `.gitignore` has no `previews/` rule, so a
`git add -A` with a preview on disk will stage it. Delete each preview once its change is
applied. Deleting any `<date>-<slug>/` subfolder is always safe.

Each subfolder is one proposed change to a real page, rendered inside a clone of that page so
it can be looked at before anything under `public/` is edited. They are produced by the
user-level `/preview` skill (`~/.claude/skills/preview/`), which is the back half of the
design loop: `/prototype` explores options from a blank slate into `prototypes/`, `/preview`
takes one settled decision and proves it in situ.

### What a subfolder holds

| File | What it is |
|---|---|
| `before.html` | The real page, cloned untouched. The control. |
| `after.html` | The same clone with the proposed section markup. |
| `after.css` | The proposed styles, loaded last so they win the cascade. |
| `compare.html` | Overlaid iframes plus a before/after toggle (space, or the arrow keys). |
| `NOTES.md` | The change order: target files, the CSS-to-stylesheet mapping, i18n keys, gates. |

`NOTES.md` is the load-bearing one. It is what the apply step reads to turn a preview into a
real edit, which is why these previews are notes-first rather than screenshots.

### How to open one

```sh
node ~/.claude/skills/preview/scripts/serve.mjs --open
# opens the newest preview in your browser automatically
```

Pass `--open /previews/<date>-<slug>/` for a specific one, or drop `--open` to just print the
URL. Leave the server running while you look; it walks the port forward if 4173 is taken.

**Not by double-clicking.** The clones keep the real page's `<script type="module">` tags and
modules are CORS-blocked over `file://`, so opening from disk kills the hero picker, the nav
dropdowns, the reveal animations and the language loader. The server also serves the repo
root rather than `public/`, which is what lets a clone two directories away resolve
`href="styles/home.css"`: a miss under `previews/<dir>/` is retried against `public/`. It
serves `previews/` and `public/` only, deliberately, so that rooting at the repo does not
expose `.env`, the `*.txt` secret files or `data/auth-store.db` over localhost.

With `npm run dev` also running, `/api/*` is proxied to it and the clone gets live data;
without it those calls answer 503 and the page still renders.

### Why it looks unused (and isn't)

Express only ever serves `public/` (`lib/http/app-middleware.js`), so nothing in the app
references this folder and a grep finds zero hits. That is expected. These are review
artifacts, not runtime assets, and they are served by their own throwaway server.

### Notes for whoever changes this next

A preview is stale the moment its change ships. The skill deletes the folder after applying;
if you find old ones lying around, they were abandoned, and they are safe to delete too.
