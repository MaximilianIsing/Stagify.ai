// Stagify.ai — "do we actually know who this visitor is yet?"
//
// Two places pre-paint a page from something cached in localStorage, because the only
// authority on the visitor (`GET /api/auth/me`) is a network round trip away and the
// browser paints long before it answers:
//
//   • scripts/preview-gate.js   — the Pro page shape on all four preview pages, from the
//                                 cached plan (ai-designer-gate.js carries the same body
//                                 inline, because its viewport redirect has to run first)
//   • scripts/session-class.js  — the nav's Gallery tab, from the mere presence of a token
//
// Both are GUESSES, and a guess has to be given up the moment the real answer lands — but
// not one moment earlier, or the flash they exist to prevent comes straight back. That
// timing question is this predicate, and it lives here because getting it wrong in either
// direction is invisible on screen and both owners need exactly the same answer.

/**
 * Has the visitor's identity been established?
 *
 * Two cases count as known, and the second is the one that is easy to forget:
 *
 *   - `user` is set, so /api/auth/me answered (or a render response handed back a fresh
 *     account object);
 *   - there is no token, so there is nothing to answer and the visitor is signed out.
 *     This is also the branch that runs on sign-out, which has to take the guessed-at UI
 *     away again.
 *
 * Everything else — a token present, no user yet — is the in-flight window the guesses
 * exist to cover. Note this is deliberately NOT "is the visitor signed in": a signed-out
 * visitor is perfectly well known, and treating unknown as signed-out is precisely the
 * bug (the pre-paint state would be undone on the first sync, before the request that
 * would confirm it has even been sent).
 *
 * @param {{ user?: unknown, getToken?: () => string | null } | null | undefined} auth - window.StagifyAuth, or null on a page that has none.
 * @returns {boolean} True once the answer is in and any guess must give way.
 */
export function authSettled(auth) {
  if (!auth) return true;
  if (auth.user) return true;
  return !(typeof auth.getToken === 'function' && auth.getToken());
}
