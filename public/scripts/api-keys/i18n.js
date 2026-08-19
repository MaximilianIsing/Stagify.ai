// String lookup for the parts of the API dashboard that JS owns.
//
// Almost everything on this page is built at runtime — the rail, both account panes and
// every key pane — so `data-lang` in the markup can only cover the page title, the
// search box, the create button and the dialog. Everything else resolves here, against
// the loaded pack, with the English text as a required fallback argument.
//
// THE FALLBACK IS NOT A NICETY. `window.LanguageSystem` does not exist until
// language-loader.js has fetched a pack, and the unit specs drive these islands with no
// window at all — so English is the behaviour when nothing is loaded, rather than a
// blank pane or a raw key path on screen.
//
// This is a near-copy of scripts/gallery/i18n.js, and deliberately not an import of it:
// that file is the gallery's, the two pages have no other shared module, and a shared
// "i18n utils" would be a third home for a rule that already lives in language-loader.js.
// If a third page needs this, THAT is when to extract it.

import { LANG_BCP47 } from '../locale-data.js';

/** The live pack accessor, or null before it loads / under test. */
function system() {
  if (typeof window === 'undefined') return null;
  const sys = /** @type {any} */ (window).LanguageSystem;
  return sys && typeof sys.getText === 'function' ? sys : null;
}

/**
 * Substitute `{name}` placeholders.
 * @param {string} template - The string, translated or English.
 * @param {Record<string, string | number>} vars - Values by placeholder name.
 * @returns {string} The filled string.
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

/**
 * One string, localized if the pack has it.
 * @param {string} key - Dot path, e.g. `apiKeys.usage.byKey`.
 * @param {string} fallback - The English text. Required, deliberately.
 * @param {Record<string, string | number>} [vars] - Placeholder values.
 * @returns {string} The string to show.
 */
export function t(key, fallback, vars = {}) {
  const sys = system();
  const value = sys ? sys.getText(key, undefined) : undefined;
  return fill(typeof value === 'string' ? value : fallback, vars);
}

/**
 * Pick a plural form.
 *
 * The PACK decides the rule, not a hard-coded list of Slavic languages: a pack that
 * supplies a `few` form is read with the 1 / 2-4 / 5+ rule, one that does not as
 * `count === 1 ? one : other`. Only russian.json has `few`. That keeps English's
 * "21 credits" right, which a shared Slavic rule would break — 21 is `one` in Russian.
 * Same reasoning, and the same code, as the gallery's.
 * @param {string} base - Dot path of the group, e.g. `apiKeys.list.credits`.
 * @param {number} count - How many.
 * @param {{ one: string, other: string }} fallbacks - The English forms.
 * @param {Record<string, string | number>} [vars] - Extra placeholder values.
 * @returns {string} The filled form.
 */
export function plural(base, count, fallbacks, vars = {}) {
  const sys = system();
  const get = (form) => {
    const value = sys ? sys.getText(`${base}.${form}`, undefined) : undefined;
    return typeof value === 'string' ? value : undefined;
  };

  const slavic = get('few') !== undefined;
  let form;
  if (slavic) {
    const tens = count % 10;
    const hundreds = count % 100;
    if (tens === 1 && hundreds !== 11) form = 'one';
    else if (tens >= 2 && tens <= 4 && (hundreds < 12 || hundreds > 14)) form = 'few';
    else form = 'other';
  } else {
    form = count === 1 ? 'one' : 'other';
  }

  const value = get(form) ?? get('other');
  const template = value ?? (form === 'one' ? fallbacks.one : fallbacks.other);
  return fill(template, { ...vars, count });
}

/**
 * The BCP-47 tag to format dates and numbers with.
 *
 * The chosen language, not the browser's locale: this page swaps languages in place, and
 * a Spanish page printing "Mar 4, 2026" under Spanish copy is the same half-translated
 * result the switcher exists to avoid. Falls back to the browser when the choice is
 * unset, unrecognised, or storage is unreadable.
 * @returns {string | undefined} A BCP-47 tag, or undefined for the browser default.
 */
export function locale() {
  try {
    const chosen = window.localStorage.getItem('selectedLanguage');
    return chosen && LANG_BCP47[chosen] ? LANG_BCP47[chosen] : undefined;
  } catch {
    return undefined;
  }
}
