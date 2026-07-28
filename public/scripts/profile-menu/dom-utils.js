// Shared helpers for the profile-menu island and its auth-modal sub-module.
// Both are pure and DOM-only — no app state — so they live outside either factory.

/**
 * Translate `key`, falling back to `fallback` until the language system has
 * loaded. Interpolates `{name}` placeholders from `vars` when provided.
 * @param {string} key
 * @param {string} fallback
 * @param {Record<string, string>} [vars]
 * @returns {string}
 */
export function lang(key, fallback, vars) {
  var text = fallback;
  if (window.LanguageSystem && typeof window.LanguageSystem.getText === 'function') {
    var got = window.LanguageSystem.getText(key);
    if (typeof got === 'string' && got !== 'Loading...') text = got;
  }
  if (vars) {
    Object.keys(vars).forEach(function (k) {
      text = text.split('{' + k + '}').join(vars[k]);
    });
  }
  return text;
}

// HTML escaping, re-exported under this module's historic name so the menu's
// call sites are unchanged. It used to round-trip through a detached element's
// textContent, which does not escape quotes — and the menu interpolates into
// `title="…"` and `aria-label="…"`, where an apostrophe in a translated string
// would have closed the attribute early.
export { escapeHtml as esc } from '../escape-html.js';
