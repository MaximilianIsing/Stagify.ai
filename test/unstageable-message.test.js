// Unit tests for public/scripts/unstageable-message.js — the one place that decides
// which sentence a user sees when the upload gatekeeper rejects their photo.
//
// The module touches only window.LanguageSystem, so we stub that and run it directly
// under node --test. The English-fallback branch is the one that matters today (no
// errors.unstageable.* keys exist in the language packs yet); the translated branch is
// what lights up as those keys land, so both are pinned here.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unstageableMessage, DEFAULT_UNSTAGEABLE_MESSAGE } from '../public/scripts/unstageable-message.js';

// The module reads the global `window`; give it one, and let each test install its
// own LanguageSystem (or none, standing in for a page where the pack never loaded).
globalThis.window = /** @type {any} */ ({});
afterEach(() => { globalThis.window = /** @type {any} */ ({}); });

/** Stub matching language-loader.js: return the fallback for any key not in `pack`. */
function withLanguagePack(pack) {
  globalThis.window = /** @type {any} */ ({
    LanguageSystem: { getText: (key, fallback) => (key in pack ? pack[key] : fallback) },
  });
}

test('uses the translation when the language pack has the code', () => {
  withLanguagePack({ 'errors.unstageable.FOOD': 'Das sieht nach Essen aus.' });
  const msg = unstageableMessage({ code: 'FOOD', reason: 'This looks like a photo of food.' });
  assert.equal(msg, 'Das sieht nach Essen aus.');
});

test('falls back to the server English when that code is not translated yet', () => {
  // The state of every language today: pack loaded, but no errors.unstageable.* keys.
  withLanguagePack({ 'hero.catchphrase': 'Sube. Escenifica. Imagina.' });
  const msg = unstageableMessage({ code: 'VEHICLE', reason: 'This looks like a photo of a vehicle.' });
  assert.equal(msg, 'This looks like a photo of a vehicle.', 'an untranslated code must not blank the toast');
});

test('falls back to the server English when LanguageSystem is absent entirely', () => {
  const msg = unstageableMessage({ code: 'ANIMAL', reason: 'This looks like a photo of a pet.' });
  assert.equal(msg, 'This looks like a photo of a pet.');
});

test('a verdict with no code (older server, or a fail-open shape) uses its reason', () => {
  withLanguagePack({});
  assert.equal(unstageableMessage({ reason: 'Something specific.' }), 'Something specific.');
});

test('a verdict with neither code nor reason falls back to the generic message', () => {
  withLanguagePack({});
  assert.equal(unstageableMessage({}), DEFAULT_UNSTAGEABLE_MESSAGE);
  assert.equal(unstageableMessage(null), DEFAULT_UNSTAGEABLE_MESSAGE);
  assert.equal(unstageableMessage(undefined), DEFAULT_UNSTAGEABLE_MESSAGE);
});

test('never returns an empty string — a rejection always explains itself', () => {
  withLanguagePack({});
  for (const verdict of [null, {}, { code: 'FOOD' }, { code: null, reason: '' }, { reason: '' }]) {
    const msg = unstageableMessage(/** @type {any} */ (verdict));
    assert.ok(msg && msg.length > 0, `empty message for ${JSON.stringify(verdict)}`);
  }
});
