// Unit tests for the mask editor's shared phase copy (public/scripts/mask/copy.js).
//
// Two things worth pinning, neither of which e2e can see:
//
//   1. The English fallbacks. In a browser the language pack is loaded, so
//      `lang()` returns the translated string and the fallback is never reached —
//      an e2e assertion on the rendered text passes no matter what the fallback
//      says. Only a direct test can tell whether the fallback survived being
//      moved into one place.
//   2. That every key actually EXISTS in english.json, and says something in
//      every pack. Cross-pack coverage itself is already a hard gate in
//      test/server/static.test.js; the gaps left are a key missing from the base
//      set (nothing to compare against, so that gate stays green) and a key
//      present but empty. Both are the failure this module could most easily
//      introduce, since the keys moved file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { maskCopy } from '../../../public/scripts/mask/copy.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Resolve a dot-path against a nested object. */
function lookup(obj, dotted) {
  return dotted.split('.').reduce((node, part) => (node == null ? undefined : node[part]), obj);
}

test('falls back to the English copy when the pack has not loaded', () => {
  // The real `lang`/`tx` helpers hand back the fallback when the pack is missing.
  const copy = maskCopy((_key, fallback) => fallback);

  assert.equal(copy.title, 'Edit with Mask');
  assert.equal(copy.rerun, 'Regenerate');
  assert.equal(copy.done, 'Looks good');
  assert.equal(copy.refineTitle, 'Refine the edit');
  assert.equal(copy.refineHelpAria, 'What the refine step does');
  assert.match(copy.refineNote, /^Brush to reveal more of the edit/);
  assert.match(copy.refineNote, /won’t re-run the AI\.$/);
  // The long paragraph is the one that was duplicated verbatim; pin its shape so
  // a stray edit to the concatenation cannot quietly truncate it.
  assert.equal(copy.refineHelp.length, 369);
  assert.match(copy.refineHelp, /^This step just fine-tunes/);
  assert.match(copy.refineHelp, /won’t be in the final image\.$/);
  assert.ok(!/ {2}/.test(copy.refineHelp), 'no doubled spaces from the line joins');
});

test('prefers the translated string over the fallback', () => {
  const copy = maskCopy((key) => `translated:${key}`);
  assert.equal(copy.rerun, 'translated:pdf.maskEditor.rerun');
  assert.equal(copy.refineHelp, 'translated:pdf.maskEditor.refineHelp');
});

/** The keys maskCopy actually asks for, collected by running it. */
function requestedKeys() {
  const keys = [];
  maskCopy((key, fallback) => { keys.push(key); return fallback; });
  return keys;
}

// Cross-pack coverage is ALREADY a hard gate: test/server/static.test.js asserts
// every non-English pack carries all of english.json's keys. So this only checks
// the half that gate cannot — whether the key exists in english.json at all. A
// key absent there is absent from the base set, so static.test.js has nothing to
// compare against and stays green while the string falls back to English forever:
// invisible in English, untranslated in all ten other languages.
test('every key it asks for exists in english.json', () => {
  const english = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'public', 'languages', 'english.json'), 'utf8'),
  );
  const keys = requestedKeys();

  assert.ok(keys.length >= 7, 'sanity: the copy set was collected');
  const missing = keys.filter((key) => typeof lookup(english, key) !== 'string');
  assert.deepEqual(missing, [], 'not in english.json — see the comment above');
});

// static.test.js checks a key is PRESENT, never that it says anything. An empty
// string passes that gate and renders a blank button.
test('no key resolves to an empty or placeholder string in any pack', () => {
  const dir = path.join(repoRoot, 'public', 'languages');
  const keys = requestedKeys();
  const bad = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of keys) {
      const value = lookup(pack, key);
      // 'Loading...' is what the loader returns before a pack resolves; a pack
      // containing it literally would make `tx()` fall back forever.
      if (typeof value === 'string' && (!value.trim() || value === 'Loading...')) {
        bad.push(`${file}: ${key} = ${JSON.stringify(value)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
