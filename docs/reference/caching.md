# Static asset caching

How the static frontend in `public/` is cached, and how to safely enable
Render's edge (CDN) caching. There is **no build step and no filename hashing**
(files are served as `styles/auth.css`, not `styles/auth.abc123.css`), so
freshness relies entirely on the `Cache-Control` headers the server sets — not on
versioned URLs. Get those headers right and edge caching is safe to turn on.

## Cache-Control policy

The server serves `public/` through `express.static` and sets `Cache-Control`
per file type in the `setHeaders` callback of `applyBodyAndStatic()`
([`lib/http/app-middleware.js`](../../lib/http/app-middleware.js), wired from `server.js`):

| File types | `Cache-Control` | Effect |
|---|---|---|
| `.html` `.css` `.js` `.json` | `no-cache` | Stored, but **revalidated with the origin on every request** (a cheap `304 Not Modified` via ETag when unchanged). Returning visitors never get stale markup, styling, scripts, or translations after a deploy. |
| `.woff2` `.woff` `.ttf` `.otf` `.eot` | `public, max-age=31536000, immutable` | Cached hard for a year. |
| `.png` `.jpg` `.webp` `.gif` `.svg` `.ico` `.avif` | `public, max-age=31536000, immutable` | Cached hard for a year. |
| `.mp4` `.webm` `.mov` `.m4v` `.ogv` `.ogg` `.m4a` `.mp3` | `public, max-age=31536000, immutable` | Cached hard for a year (e.g. `background.mp4`). |

`no-cache` is not "don't cache" — it means "cache, but always revalidate before
use," which is why deploys can't serve stale code even without hashed filenames.

The **localized pages** (`/es`, `/fr/…`) aren't files — `routes/i18n.js` renders them
server-side and sets the same `Cache-Control: no-cache`, so they revalidate like the
static `.html` pages. The render itself is memoized in-process by
`lib/i18n/page-renderer.js` (cleared on each deploy's restart), so a translation change
goes live on redeploy.

The **404 page** is the other non-file HTML response, from `lib/http/not-found.js`. It
shares that same renderer and memo, and also sends `Cache-Control: no-cache` — deliberately
not `no-store`: the body is identical for every unknown URL in a given language, so
revalidation is enough and there is nothing sensitive in it. Its JSON counterpart (for
`/api/*` and non-HTML clients) sets no cache header at all, like every other `sendError()`
response.

Dynamic and sensitive responses opt out of caching entirely with `no-store`
(e.g. the auth config, the `/getpro` grant page, hosted-image listings), so they
are never stored at any layer.

## Render edge caching

Render's **Edge Caching** setting (Service → Settings → Edge Caching) honours the
`Cache-Control` headers above, so it layers cleanly on top of this policy.

- **Recommended: "Common static files."** Caches JS/CSS/images/fonts at the edge
  but leaves **HTML and JSON origin-served**. The big win is offloading the large
  `immutable` assets — `background.mp4`, the WebP images in `media-webp/`, and the
  fonts — to the CDN. The `no-cache` files stay fresh via revalidation.
- **"None"** (default): safe, but you get none of the offload benefit.
- **"All files (advanced)"** would also edge-cache HTML/JSON. Our headers would
  still keep them fresh (`no-cache`) or uncached (`no-store`), but it adds surface
  area around cookie'd/dynamic pages for little upside — prefer "Common static files."

## Cache-busting discipline

Because filenames are not content-hashed, the safety net is the header policy —
which means the update path differs by asset type:

- **`.html` / `.css` / `.js` / `.json`** — nothing to do. They are `no-cache`, so a
  new deploy is picked up on the next request (revalidated).
- **Images, fonts, video/audio** — these are `immutable` and can live in browser and
  edge caches for **up to a year**. Editing one *in place* under the same filename
  will serve the old bytes to returning visitors (and, with edge caching on, from
  the CDN too). To change one, **rename the file** (and update its references) or
  **append a version query** (`background.mp4?v=2`). This convention is also noted
  inline beside each `immutable` branch in
  [`lib/http/app-middleware.js`](../../lib/http/app-middleware.js)'s `setHeaders`.

Enabling edge caching does not change these rules — it just makes the `immutable`
year-long TTLs apply at the CDN as well, so the rename/`?v=` habit matters a little
more for in-place asset swaps.
