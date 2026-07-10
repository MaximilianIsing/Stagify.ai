// Tier: frontend island logic (window-stubbed) — public/scripts/app/version-carousel.js.
//
// The Before/After carousel owns the two version arrays for the main studio. The
// entry mutates them only through the returned push/set/get helpers, and the one
// non-obvious rule is the cap: pushing past `maxVersions` keeps only the most recent
// `maxVersions` entries (older masked edits / staged results roll off). That logic
// is pure array work; only construction touches the DOM (a single
// window.addEventListener('resize', ...)), so we stub `window` and pass no elements.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
if (!globalThis.window.addEventListener) globalThis.window.addEventListener = () => {};
const { createVersionCarousel } = await import('../public/scripts/app/version-carousel.js');

// All element deps are omitted: every access to them at construction time is
// `if (el)`-guarded, so only window.addEventListener runs.
const make = (maxVersions = 3) => createVersionCarousel({ maxVersions });

test('version arrays start empty', () => {
  const c = make();
  assert.deepEqual(c.getBeforeVersions(), []);
  assert.deepEqual(c.getAfterVersions(), []);
  assert.equal(c.getBeforeIndex(), 0);
});

test('setBeforeVersions replaces the list and resets the index', () => {
  const c = make();
  c.setBeforeVersions(['a', 'b']);
  assert.deepEqual(c.getBeforeVersions(), ['a', 'b']);
  assert.equal(c.getBeforeIndex(), 0);
});

test('pushBeforeVersion appends and returns the current list', () => {
  const c = make();
  c.setBeforeVersions(['a', 'b']);
  const out = c.pushBeforeVersion('c');
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.deepEqual(c.getBeforeVersions(), ['a', 'b', 'c']);
});

test('pushBeforeVersion caps the history at maxVersions (oldest roll off)', () => {
  const c = make(3);
  for (const url of ['a', 'b', 'c', 'd', 'e']) c.pushBeforeVersion(url);
  assert.deepEqual(c.getBeforeVersions(), ['c', 'd', 'e'], 'keeps only the most recent 3');
});

test('the After array has the same push/cap behavior, independently', () => {
  const c = make(2);
  c.pushAfterVersion('x');
  c.pushAfterVersion('y');
  const out = c.pushAfterVersion('z');
  assert.deepEqual(out, ['y', 'z'], 'capped at 2');
  assert.deepEqual(c.getAfterVersions(), ['y', 'z']);
  assert.deepEqual(c.getBeforeVersions(), [], 'the Before array is untouched');
});

test('setAfterVersions replaces the After list', () => {
  const c = make();
  c.setAfterVersions(['s1', 's2', 's3']);
  assert.deepEqual(c.getAfterVersions(), ['s1', 's2', 's3']);
});
