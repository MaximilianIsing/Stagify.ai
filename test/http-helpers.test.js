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
} from '../lib/http/http-helpers.js';

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

test('getStagingClientIp: prefers X-Forwarded-For, strips ::ffff:, falls back to unknown', () => {
  assert.equal(
    getStagingClientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' }),
    '203.0.113.7',
    'the client (first) XFF entry wins',
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
