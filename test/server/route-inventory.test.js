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
  ['POST', '/api/enhance-exterior'],
  ['POST', '/api/chat'],
  ['POST', '/api/mask-edit'],
  // The Masking Studio's save. Registered here because losing it is silent: the studio
  // fires it with `void` and swallows failures, so a renamed route would simply stop
  // saving and nobody would see an error.
  ['POST', '/api/masking-studio/save'],
  ['POST', '/api/segment'],
  ['POST', '/api/chat-upload'],
  ['POST', '/api/send-email'],
  ['POST', '/api/stage-by-endpoint-key'],
  // The gallery. Unauthenticated probes are refused at the top of each handler (401)
  // long before anything is read or written.
  ['GET', '/api/gallery'],
  ['DELETE', '/api/gallery/probe'],
  ['PATCH', '/api/gallery/probe/share'],
  // DELIBERATELY ABSENT: POST and DELETE /api/gallery/:id/share.
  //
  // They minted and revoked a link back when a link was something an owner switched on
  // for one render. Every finished render has one now, handed over with the listing, so
  // both were removed rather than left mounted with nothing calling them.
  // The public share shell. It performs NO lookup, so any token — including this
  // invented one — gets the same 200 shell.
  ['GET', '/s/probe'],
  // DELIBERATELY ABSENT: GET /api/share/:token.
  //
  // Its entire contract is a uniform 404 for unknown, revoked, expired, not-yours and
  // not-yet-uploaded — that is what stops it being an oracle over the token keyspace
  // (see routes/share-public.js). This test reads 404 as "route removed", so listing it
  // here would fail the build for exactly the reason the route is correct. Its
  // registration is covered in test/routes/share-public.test.js instead.
];

test('every critical route is still registered (not 404)', async () => {
  const removed = [];
  for (const [method, p] of CRITICAL_ROUTES) {
    const res = await fetch(`${server.baseUrl}${p}`, { method });
    if (res.status === 404) removed.push(`${method} ${p}`);
  }
  assert.equal(removed.length, 0, `Route(s) returned 404 — removed or renamed?\n${removed.join('\n')}`);
});
