// Short, memorable URLs that point somewhere real. One entry so far: /brand.
//
// WHY THIS IS MOUNTED BEFORE express.static AND NOT IN routes/public.js
// The brand kit is a SECTION of /about, but its files live in public/brand/ — so
// `public/brand` is a real directory, and serve-static answers a request for a
// directory before any router sees it: GET /brand would 301 to /brand/, find no
// index.html there, and fall through to the 404 handler. Putting the redirect in
// routes/public.js (mounted ~190 lines later in server.js) would therefore be dead
// code. Turning serve-static's `redirect` off instead would break /blog, which
// depends on exactly that behaviour. So this goes in front.
//
// Only the EXACT paths below are claimed. /brand/stagify-brand-kit.zip and every
// other file under public/brand/ still falls straight through to express.static.
//
// 301, because the alias is meant to be permanent and the ranking signal should land
// on /about.html. The one-hour Cache-Control is the hedge: a bare 301 is cached by
// browsers indefinitely, so if /brand ever becomes a page of its own, anybody who
// followed the alias once would keep being bounced to /about for as long as their
// cache lived. An hour is long enough to cost nothing and short enough to undo.

/** Exact request path -> where it goes. @type {Record<string, string>} */
export const VANITY_REDIRECTS = {
  '/brand': '/about.html#brand-kit',
  '/brand/': '/about.html#brand-kit',
};

/**
 * The middleware itself, exported separately so test/http/vanity-redirects.test.js
 * can drive it with a fake req/res instead of booting the app.
 * @param {{ method: string, path: string }} req
 * @param {{ set: (k: string, v: string) => void, redirect: (code: number, url: string) => void }} res
 * @param {() => void} next
 * @returns {void}
 */
export function vanityRedirect(req, res, next) {
  const target = VANITY_REDIRECTS[req.path];
  // GET/HEAD only: a POST to a vanity alias is a mistake, and 301-ing it would
  // silently turn it into a GET rather than telling the caller they are wrong.
  if (!target || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
  res.set('Cache-Control', 'public, max-age=3600');
  res.redirect(301, target);
}

/**
 * Mount the vanity aliases. Must be called before applyBodyAndStatic().
 * @param {import('express').Express} app
 * @returns {void}
 */
export function applyVanityRedirects(app) {
  app.use(/** @type {any} */ (vanityRedirect));
}
