// Tier: unit (no server) — lib/http/error-ref.js.
//
// WHAT THIS COVERS
// The reference has to be two things at once: useless to the caller and sufficient
// for the operator. So: the returned value must carry nothing about the error (it is
// random, not derived — two identical errors get different references, and the same
// error never yields a guessable one), while the log line must carry the error whole,
// stack included, alongside that reference. A reference nobody can find in the logs
// would be worse than the `details` it replaced.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportError } from '../../lib/http/error-ref.js';
import { logger } from '../../lib/logger.js';

const origError = logger.error;
/** @type {any[][]} */
let logged = [];
function captureLogs() {
  logged = [];
  logger.error = (...args) => { logged.push(args); };
}
afterEach(() => { logger.error = origError; });

test('returns an 8-char hex reference', () => {
  captureLogs();
  assert.match(reportError('ctx', new Error('boom')), /^[0-9a-f]{8}$/);
});

test('the reference is random, not derived from the error', () => {
  captureLogs();
  // Same context, same message, twice: identical inputs must not collapse to one
  // reference, or two users hitting the same bug would be indistinguishable in the log.
  const a = reportError('ctx', new Error('boom'));
  const b = reportError('ctx', new Error('boom'));
  assert.notEqual(a, b);
});

test('the reference reveals nothing about the failure', () => {
  captureLogs();
  const ref = reportError('admin.promptlogs', new Error('ENOENT: /srv/app/data/prompt_logs.csv'));
  assert.doesNotMatch(ref, /ENOENT|srv|prompt|admin/i);
});

test('the log line carries the context, the reference, and the error itself', () => {
  captureLogs();
  const err = new Error('ENOENT: no such file');
  const ref = reportError('admin.promptlogs', err);

  assert.equal(logged.length, 1, 'exactly one line — the call sites dropped their own logger.error');
  const [message, logadicError] = logged[0];
  assert.match(message, /admin\.promptlogs/, 'the operator can tell which endpoint failed');
  assert.ok(message.includes(ref), 'the reference the client was given is findable in the log');
  assert.equal(logadicError, err, 'the error object is logged whole, so the stack survives');
});

test('a non-Error throw still produces a reference and is logged', () => {
  // `throw 'string'` and rejected non-Errors reach these catch blocks too.
  captureLogs();
  const ref = reportError('chat', 'just a string');
  assert.match(ref, /^[0-9a-f]{8}$/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], 'just a string');
});
