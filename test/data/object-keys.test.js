// lib/data/object-keys.js — the naming of the gallery's bytes, and gate 1.
//
// The rejection tests below are the important ones. These keys come out of the database
// and reach a route that serves bytes back, so a key that escapes its prefix is the
// route handing out whatever it lands on — `auth-store.db` included. Gate 1 is a
// whole-string regex, and every test here is a way somebody has smuggled a path through
// a "looks fine" pattern before: a `..` segment, a backslash on Windows, an absolute
// path, percent-encoding that decodes to a separator, a NUL truncating a C string, and
// a legal key with something appended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECT_KEY_PATTERN,
  RENDER_ROLES,
  R2_PREFIXES,
  isSafeObjectKey,
  keyForRender,
  keyForRef,
  refHashFor,
  prefixOf,
  newRenderId,
} from '../../lib/data/object-keys.js';

const RID = '0123456789abcdef0123456789abcdef';
const HASH = 'a'.repeat(64);

test('builds the canonical key for every render role', () => {
  assert.equal(keyForRender({ renderId: RID, role: 'after' }), `renders/${RID}/after.webp`);
  assert.equal(keyForRender({ renderId: RID, role: 'before' }), `renders/${RID}/before.webp`);
  assert.equal(keyForRender({ renderId: RID, role: 'thumb' }), `renders/${RID}/thumb.webp`);
  for (const role of RENDER_ROLES) assert.ok(isSafeObjectKey(keyForRender({ renderId: RID, role })));
});

test('builds the canonical key for a reference', () => {
  assert.equal(keyForRef({ refHash: HASH }), `refs/${HASH}.webp`);
});

test('normalizes the extension and the case of an id', () => {
  assert.equal(keyForRender({ renderId: RID.toUpperCase(), role: 'after', ext: '.WEBP' }), `renders/${RID}/after.webp`);
  assert.equal(keyForRef({ refHash: HASH.toUpperCase(), ext: 'JPG' }), `refs/${HASH}.jpg`);
});

test('refuses to build a key it could not serve back', () => {
  // Throwing beats returning a bad key: a caller that gets this wrong would otherwise
  // persist an unservable storage_key and only find out when somebody asked for the
  // image back — by which time the bytes and the row disagree.
  assert.throws(() => keyForRender({ renderId: RID, role: 'original' }), /EUNSAFEKEY|refusing/);
  assert.throws(() => keyForRender({ renderId: '../../etc', role: 'after' }), /refusing/);
  assert.throws(() => keyForRender({ renderId: RID, role: 'after', ext: 'w e b p' }), /refusing/);
  assert.throws(() => keyForRef({ refHash: 'tooshort' }), /refusing/);
  assert.throws(() => keyForRef({ refHash: `${HASH}/../../x` }), /refusing/);
});

test('the thrown refusal carries code EUNSAFEKEY so a route can answer 400 not 500', () => {
  try {
    keyForRender({ renderId: 'nope!', role: 'after' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(/** @type {any} */ (e).code, 'EUNSAFEKEY');
  }
});

// Every entry here has been a real path-traversal in some codebase. The regex rejects
// them by construction — none of these characters are in any allowed class — but the
// test is what keeps that true if the pattern is ever "improved".
for (const evil of [
  '../auth-store.db',
  'renders/../../auth-store.db',
  `renders/${RID}/../../../auth-store.db`,
  `renders/${RID}\\after.webp`,
  `/renders/${RID}/after.webp`,
  `C:\\renders\\${RID}\\after.webp`,
  `renders/${RID}/after.webp/../../x.webp`,
  `renders/%2e%2e/after.webp`,
  `renders/${RID}/after.webp\u0000.png`,
  `renders/${RID}/after.webp `,
  ` renders/${RID}/after.webp`,
  `renders/${RID}/after.webp\n`,
  `xrenders/${RID}/after.webp`,
  `renders/${RID}/after`,
  `renders/${RID}/AFTER.webp`,
  `refs/${HASH}`,
  `refs/${'a'.repeat(63)}.webp`,
  `refs/${'a'.repeat(65)}.webp`,
  `refs/${'g'.repeat(64)}.webp`,
  'renders//after.webp',
  '',
]) {
  test(`gate 1 rejects ${JSON.stringify(evil)}`, () => {
    assert.equal(isSafeObjectKey(evil), false);
    assert.equal(OBJECT_KEY_PATTERN.test(evil), false);
  });
}

test('gate 1 rejects non-strings without throwing', () => {
  for (const v of [null, undefined, 42, {}, [], Buffer.from('x')]) assert.equal(isSafeObjectKey(v), false);
});

test('a reference hash is scoped to its uploader', () => {
  const bytes = Buffer.from('the same sofa photo');
  // The SAME bytes from two accounts must not collide: that is what makes erasure an
  // unconditional delete instead of "is anyone else still using this?".
  assert.notEqual(refHashFor('user-a', bytes), refHashFor('user-b', bytes));
  // ...and the same bytes from ONE account must dedupe, which is the whole point.
  assert.equal(refHashFor('user-a', bytes), refHashFor('user-a', Buffer.from('the same sofa photo')));
  assert.match(refHashFor('user-a', bytes), /^[a-f0-9]{64}$/);
});

test('the user-id salt cannot be faked by moving the separator', () => {
  // A naive `userId + bytes` concatenation lets 'ab' + 'cd' collide with 'a' + 'bcd'.
  // The separator is what stops that, so pin it.
  assert.notEqual(refHashFor('ab', Buffer.from('cd')), refHashFor('a', Buffer.from('bcd')));
});

test('every prefix the builders can emit is classified in R2_PREFIXES', () => {
  // The moral twin of the data-dir drift guard, which can only see path.join calls and
  // would pass vacuously for bytes in a bucket. If a third key shape is ever added,
  // this fails until its erasure story is written down.
  assert.equal(prefixOf(keyForRender({ renderId: RID, role: 'after' })), 'renders/');
  assert.equal(prefixOf(keyForRef({ refHash: HASH })), 'refs/');
  assert.equal(prefixOf('nonsense'), null);
  assert.deepEqual(Object.keys(R2_PREFIXES).sort(), ['refs/', 'renders/']);
  for (const reason of Object.values(R2_PREFIXES)) {
    assert.ok(reason.length > 20, 'each prefix needs a real explanation, not a placeholder');
  }
});

test('render ids are 32 hex and do not repeat', () => {
  const ids = new Set(Array.from({ length: 200 }, newRenderId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/);
});
