// Click-to-copy for the colour swatches in /about#brand-kit.
//
// The module is small because both halves already existed: scripts/shared/clipboard.js owns
// the secure-context/execCommand split — and returns whether the copy ACTUALLY
// happened, which matters here, since telling somebody a hex is on their clipboard
// when it is not is worse than saying nothing — and scripts/shared/toast.js owns the message
// channel.
//
// The two messages are read out of hidden spans in about.html rather than written
// here, so language-loader.js translates them along with every other string on the
// page and the keys live in the same about.* block in public/languages/*.json. `{hex}`
// is the one substitution. If the span is missing, or the loader has not run yet, the
// English default baked into the markup is used; if the span is absent entirely the
// message degrades to the bare hex rather than to "undefined".
//
// Dependencies are injectable for the same reason clipboard.js's are: this file is
// otherwise a DOM side effect, and test/frontend/brand-kit.test.js drives it with a
// shim instead of a browser.

import { copyText } from '../shared/clipboard.js';
import { showToast } from '../shared/toast.js';

/**
 * Fill a message template. Exported for the test; `{hex}` is the only placeholder.
 * @param {string|null|undefined} template @param {string} hex @returns {string}
 */
export function formatMessage(template, hex) {
  const text = template?.trim();
  return text ? text.replace('{hex}', hex) : hex;
}

/**
 * Wire the swatch list. One delegated listener on the <ul>, not one per button.
 *
 * @param {object} [deps]
 * @param {Document} [deps.doc]
 * @param {(text: string) => Promise<boolean>} [deps.copy]
 * @param {(message: string, type?: 'error'|'success') => void} [deps.toast]
 * @returns {boolean} Whether a swatch list was found and wired.
 */
export function initBrandKit({ doc = document, copy = copyText, toast = showToast } = {}) {
  const list = doc.querySelector('[data-brand-swatches]');
  if (!list) return false;

  list.addEventListener('click', (event) => {
    const target = /** @type {any} */ (event).target;
    const button = target?.closest?.('.brand-swatch');
    const hex = button?.dataset?.copy;
    if (!hex) return;

    copy(hex).then((ok) => {
      const span = doc.querySelector(ok ? '[data-brand-copy-ok]' : '[data-brand-copy-fail]');
      toast(formatMessage(span?.textContent, hex), ok ? 'success' : 'error');
    });
  });
  return true;
}

// Self-start in a browser only; under `node --test` there is no document and the test
// calls initBrandKit() itself with a shim.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initBrandKit(), { once: true });
  } else {
    initBrandKit();
  }
}
