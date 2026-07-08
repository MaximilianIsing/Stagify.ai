// Unit tests for the pure Masking Studio helpers extracted into
// public/scripts/masking-studio/layers.js (bounded-concurrency pool + palette
// index picker). No DOM, so they run directly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPool, nextColorIdx } from '../public/scripts/masking-studio/layers.js';

test('createPool: never runs more than `size` jobs at once', async () => {
  const pool = createPool(2);
  let active = 0;
  let maxActive = 0;
  const job = () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return active;
  };
  await Promise.all(Array.from({ length: 6 }, () => pool(job())));
  assert.ok(maxActive <= 2, `max concurrent was ${maxActive}, expected <= 2`);
});

test('createPool: runs every job and resolves with each result', async () => {
  const pool = createPool(3);
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pool(async () => n * 10)));
  assert.deepEqual(results.sort((a, b) => a - b), [10, 20, 30, 40, 50]);
});

test('createPool: a rejecting job rejects its own promise but the pool keeps draining', async () => {
  const pool = createPool(1);
  const settled = await Promise.allSettled([
    pool(async () => { throw new Error('boom'); }),
    pool(async () => 'ok'),
  ]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[0].reason.message, 'boom');
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(settled[1].value, 'ok');
});

test('nextColorIdx: lowest free index, skipping used ones', () => {
  assert.equal(nextColorIdx([], 6), 0);
  assert.equal(nextColorIdx([{ colorIdx: 0 }, { colorIdx: 1 }], 6), 2);
  // Gaps are filled lowest-first.
  assert.equal(nextColorIdx([{ colorIdx: 0 }, { colorIdx: 2 }], 6), 1);
});

test('nextColorIdx: -1 when the palette is exhausted', () => {
  const layers = [0, 1, 2].map((colorIdx) => ({ colorIdx }));
  assert.equal(nextColorIdx(layers, 3), -1);
});
