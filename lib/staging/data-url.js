// Shape validation for the base64 image data URLs the studios post as JSON.
//
// Every endpoint that accepts an image in a JSON body has to answer the same
// question before it touches the payload: is this actually a data URL? Getting it
// wrong is not cosmetic. `'x'.split(',')[1]` is `undefined`, and
// `Buffer.from(undefined, 'base64')` throws ERR_INVALID_ARG_TYPE — which the route
// wrappers turn into a 500 with an error ref, a full stack in the log and (with
// SENTRY_DSN set) a reported production incident. A malformed client payload is a
// 400; it must not look like a server fault.
//
// The check lived only in routes/staging.js while lib/staging/mask-edit.js checked
// mere truthiness and lib/staging/segment.js checked only for a comma, so the three
// endpoints disagreed about what they accept. One definition, imported by all of
// them, is what keeps them from drifting apart again.

/**
 * A base64 image data URL prefix: `data:image/<subtype>;base64,`.
 * Deliberately narrow — `image/*` only, and base64 only, which is all any studio
 * sends and all the decode path below can handle.
 */
export const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Is this a base64 image data URL with a non-empty payload?
 *
 * The payload check matters on its own: `'data:image/png;base64,'` passes the
 * prefix test but decodes to a zero-length buffer, which fails much later and much
 * less clearly (inside sharp, or at the model call).
 *
 * @param {unknown} value - Candidate value straight off the request body.
 * @returns {boolean} True when `value` is a usable base64 image data URL.
 */
export function isImageDataUrl(value) {
  if (typeof value !== 'string' || !IMAGE_DATA_URL_RE.test(value)) return false;
  return value.length > value.indexOf(',') + 1;
}

/**
 * Decode the base64 payload of a data URL that has already passed isImageDataUrl.
 *
 * Splits on the FIRST comma rather than `split(',')[1]`: base64 itself never
 * contains a comma, but slicing from the index is what makes that a property of
 * the code rather than a coincidence.
 *
 * @param {string} dataUrl - A value for which isImageDataUrl returned true.
 * @returns {Buffer} The decoded bytes.
 */
export function decodeImageDataUrl(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}
