// Turns an /api/validate-image rejection into the sentence the user actually sees.
// Shared by both studios (scripts/app.js and scripts/masking-studio/upload.js) so the
// rejection copy can never drift between them.
//
// The server answers with a stable category `code` (PERSON_PORTRAIT, FOOD, …) plus the
// canonical ENGLISH `reason`. We look the code up in the language pack first and fall
// back to the server's English. That ordering is the whole point: adding
// `errors.unstageable.<CODE>` to public/languages/*.json localizes this with NO change
// to this file, and a language that lacks the key degrades to English instead of blank.

// Last-resort copy: shown only when the server sent neither a usable code nor a reason
// (e.g. a hand-rolled client, or an older cached bundle talking to a newer server).
export const DEFAULT_UNSTAGEABLE_MESSAGE =
  "This doesn't look like a room, space, or piece of furniture. Please upload a photo of an interior room, exterior space, or furniture you'd like to stage.";

/**
 * Resolve the display message for a validation rejection.
 * @param {{ code?: string | null, reason?: string } | null | undefined} result - The /api/validate-image response body.
 * @returns {string} The localized (or English-fallback) message to show.
 */
export function unstageableMessage(result) {
  const english = (result && result.reason) || DEFAULT_UNSTAGEABLE_MESSAGE;
  const code = result && result.code;
  if (!code || !window.LanguageSystem) return english;
  // getText's second argument is returned verbatim when the key is missing OR the pack
  // has not loaded yet, so an untranslated language degrades to the server's English
  // rather than to the 'Loading...' placeholder.
  return window.LanguageSystem.getText('errors.unstageable.' + code, english);
}
