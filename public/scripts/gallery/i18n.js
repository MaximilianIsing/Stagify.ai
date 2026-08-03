// String lookup for the parts of the gallery that JS owns.
//
// Most of the page localizes itself from `data-lang` in the markup. These are the
// strings that cannot: the count line, the share statuses, the error wording, the meta
// labels and the alt/aria text on nodes built at runtime. They resolve against the
// loaded pack and fall back to English.
//
// The fallback is not a nicety. `window.LanguageSystem` does not exist until
// language-loader.js has fetched a pack, and the specs drive this module with no window
// at all — so every caller passes the English string, and English is therefore the
// behaviour when nothing is loaded rather than a blank page or a raw key.

/** The live pack accessor, or null before it loads / under test. */
function system() {
  if (typeof window === 'undefined') return null;
  const sys = /** @type {any} */ (window).LanguageSystem;
  return sys && typeof sys.getText === 'function' ? sys : null;
}

/**
 * Substitute `{name}` placeholders.
 * @param {string} template @param {Record<string, string | number>} vars
 */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

/**
 * One string, localized if the pack has it.
 * @param {string} key - Dot path, e.g. `gallery.share.created`.
 * @param {string} fallback - The English text. Required, deliberately.
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, fallback, vars = {}) {
  const sys = system();
  const value = sys ? sys.getText(key, undefined) : undefined;
  return fill(typeof value === 'string' ? value : fallback, vars);
}

/**
 * Pick a plural form.
 *
 * English and the Romance/Germanic packs need one/other. Russian needs one/few/other
 * (1 комната · 2-4 комнаты · 5+ комнат), and getting it wrong is visible on almost every
 * count. Rather than teach this module which languages are Slavic — a list that would
 * rot the moment one is added — the PACK declares it: a pack that supplies a `few` form
 * is read with the Slavic rule, one that does not is read as one/other.
 *
 * That keeps English exactly as it was, including the case a naive shared rule breaks:
 * 21 is `one` in Russian but `other` in English.
 *
 * @param {string} base - Dot path of the group, e.g. `gallery.count`.
 * @param {number} count
 * @param {{ one: string, other: string }} fallbacks - English forms.
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
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
