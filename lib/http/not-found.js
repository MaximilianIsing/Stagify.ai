// The terminal 404 handler — the last thing in the Express pipeline.
//
// Before this existed, anything no router claimed fell through to Express's built-in
// finalhandler and the visitor got a bare `Cannot GET /whatver`: no branding, no nav,
// no way back. routes/i18n.js still documents that gap in prose next to its
// RETIRED_LOCALIZED_PATHS redirects, which exist partly to avoid it.
//
// TWO THINGS TO KNOW BEFORE EDITING:
//
// 1. This is a plain `app.use`, deliberately NOT a `create*Router` factory.
//    test/server/router-mount-order.test.js scans server.js for `create\w+Router(`
//    and asserts the LAST one is createReferralRouter — because routes/referrals.js
//    matches `/:slug` and mounting it anywhere but last would let an operator-created
//    campaign link shadow a real page. A router mounted after it would trip that
//    guard for no good reason: this handler claims no paths, it just answers what is
//    left. Naming it `createNotFoundHandler` keeps the guard meaningful.
//
// 2. The HTML goes through the SAME renderer as every localized page, English
//    included. That is not symmetry for its own sake: renderLocalizedPage injects
//    `<base href="/">`, and 404.html's asset URLs are relative (styles/styles.css,
//    media-webp/…, scripts/…). Sent raw, a 404 at /blog/nope would resolve them
//    against /blog/ and render unstyled and scriptless. There is no path depth this
//    handler is not reachable at, so the base tag is load-bearing, not cosmetic.

import path from 'path';
import { ENGLISH, localeByPrefix } from '../i18n/locales.js';
import { createPageRenderer } from '../i18n/page-renderer.js';
import { sendError } from './http-helpers.js';

/**
 * The 404 page's descriptor. Shaped like a LOCALIZED_PAGES entry so the shared
 * renderer takes it, but deliberately NOT in that array: membership there means a
 * canonical URL, an hreflang cluster and eleven sitemap entries, and a dead end
 * should have none of those. `path` is only used as a cache key and as the base for
 * bare `#fragment` links (of which the page has none).
 */
const NOT_FOUND_PAGE = { path: '/404', file: '404.html' };

/**
 * @param {{ __dirname: string, DEBUG_MODE: boolean }} deps
 * @returns {import('express').RequestHandler}
 */
export default function createNotFoundHandler({ __dirname, DEBUG_MODE }) {
  const renderer = createPageRenderer({ publicDir: path.join(__dirname, 'public'), DEBUG_MODE });

  return (req, res) => {
    // API callers and non-browser clients get the JSON shape every other error on
    // this server uses. `req.accepts('html')` is the discriminator rather than a
    // path prefix alone, so fetch/XHR/curl against a mistyped non-/api path also
    // get something parseable instead of a page of markup.
    if (req.path.startsWith('/api/') || !req.accepts('html')) {
      return sendError(res, 404, 'Not found');
    }

    // First path segment → locale. '/es/nope' is Spanish; '/esperanto' is not a
    // prefix and falls back to English, as does every unprefixed path.
    const prefix = req.path.split('/')[1] || '';
    const locale = localeByPrefix(prefix) || ENGLISH;

    res.status(404);
    res.set('Cache-Control', 'no-cache');
    return res.type('html').send(renderer.render(locale, NOT_FOUND_PAGE));
  };
}
