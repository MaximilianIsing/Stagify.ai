// Referral / campaign link routes — /columbia and any sibling in REFERRAL_LINKS.
//
// Each registered URL counts one arrival and 302s to the home page. The redirect is
// the whole visible behaviour: the visitor lands on stagify.ai/ and the campaign
// slug leaves the address bar, so there is no second URL serving the home page for
// Google to weigh against the canonical one, and no chance of the home page's
// relative asset paths resolving against a /columbia/ prefix.
//
// Routes are registered ONE PER SLUG from the registry, never as `/:slug`. A
// parameterised route here would match every path this router is mounted ahead of
// and turn the campaign counter into a catch-all.
//
// Counting is best-effort by design: the store swallows its own write errors and the
// rate limiter drops rows rather than rejecting, because a visitor must reach the
// site whether or not the analytics write succeeds.

import { createAsyncRouter } from '../lib/http/async-router.js';
import { REFERRAL_LINKS } from '../lib/data/referral-links.js';
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
 * }} deps - The hit store, plus a test-only limiter seam: omitted (or null) it falls
 *   back to the shared `referralLimiter`, so the endpoint is never mounted unlimited.
 * @returns {import('express').Router}
 */
export default function createReferralRouter({ referralLinks, referralLimiter }) {
  const router = createAsyncRouter();
  const limiter = referralLimiter ?? defaultReferralLimiter;
  const links = referralLinks?.links ?? REFERRAL_LINKS;

  for (const link of links) {
    router.get(`/${link.slug}`, limiter, (req, res) => {
      // Express answers HEAD from the GET handler. Link previewers and health
      // probes lean on HEAD, and nobody arrives at a page that way, so a HEAD is
      // redirected without being counted.
      if (req.method === 'GET' && !res.locals[REFERRAL_RATE_LIMITED]) {
        referralLinks.recordHit({
          slug: link.slug,
          referer: req.get('referer'),
          userAgent: req.get('user-agent'),
        });
      }
      // A cached 302 would make the same visitor's later opens invisible, and an
      // intermediary caching it would hide everyone behind it.
      res.set('Cache-Control', 'no-store');
      res.redirect(302, '/');
    });
  }

  return router;
}
