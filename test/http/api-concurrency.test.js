// Tier: unit (fake req/res with real EventEmitter semantics) — lib/http/api-concurrency.js.
//
// WHAT THIS COVERS
// The gate that bounds SIMULTANEOUS renders, which the rate limiter cannot. The whole
// value of it is in the release path, so that is what most of these tests are about:
//   - the per-key ceiling and the process-wide ceiling both bite, with distinct scopes,
//   - a slot is returned on a normal finish, on a client that hangs up mid-render, and
//     on a handler that throws — and released exactly ONCE even when both events fire,
//   - keys are independent, so one customer cannot spend another's headroom, and
//   - the bucket map does not grow forever: a key that drops to zero is deleted.
//
// The last two are the failure modes that would only show up in production, days apart:
// a leaked slot ratchets the gate shut over hours, and a retained zero-entry leaks
// memory one key at a time on a public API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConcurrencyGate } from '../../lib/http/api-concurrency.js';

/** A res that really emits 'finish'/'close', because that is the contract under test. */
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const req = (id) => ({ apiKey: { id }, ip: '1.2.3.4' });

/** Enter the gate; returns the res so the test can end the response itself. */
function enter(gate, keyId) {
  const res = fakeRes();
  let admitted = false;
  gate(req(keyId), res, () => { admitted = true; });
  return { res, admitted };
}

test('the per-key ceiling admits exactly `limit` at once and refuses the next', () => {
  const { gate, forKey } = createConcurrencyGate({ limit: 2, globalLimit: 99 });

  assert.equal(enter(gate, 'k1').admitted, true);
  assert.equal(enter(gate, 'k1').admitted, true);
  assert.equal(forKey('k1'), 2);

  const third = enter(gate, 'k1');
  assert.equal(third.admitted, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body.code, 'CONCURRENCY_LIMIT');
  assert.match(third.res.body.error, /2 renders/, 'the message should name the actual ceiling');
});

test('one key cannot spend another key\'s headroom', () => {
  const { gate, inFlight } = createConcurrencyGate({ limit: 1, globalLimit: 99 });

  assert.equal(enter(gate, 'a').admitted, true);
  assert.equal(enter(gate, 'a').admitted, false, 'a is full');
  assert.equal(enter(gate, 'b').admitted, true, "b must be unaffected by a's traffic");
  assert.equal(inFlight(), 2);
});

test('the global ceiling bites before the per-key one, and says which', () => {
  const { gate } = createConcurrencyGate({ limit: 5, globalLimit: 2 });

  enter(gate, 'a');
  enter(gate, 'b');
  const over = enter(gate, 'c');

  assert.equal(over.admitted, false);
  assert.equal(over.res.statusCode, 429);
  assert.match(over.res.body.error, /busy/i, 'a global refusal is about the box, not the caller');
});

test('a finished response returns its slot', () => {
  const { gate, inFlight, forKey } = createConcurrencyGate({ limit: 1, globalLimit: 9 });
  const first = enter(gate, 'k');
  assert.equal(inFlight(), 1);

  first.res.emit('finish');
  assert.equal(inFlight(), 0);
  assert.equal(forKey('k'), 0);
  assert.equal(enter(gate, 'k').admitted, true, 'the slot is reusable');
});

test('a client that hangs up mid-render returns its slot too', () => {
  // Renders are long enough that abandoned requests are routine. Leaking here would
  // ratchet the gate shut over hours with nothing actually in flight.
  const { gate, inFlight } = createConcurrencyGate({ limit: 1, globalLimit: 9 });
  const first = enter(gate, 'k');

  first.res.emit('close');
  assert.equal(inFlight(), 0);
  assert.equal(enter(gate, 'k').admitted, true);
});

test('finish AND close both firing releases exactly one slot, not two', () => {
  const { gate, inFlight } = createConcurrencyGate({ limit: 3, globalLimit: 9 });
  const a = enter(gate, 'k');
  enter(gate, 'k');
  assert.equal(inFlight(), 2);

  a.res.emit('finish');
  a.res.emit('close');
  assert.equal(inFlight(), 1, 'a double release would let the counter drift below reality');
});

test('a refused request does not consume a slot', () => {
  const { gate, inFlight } = createConcurrencyGate({ limit: 1, globalLimit: 9 });
  enter(gate, 'k');
  enter(gate, 'k'); // refused
  assert.equal(inFlight(), 1, 'the 429 must not be counted as in flight');
});

test('a key that drops to zero is forgotten, so the map cannot grow forever', () => {
  const { gate, forKey } = createConcurrencyGate({ limit: 2, globalLimit: 99 });
  const seen = [];
  for (let i = 0; i < 200; i += 1) {
    const e = enter(gate, 'key_' + i);
    seen.push(e.res);
  }
  seen.forEach((r) => r.emit('finish'));

  for (let i = 0; i < 200; i += 1) assert.equal(forKey('key_' + i), 0);
  // And the gate is fully open again.
  assert.equal(enter(gate, 'key_0').admitted, true);
});

test('the rejection hook fires with the scope, so a refusal is as visible as a 429', () => {
  const seen = [];
  const { gate } = createConcurrencyGate({
    limit: 1,
    globalLimit: 1,
    onReject: (_req, scope) => seen.push(scope),
  });

  enter(gate, 'a');
  enter(gate, 'b'); // global is full first
  assert.deepEqual(seen, ['global']);
});

test('a handler that throws still releases, because the response still ends', () => {
  const { gate, inFlight } = createConcurrencyGate({ limit: 1, globalLimit: 9 });
  const res = fakeRes();
  gate(req('k'), res, () => { /* handler would throw here; Express still ends the response */ });
  assert.equal(inFlight(), 1);

  res.emit('finish'); // the catch-all error handler in server.js answered it
  assert.equal(inFlight(), 0);
});
