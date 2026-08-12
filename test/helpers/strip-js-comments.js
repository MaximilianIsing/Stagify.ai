// Quote-aware JS comment stripper, shared by the source-scanning drift guards.
//
// Several guards in test/ assert on the ORDER or PRESENCE of calls in a source file,
// and every one of those files explains the rule it implements in prose directly above
// the code. A scan over un-stripped source therefore matches the explanation and keeps
// passing after the code is deleted — so stripping is what makes those guards real.
//
// It has to be quote-aware, not a pair of regexes. `src.replace(/\/\*[\s\S]*?\*\//g, '')`
// looks equivalent and is not: lib/http/app-middleware.js carries CSP directives like
// 'https://*.stripe.com', where the `//*` reads as an opening block comment and the
// naive version silently ate 7.6 KB of real middleware — including the express.static
// mount a guard was written to protect. Same class of bug for '//' inside any URL.
//
// Mis-stripping fails safe: it can only ever LOSE a real call, which trips a
// "found too few" assertion loudly rather than hiding a regression.

/**
 * Remove line and block comments, leaving string and template literals intact.
 *
 * @param {string} src JavaScript source.
 * @returns {string} The source with comment bodies removed.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  /** @type {string | null} */
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}
