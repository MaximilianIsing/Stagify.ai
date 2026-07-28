// Unit tests for the mask editor's shared phase copy (public/scripts/mask/copy.js).
//
// Two things worth pinning, neither of which e2e can see:
//
//   1. The English fallbacks. In a browser the language pack is loaded, so
//      `lang()` returns the translated string and the fallback is never reached —
//      an e2e assertion on the rendered text passes no matter what the fallback
//      says. Only a direct test can tell whether the fallback survived being
//      moved into one place.
//   2. That every key actually EXISTS in english.json. A typo'd key falls back to
//      the English default forever: invisible in English, and untranslated in all
//      ten other languages. That is the failure this module could most easily
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
  assert.match(copy.refineNote, /won't re-run the AI\.$/);
  // The long paragraph is the one that was duplicated verbatim; pin its shape so
  // a stray edit to the concatenation cannot quietly truncate it.
  assert.equal(copy.refineHelp.length, 369);
  assert.match(copy.refineHelp, /^This step just fine-tunes/);
  assert.match(copy.refineHelp, /won't be in the final image\.$/);
  assert.ok(!/ {2}/.test(copy.refineHelp), 'no doubled spaces from the line joins');
});

test('prefers the translated string over the fallback', () => {
  const copy = maskCopy((key) => `translated:${key}`);
  assert.equal(copy.rerun, 'translated:pdf.maskEditor.rerun');
  assert.equal(copy.refineHelp, 'translated:pdf.maskEditor.refineHelp');
});

test('every key it asks for exists in english.json', () => {
  const english = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'public', 'languages', 'english.json'), 'utf8'),
  );
  const requested = [];
  maskCopy((key, fallback) => { requested.push(key); return fallback; });

  assert.ok(requested.length >= 7, 'sanity: the copy set was collected');
  const missing = requested.filter((key) => typeof lookup(english, key) !== 'string');
  assert.deepEqual(missing, [],
    'these keys are not in english.json, so they would show the English fallback ' +
    'in every language — invisible in English, untranslated everywhere else');
});
