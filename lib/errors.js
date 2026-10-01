// Reading a caught value safely.
//
// Under `strict` a catch binding is `unknown`: JavaScript can throw anything (a
// string, a plain object, undefined), so `err.message` is not guaranteed to exist.
// These helpers are the one place that narrows it, so a catch block stays a one-liner
// instead of repeating `err instanceof Error ? ... : ...` at every site.
//
// Dependency-free on purpose: the bootstrap layer (load-env.js, runtime-flags.js)
// that runs beneath the logger imports it too.

/**
 * The message of a caught value: its `.message` when it carries a string one,
 * otherwise the value itself as a string.
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

/**
 * The `.code` of a caught value (Node system errors, SDK errors, our own tagged
 * errors), or undefined when it has none.
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

/**
 * The stack of a caught Error, or undefined for anything else.
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function errorStack(err) {
  return err instanceof Error ? err.stack : undefined;
}
