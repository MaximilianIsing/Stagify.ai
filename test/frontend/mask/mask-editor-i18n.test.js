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

test('a dialog that has not been built yet is a no-op, not a crash', () => {
  // updateMaskEditorTranslations() also runs on language change, which can happen
  // before the dialog has ever been opened (it is created lazily on first open).
  withPack({ 'common.close': 'Cerrar' });
  assert.doesNotThrow(() => updateMaskEditorTranslations());
});
