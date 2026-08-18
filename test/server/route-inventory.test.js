// Server-refactor safety net — the critical routes must stay registered.
//
// server.js is large and actively refactored; the easiest way to "screw stuff up"
// is to accidentally remove or rename a route the frontend or integrations depend on.
// This boots the server and asserts each critical route still EXISTS — i.e. responds
// with anything other than 404 for its correct method. We assert no specific success
// code, so it stays green across refactors and regardless of whether optional services
// (Stripe/AI/email) are configured. Each route is hit with no credentials and no body,
// so handlers reject early (400/401/403) before any side effect — nothing is written,
// sent, or charged.
//
// A 5xx also fails, because "registered" is worthless if every request to the route
// blows up. Know what that check does and does not reach: most of the list is refused
// at an auth guard (401/403) before the handler body runs, so a handler that throws on
// every real request still answers 401 here and passes. The 5xx check only covers the
// routes an unauthenticated bodyless probe actually gets INTO — the ones answering 200
// or 400 below. It is a floor, not proof the handler works; that is each route's own
// spec's job.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

let server;
before(async () => {
  // Raise the endpoint-key limiter for the child only. ONE bucket of 10/15min is shared
  // by the admin-key guard and /api/stage-by-endpoint-key on purpose (see
  // lib/http/rate-limiters.js), and this sweep spends the whole budget on the ten
  // admin-key routes below — so DELETE /api/admin/referrals/probe and
  // POST /api/stage-by-endpoint-key used to answer 429 from the limiter instead of 403
  // from the guard. That passed the 404 check while proving only that a limiter is
  // mounted, never that the route behind it still is. Raising the ceiling lets every
  // route reach its real guard.
  server = await startServer({ RL_ENDPOINT_KEY: '1000' });
});
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
  // Signals tab. Both key-gated, so an unauthenticated probe stops at the guard —
  // no SQL runs and no model call is billed. Listed because losing either one
  // degrades the tab silently rather than visibly: findings-quality.js reports a
  // missing metrics pack as a finding, which is right at runtime and would let a
  // 404 here go unnoticed indefinitely.
  ['GET', '/api/admin/metrics'],
  ['POST', '/api/admin/brief'],
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

test('every critical route is still registered (not 404), and none is dead on arrival (not 5xx)', async () => {
  const removed = [];
  const erroring = [];
  for (const [method, p] of CRITICAL_ROUTES) {
    const res = await fetch(`${server.baseUrl}${p}`, { method });
    if (res.status === 404) removed.push(`${method} ${p}`);
    else if (res.status >= 500) erroring.push(`${method} ${p} -> ${res.status}`);
  }
  // Two buckets, not one condition: the two failures mean opposite things, and a shared
  // "removed or renamed?" message would send you hunting for a route that is still there.
  assert.deepEqual(
    removed,
    [],
    `Route(s) returned 404 — removed or renamed?\n${removed.join('\n')}`,
  );
  assert.deepEqual(
    erroring,
    [],
    'Route(s) are registered but throw on an unauthenticated, bodyless probe — the ' +
      'handler or a guard above it is broken, not missing. This is NOT a rate limit ' +
      '(429 passes) and NOT a missing credential (401/403 pass):\n' +
      erroring.join('\n'),
  );
});
