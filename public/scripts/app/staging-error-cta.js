// The one writer for the Exterior Studio button inside #staging-error-viewer.
//
// It lives here rather than in app.js for two reasons. The dull one: app.js is at 644 of
// its 650-line cap (eslint.config.js) and it is not grandfathered, so the explanation
// literally does not fit there. The real one: this is the same pure-rule + single
// idempotent writer shape as staging-menu.js and exterior-studio/access.js, and that
// shape is what makes the HIDE path impossible to forget. showStagingError() calls this
// on EVERY rejection, so a FOOD verdict actively clears a button a previous EXTERIOR
// verdict left on screen. Deciding at the six call sites instead would leave five of them
// responsible for tidying up after the sixth.
//
// Known and accepted: the button is painted from the plan at paint time, and
// applyUserToUI() does not know this panel exists. A free user who upgrades in another tab
// with the panel still open keeps the "Get Stagify+" label — the link works, and it lands
// on the page that sells the thing they just bought. Wiring a new fan-out target into
// auth.js for that window is not worth it.
import { unstageableCta } from '../unstageable-cta.js';

/**
 * Paint (or clear) the call-to-action for one rejection verdict.
 *
 * @param {{ code?: string | null } | null | undefined} verdict - The verdict being shown, or null when the panel is closing.
 * @param {HTMLAnchorElement | null} [el] - The anchor; resolved from the document when omitted.
 * @returns {boolean} Whether the button ended up visible.
 */
export function syncStagingErrorCta(verdict, el) {
  const cta = /** @type {HTMLAnchorElement | null} */ (
    el || document.getElementById('staging-error-viewer-cta')
  );
  // Absent on every page but index.html, and absent in unit tests that only care about
  // the sentence. Not an error: the panel without the button is the normal case — every
  // category except EXTERIOR leaves it as a message with no button at all, because
  // "Upload Another" in the viewer header already covers "try a different photo".
  if (!cta) return false;

  const action = unstageableCta(verdict);
  if (!action) {
    cta.classList.add('hidden');
    return false;
  }

  cta.href = action.href;
  // Move the KEY, not just the text. applyLanguageToElements() repaints every [data-lang]
  // node on a language switch and WIPES textContent first, so a label written without
  // moving the attribute is silently replaced by the other plan state's copy the moment
  // the user changes language — a free account would be handed an "Open the Exterior
  // Studio" button pointing at the pricing page.
  cta.setAttribute('data-lang', action.labelKey);
  cta.textContent = window.LanguageSystem
    ? window.LanguageSystem.getText(action.labelKey, action.fallbackLabel)
    : action.fallbackLabel;
  cta.classList.remove('hidden');
  return true;
}
