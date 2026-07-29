// Referral / campaign link routes — /columbia and anything else created from the
// dashboard. Each hit is counted and 302s to the home page.
//
// The redirect is the whole visible behaviour: the visitor lands on stagify.ai/ and
// the campaign slug leaves the address bar, so there is no second URL serving the
// home page for Google to weigh against the canonical one, and no chance of the
// home page's relative asset paths resolving against a /columbia/ prefix.
//
// MOUNT THIS LAST — after every other router in server.js. Links are data now, so
// this router cannot register a route per slug at boot; it matches `/:slug` and
// resolves against the store per request. Mounted last, that pattern only ever sees
// paths nothing else claimed, which makes it structurally impossible for a link
// created in the dashboard to shadow a real page. Move it earlier and a link named
// `pro` or `es` takes that page off the site. (createLink also refuses those names,
// but that check is a helpful error, not the safety property.)
//
// Counting is best-effort by design: the store swallows its own write errors and the
// rate limiter drops rows rather than rejecting, because a visitor must reach the
// site whether or not the analytics write succeeds.

import { createAsyncRouter } from '../lib/http/async-router.js';
import {
  referralLimiter as defaultReferralLimiter,
  REFERRAL_RATE_LIMITED,
} from '../lib/http/rate-limiters.js';

/**
 * Build the referral-link router.
 *
 * @param {{
 *   referralLinks: ReturnType<typeof import('../lib/data/referral-links.js').createReferralLinks>,
 *   referralLimiter?: import('express').RequestHandler | null,
 * }} deps - The link store, plus a test-only limiter seam: omitted (or null) it falls
 *   back to the shared `referralLimiter`, so the endpoint is never mounted unlimited.
 * @returns {import('express').Router}
 */
export default function createReferralRouter({ referralLinks, referralLimiter }) {
  const router = createAsyncRouter();
  const limiter = referralLimiter ?? defaultReferralLimiter;

  router.get(
    '/:slug',
    // Resolve BEFORE the limiter. This route sees every unmatched single-segment
    // path in the app, so running the limiter first would let stray 404 traffic
    // eat the bucket that protects the real links.
    (req, res, next) => {
      const link = referralLinks.getActiveLink(req.params.slug);
      if (!link) return next('route'); // not a campaign URL — fall through to 404
      res.locals.referralLink = link;
      return next();
    },
    limiter,
    (req, res) => {
      // Express answers HEAD from the GET handler. Link previewers and health
      // probes lean on HEAD, and nobody arrives at a page that way, so a HEAD is
      // redirected without being counted.
      if (req.method === 'GET' && !res.locals[REFERRAL_RATE_LIMITED]) {
        referralLinks.recordHit({
          slug: res.locals.referralLink.slug,
          referer: req.get('referer'),
          userAgent: req.get('user-agent'),
        });
      }
      // A cached 302 would make the same visitor's later opens invisible, and an
      // intermediary caching it would hide everyone behind it. It would also keep
      // sending people to a link the operator has since retired.
      res.set('Cache-Control', 'no-store');
      res.redirect(302, '/');
    },
  );

  return router;
}
