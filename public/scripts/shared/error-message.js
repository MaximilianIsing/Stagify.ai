// The browser twin of lib/errors.js `errorMessage`: reads a caught value safely.
//
// Under `strict` a catch binding is `unknown`, because JavaScript can throw anything.
// This narrows it once, so a catch block that wants "the error's message, or this
// localized fallback" stays a one-liner instead of `err && err.message ? ... : ...`.

/**
 * The `.message` of a caught value when it carries a non-empty string one,
 * otherwise `fallback`.
 * @param {unknown} err
 * @param {string} [fallback='']
 * @returns {string}
 */
export function errorMessage(err, fallback = '') {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return err.message;
  }
  return fallback;
}
