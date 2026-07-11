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

/**
 * HTML-escape a string by round-tripping through a detached element's
 * textContent. Returns '' for falsy input.
 * @param {string} s
 * @returns {string}
 */
export function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
