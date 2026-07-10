// Pure request/response helpers (lib/http-helpers.js). isLikelyMobileStagingRequest
// is security-relevant: it decides whether an unauthenticated request is blocked
// (desktop → must sign in) or allowed onto the IP-based free tier (mobile). A
// misclassification would let anonymous desktop clients bypass the sign-in gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setSensitiveHeaders,
  getStagingClientIp,
  isLikelyMobileStagingRequest,
  getUserIdentifier,
  sendError,
} from '../lib/http/http-helpers.js';

// Minimal Express-style res double: records the status + JSON body sendError emits.
function mockRes() {
  const rec = {};
  const res = {
    status(code) { rec.status = code; return res; },
    json(body) { rec.body = body; return res; },
  };
  return { res, rec };
}

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

test('isLikelyMobileStagingRequest: mobile UAs → true, desktop / missing → false', () => {
  const mob = (ua) => isLikelyMobileStagingRequest({ headers: { 'user-agent': ua } });
  assert.equal(mob(IPHONE), true);
  assert.equal(mob(ANDROID), true);
  assert.equal(mob('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148'), true);
  // The security-critical direction: desktop must NOT read as mobile, or an
  // unauthenticated desktop request would slip past the sign-in gate.
  assert.equal(mob(DESKTOP), false);
  assert.equal(mob('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Safari/605'), false);
  assert.equal(isLikelyMobileStagingRequest({ headers: {} }), false, 'no UA → false');
  assert.equal(isLikelyMobileStagingRequest({ headers: { 'user-agent': '' } }), false, 'empty UA → false');
});

test('getStagingClientIp: trusts req.ip, ignores raw X-Forwarded-For, strips ::ffff:, falls back to unknown', () => {
  // Security-critical: a client-supplied X-Forwarded-For must NOT override req.ip
  // (which Express derives from the trust-proxy chain). Trusting the raw header would
  // let a caller rotate it to evade the per-IP anonymous cap.
  assert.equal(
    getStagingClientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '198.51.100.9' }),
    '198.51.100.9',
    'req.ip wins; the spoofable XFF header is ignored',
  );
  assert.equal(getStagingClientIp({ headers: {}, ip: '::ffff:192.168.1.5' }), '192.168.1.5', 'IPv4-mapped prefix stripped');
  assert.equal(getStagingClientIp({ headers: {}, socket: { remoteAddress: '198.51.100.9' } }), '198.51.100.9');
  assert.equal(getStagingClientIp({ headers: {} }), 'unknown');
});

test('getUserIdentifier: userId > userEmail > IP-derived', () => {
  assert.equal(getUserIdentifier({ body: { userId: 'u_1' } }), 'u_1');
  assert.equal(getUserIdentifier({ body: { userEmail: 'a@b.com' } }), 'a@b.com');
  assert.equal(getUserIdentifier({ body: { userEmail: 'unknown' }, ip: '1.2.3.4' }), 'user_1_2_3_4', 'the "unknown" sentinel is ignored');
  assert.equal(getUserIdentifier({ body: {}, ip: '1.2.3.4' }), 'user_1_2_3_4');
});

test('setSensitiveHeaders sets no-store + no-referrer', () => {
  const set = {};
  setSensitiveHeaders({ set: (k, v) => { set[k] = v; } });
  assert.equal(set['Cache-Control'], 'no-store');
  assert.equal(set['Referrer-Policy'], 'no-referrer');
});

test('sendError: status is applied and body is always { error } at minimum', () => {
  const { res, rec } = mockRes();
  sendError(res, 400, 'Image is required');
  assert.equal(rec.status, 400);
  assert.deepEqual(rec.body, { error: 'Image is required' });
});

test('sendError: code and details are included only when truthy', () => {
  const withCode = mockRes();
  sendError(withCode.res, 401, 'Sign in required', { code: 'AUTH_REQUIRED' });
  assert.deepEqual(withCode.rec.body, { error: 'Sign in required', code: 'AUTH_REQUIRED' });

  const withDetails = mockRes();
  sendError(withDetails.res, 500, 'Image processing failed', { details: 'boom' });
  assert.deepEqual(withDetails.rec.body, { error: 'Image processing failed', details: 'boom' });

  const withBoth = mockRes();
  sendError(withBoth.res, 422, 'Could not stage', { code: 'NO_IMAGE_GENERATED', details: 'no candidates' });
  assert.deepEqual(withBoth.rec.body, { error: 'Could not stage', code: 'NO_IMAGE_GENERATED', details: 'no candidates' });

  // Falsy code/details must not leak empty keys into the body.
  const bare = mockRes();
  sendError(bare.res, 500, 'Failed', { code: undefined, details: '' });
  assert.deepEqual(bare.rec.body, { error: 'Failed' });
});
