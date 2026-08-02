// Drift guard between the mask editors' chrome and the language packs.
//
// Nothing else covers this. The pack-parity tests that exist are scoped to one
// namespace each (room-types-i18n.test.js, unstageable-i18n.test.js), and the
// lookup path degrades quietly: `data-lang` leaves the English in the markup
// alone when a key is missing, and the AI Designer's imperative localizer
// (public/scripts/ai-designer/mask-editor-i18n.js) skips the assignment. So a
// key added to english.json and forgotten in the other ten ships green and
// renders English to every non-English visitor.
//
// The brush-size control is the reason this file exists: its slider is a
// relative scale now (public/scripts/mask/brush-scale.js) with Small/Large
// markers at each end instead of a "50 px" readout, which put two new
// translated strings onto three separate surfaces at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

// English is served at the root as static files rather than through a LOCALES
// entry, so pull it in explicitly — it is the source of truth for the key set.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];

const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));
const maskEditorBlock = (lang) => packFor(lang).pdf?.maskEditor;

const ENGLISH = maskEditorBlock('english');
const KEYS = Object.keys(ENGLISH);

test('english.json defines the mask-editor block the other packs are measured against', () => {
  assert.ok(ENGLISH, 'english.json has no pdf.maskEditor block');
  assert.ok(KEYS.length > 0, 'english.json has an empty pdf.maskEditor block');
  // The two ends of the brush slider carry no other signal — there is no number
  // beside it any more — so an untranslated end label is a dead control.
  for (const key of ['brushSize', 'brushSmall', 'brushLarge']) {
    assert.equal(typeof ENGLISH[key], 'string', `english.json is missing pdf.maskEditor.${key}`);
  }
});

test('every language pack translates every mask-editor string', () => {
  for (const lang of LANGS) {
    const block = maskEditorBlock(lang);
    assert.ok(block, `${lang}.json has no pdf.maskEditor block`);
    for (const key of KEYS) {
      const value = block[key];
      assert.equal(typeof value, 'string', `${lang}.json is missing pdf.maskEditor.${key}`);
      assert.ok(value.trim().length > 0, `${lang}.json has an empty pdf.maskEditor.${key}`);
    }
  }
});

test('no language pack carries a mask-editor key English has dropped', () => {
  // Stale copy translators keep maintaining for nothing; usually the fossil of a
  // control that was renamed or removed on one surface only.
  for (const lang of LANGS) {
    for (const key of Object.keys(maskEditorBlock(lang))) {
      assert.ok(KEYS.includes(key), `${lang}.json has stale pdf.maskEditor.${key}`);
    }
  }
});

test('non-English packs are actually translated, not copies of the English copy', () => {
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const block = maskEditorBlock(lang);
    const copied = KEYS.filter((key) => block[key] === ENGLISH[key]);
    assert.equal(copied.length, 0, `${lang}.json still has the English string for: ${copied.join(', ')}`);
  }
});

// Comments are stripped before scanning: a guard that greps for a token
// otherwise passes on the strength of a nearby comment that happens to name it,
// including a comment explaining the very thing that was deleted.
const stripComments = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')        // HTML
  .replace(/\/\*[\s\S]*?\*\//g, '')       // JS block
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // JS line, leaving :// in URLs alone

// The one part no build step can generate: three editors each render their own
// copy of this control, and only two of them share a stylesheet or a module.
const SURFACES = [
  'public/index.html',                            // staging tool / Basic Mask
  'public/masking-studio.html',                   // Masking Studio
  'public/scripts/ai-designer/mask-editor.js',    // AI Designer (markup built at runtime)
];

test('all three brush sliders reference the end-label keys', () => {
  for (const rel of SURFACES) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const key of ['pdf.maskEditor.brushSmall', 'pdf.maskEditor.brushLarge']) {
      assert.ok(src.includes(key), `${rel} does not reference ${key}`);
    }
    // The px readout each of these used to carry is gone; the slider is relative
    // now, so a resurrected "50 px" span would be lying about the brush.
    assert.ok(
      !/brush-size(-display)?["'\s]/.test(src),
      `${rel} still has a pixel readout beside the brush slider`,
    );
  }
});
