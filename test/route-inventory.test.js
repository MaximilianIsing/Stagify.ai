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
import { startServer } from './helpers/server.js';

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
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/register'],
  ['POST', '/api/getpro'],
  ['POST', '/api/billing/stripe-webhook'],
  ['POST', '/api/billing/customer-portal'],
  ['POST', '/api/validate-image'],
  ['POST', '/api/process-image'],
  ['POST', '/api/chat'],
  ['POST', '/api/mask-edit'],
  ['POST', '/api/chat-upload'],
  ['POST', '/api/send-email'],
  ['POST', '/api/stage-by-endpoint-key'],
];

test('every critical route is still registered (not 404)', async () => {
  const removed = [];
  for (const [method, p] of CRITICAL_ROUTES) {
    const res = await fetch(`${server.baseUrl}${p}`, { method });
    if (res.status === 404) removed.push(`${method} ${p}`);
  }
  assert.equal(removed.length, 0, `Route(s) returned 404 — removed or renamed?\n${removed.join('\n')}`);
});
