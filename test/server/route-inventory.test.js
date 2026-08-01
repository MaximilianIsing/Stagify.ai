// Server-refactor safety net — the critical routes must stay registered.
//
// server.js is large and actively refactored; the easiest way to "screw stuff up"
// is to accidentally remove or rename a route the frontend or integrations depend on.
// This boots the server and asserts each critical route still EXISTS — i.e. responds
// with anything other than 404 for its correct method. We assert only "registered"
// (not a specific success code), so it stays green across refactors and regardless of
// whether optional services (Stripe/AI/email) are configured. Each route is hit with
// no credentials and no body, so handlers reject early (400/401/403) before any side
// effect — nothing is written, sent, or charged.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

// [method, path] — hit with the CORRECT method so a 404 unambiguously means
// "route removed/renamed" (Express returns 404, not 405, for an unknown method).
const CRITICAL_ROUTES = [
  ['GET', '/api/health'],
  ['GET', '/api/auth/config'],
  ['GET', '/api/auth/me'],
  ['GET', '/api/prompt-count'],
  ['GET', '/api/contact-count'],
  ['GET', '/robots.txt'],
  ['GET', '/sitemap.xml'],
  ['GET', '/getpro'],
  ['GET', '/promptlogs'],
  ['GET', '/authstore'],
  ['GET', '/api/admin/ping'], // the admin sign-in probe — losing it locks out /admin
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/register'],
  ['POST', '/api/getpro'],
  // Orphan-blob reclaim. Key-gated, so an unauthenticated probe is a 403 long before the
  // sweep runs — nothing is scanned or deleted by this sweep of the routes.
  ['POST', '/api/admin/blob-gc'],
  // Listing Studio health — read-only, so GET; key-gated, so an unauthenticated probe is
  // a 403 before any query runs.
  ['GET', '/api/admin/listing-health'],
  ['POST', '/api/admin/grant-plus'],
  ['POST', '/api/admin/revoke-plus'],
  // Referral links. Every one is key-gated, so an unauthenticated probe is rejected
  // at the guard (403) long before the handler — nothing is created or deleted here.
  ['GET', '/api/admin/referrals'],
  ['POST', '/api/admin/referrals'],
  ['POST', '/api/admin/referrals/probe/deactivate'],
  ['POST', '/api/admin/referrals/probe/activate'],
  ['DELETE', '/api/admin/referrals/probe'],
  ['POST', '/api/billing/stripe-webhook'],
  ['POST', '/api/billing/customer-portal'],
  ['POST', '/api/enterprise/create-checkout'],
  ['POST', '/api/validate-image'],
  ['POST', '/api/process-image'],
  ['POST', '/api/chat'],
  ['POST', '/api/mask-edit'],
  ['POST', '/api/segment'],
  ['POST', '/api/chat-upload'],
  ['POST', '/api/send-email'],
  ['POST', '/api/stage-by-endpoint-key'],
  // Listing Studio. Every one is Stagify+ gated inside its handler, so an
  // unauthenticated probe is rejected (401/403) before the id in the path is ever
  // looked up — nothing is created, staged, or deleted by this sweep. The byte-serve
  // route is included deliberately: losing it would silently break every rendered
  // image in the studio while the JSON endpoints all still answered.
  ['POST', '/api/projects'],
  ['GET', '/api/projects'],
  ['GET', '/api/projects/probe'],
  ['PATCH', '/api/projects/probe'],
  ['DELETE', '/api/projects/probe'],
  ['POST', '/api/projects/probe/photos'],
  ['PATCH', '/api/projects/probe/photos/probe'],
  ['DELETE', '/api/projects/probe/photos/probe'],
  ['POST', '/api/projects/probe/stage'],
  ['GET', '/api/projects/probe/progress'],
  ['POST', '/api/projects/probe/rooms/living-room-1/bible/regenerate'],
  ['GET', '/api/projects/probe/renders/probe/image'],
  ['GET', '/api/projects/probe/photos/probe/image'],
  // The three recovery/delivery routes. Each closes a defect that made the feature
  // unusable rather than merely awkward, so losing one silently is worth failing on:
  // renders.zip is the ONLY way to get the staged images out; retry is the only way to
  // recover a single failed frame without re-running (and re-billing) a whole room; and
  // cancel is the only way to stop a 90-render run short of deleting the listing.
  ['GET', '/api/projects/probe/renders.zip'],
  ['POST', '/api/projects/probe/renders/probe/retry'],
  ['POST', '/api/projects/probe/cancel'],
  // Client share links, owner side. Same gate as the rest of the studio, so an
  // unauthenticated probe is a 401 and no link is minted or revoked by this sweep.
  ['GET', '/api/projects/probe/share'],
  ['POST', '/api/projects/probe/share'],
  ['PATCH', '/api/projects/probe/share'],
  ['DELETE', '/api/projects/probe/share'],
  // The public gallery shell. It answers 200 for ANY token — including this nonsense one —
  // on purpose: the HTML must not be an oracle for which tokens are real, so the page is
  // byte-identical either way and the manifest fetch behind it is what refuses. That also
  // makes it the one public share route this sweep can check, since the other three answer
  // the same uniform 404 for a bad token as they would if they were deleted (see below).
  ['GET', '/s/probe'],
  // Seller sign-off, owner half. Same gate as the rest of the studio, so an unauthenticated
  // probe is a 401 and no response is read.
  ['GET', '/api/projects/probe/feedback'],
];

// DELIBERATELY NOT LISTED: GET /api/share/:token, /api/share/:token/render/:id,
// /api/share/:token/photo/:id and the two /api/share/:token/feedback routes. Every rejection on those routes is one indistinguishable
// 404 — that is the point of them (a 410 for a revoked link would confirm the token was
// once real) — so "route removed" and "route working correctly" are the same response here
// and this sweep cannot tell them apart. Their coverage is behavioural, in
// test/routes/share-public.test.js, which drives them with REAL tokens.

test('every critical route is still registered (not 404)', async () => {
  const removed = [];
  for (const [method, p] of CRITICAL_ROUTES) {
    const res = await fetch(`${server.baseUrl}${p}`, { method });
    if (res.status === 404) removed.push(`${method} ${p}`);
  }
  assert.equal(removed.length, 0, `Route(s) returned 404 — removed or renamed?\n${removed.join('\n')}`);
});
