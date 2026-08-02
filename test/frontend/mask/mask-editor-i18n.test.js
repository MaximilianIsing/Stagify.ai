// Behaviour of updateMaskEditorTranslations() — the AI Designer mask dialog is built
// in JS, so this function is the only thing that localizes its chrome.
//
// The close button matters most: its only visible text is a "×" glyph that is hidden
// from assistive tech, so the aria-label set here IS the button's accessible name.
// If the lookup ever returns the raw key, a screen-reader user hears "common.close".
//
// e2e cannot cover the fallback branches — the browser always has a pack loaded, so
// getText never returns a key echo there. That is why these are unit tests.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installMaskDom } from '../../helpers/mask-dom.js';
import { updateMaskEditorTranslations } from '../../../public/scripts/ai-designer/mask-editor-i18n.js';

let dom;

/** The slice of the dialog this function touches, with ids registered. */
function buildDialog() {
  dom.el('h2', 'mask-editor-title', 'mask-editor-title');
  const close = dom.el('button', 'mask-editor-close', 'mask-editor-close');
  close.setAttribute('aria-label', 'Close'); // the hard-coded English in the template
  return { close };
}

/** Install a LanguageSystem that resolves `map`, echoing the key otherwise. */
function withPack(map) {
  globalThis.window.LanguageSystem = {
    isLoaded: () => true,
    getText: (key) => (key in map ? map[key] : key),
  };
}

beforeEach(() => { dom = installMaskDom(); });
afterEach(() => { dom.restore(); delete globalThis.window; });

test('the close button gets its accessible name from common.close', () => {
  const { close } = buildDialog();
  withPack({ 'common.close': 'Fermer' });

  updateMaskEditorTranslations();

  assert.equal(close.getAttribute('aria-label'), 'Fermer');
});

test('a pack missing common.close falls back to English, never the raw key', () => {
  const { close } = buildDialog();
  withPack({}); // every lookup echoes its key

  updateMaskEditorTranslations();

  assert.equal(
    close.getAttribute('aria-label'),
    'Close',
    'a key echo would be announced verbatim — "common.close"',
  );
});

test('nothing is touched before the language pack has loaded', () => {
  const { close } = buildDialog();
  globalThis.window.LanguageSystem = { isLoaded: () => false, getText: () => 'Loading...' };

  updateMaskEditorTranslations();

  assert.equal(close.getAttribute('aria-label'), 'Close', 'the template default survives');
});

/** The two markers flanking the brush slider, as the template builds them. */
function buildBrushEnds() {
  const make = (key, english) => {
    const el = dom.el('span', null, 'mask-editor-brush-end');
    el.setAttribute('data-i18n', key);
    el.textContent = english;
    return el;
  };
  return {
    small: make('pdf.maskEditor.brushSmall', 'Small'),
    large: make('pdf.maskEditor.brushLarge', 'Large'),
  };
}

// The brush slider is a relative scale with no number beside it any more
// (public/scripts/mask/brush-scale.js), so these two words are the only thing
// saying which end is which. Their data-i18n attributes are inert — this dialog
// is built at runtime, long after the attribute pass has run — so an untranslated
// end label is a control with no legend at all in ten of the eleven languages.
test('the brush slider ends are localized, despite their data-i18n being inert', () => {
  buildDialog();
  const { small, large } = buildBrushEnds();
  withPack({ 'pdf.maskEditor.brushSmall': 'Petit', 'pdf.maskEditor.brushLarge': 'Grand' });

  updateMaskEditorTranslations();

  assert.equal(small.textContent, 'Petit');
  assert.equal(large.textContent, 'Grand');
});

test('an end label falls back to its English, never the raw key', () => {
  buildDialog();
  const { small, large } = buildBrushEnds();
  withPack({}); // every lookup echoes its key

  updateMaskEditorTranslations();

  assert.equal(small.textContent, 'Small', 'a key echo would render "pdf.maskEditor.brushSmall"');
  assert.equal(large.textContent, 'Large');
});

test('a dialog that has not been built yet is a no-op, not a crash', () => {
  // updateMaskEditorTranslations() also runs on language change, which can happen
  // before the dialog has ever been opened (it is created lazily on first open).
  withPack({ 'common.close': 'Cerrar' });
  assert.doesNotThrow(() => updateMaskEditorTranslations());
});
