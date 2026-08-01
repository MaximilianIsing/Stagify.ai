// The reply channel's data boundary — the second parser on this page, and it exists for
// the same reason as model.js: one function turns whatever the server sent into a value
// with fixed types, and nothing downstream writes `?.` or `|| ''` again.
//
// TWO COERCIONS CARRY REAL BEHAVIOUR, the rest are hygiene:
//
//  1. A VERDICT IS ONE OF EXACTLY TWO STRINGS, and a response carrying anything else is
//     DROPPED rather than rendered. The verdict is what the panel paints its whole state
//     from; an unrecognised third value would fall through every branch and leave a room
//     showing the blank form while the server holds an answer for it — the one failure
//     that makes a seller answer twice.
//  2. `full` IS DERIVED, NOT MERELY READ. A server that sends `used`/`limit` and forgets
//     the flag must still stop the page offering a form that will 409. `limit > 0` guards
//     the "no limit configured" case, where 0 >= 0 would otherwise lock the page shut on
//     first load.
//
// THE LISTING-LEVEL ANSWER IS `roomKey: null` on the wire and `''` as a map key. Both
// spellings exist on purpose: `null` is what the API contract says a whole-listing reply
// carries, and `''` is what a Map can actually key on next to the room keys without a
// second lookup path. `slotKey` is the only place the two meet.

/** Server-side clamp on a note, mirrored here so nobody's text is silently truncated. */
export const NOTE_LIMIT = 500;

/** Server-side clamp on the viewer's name. Generous — it is a display label, not a key. */
export const LABEL_LIMIT = 120;

/**
 * @typedef {'approved'|'changes'} Verdict
 */

/**
 * @typedef {object} FeedbackResponse
 * @property {string|null} roomKey - null for the whole-listing answer.
 * @property {Verdict} verdict
 * @property {string} note - '' for an approval.
 * @property {string} viewerLabel - '' when the viewer never named themselves.
 */

/**
 * @typedef {object} Allowance
 * @property {number} used
 * @property {number} limit - 0 means "no ceiling configured".
 * @property {boolean} full
 */

/**
 * Coerce any value to a trimmed string. Same rules as model.js's `text`, kept local so
 * the two boundaries can diverge if the endpoints ever do.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Coerce to a non-negative integer. A missing or nonsense count is 0, never NaN — a NaN
 * would make every `>=` comparison below false and quietly disable the ceiling.
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The Map key for a room's answer. The whole-listing answer keys on ''.
 * @param {string|null|undefined} roomKey
 * @returns {string}
 */
export function slotKey(roomKey) {
  return typeof roomKey === 'string' && roomKey ? roomKey : '';
}

/**
 * Trim and clamp a note to the server's own limit. Called on the way IN (rendering what
 * the server stored) and on the way OUT (what the textarea holds), so the two can never
 * disagree about what fits.
 * @param {unknown} value
 * @returns {string}
 */
export function clampNote(value) {
  return text(value).slice(0, NOTE_LIMIT);
}

/**
 * Trim and clamp the viewer's name.
 * @param {unknown} value
 * @returns {string}
 */
export function clampLabel(value) {
  return text(value).slice(0, LABEL_LIMIT);
}

/**
 * Narrow one stored response. Returns null for anything whose verdict is not one of the
 * two the UI can paint — see the header.
 * @param {unknown} raw
 * @returns {FeedbackResponse|null}
 */
export function normalizeResponse(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const verdict = text(src.verdict);
  if (verdict !== 'approved' && verdict !== 'changes') return null;
  const roomKey = text(src.roomKey);
  return {
    roomKey: roomKey || null,
    verdict,
    note: clampNote(src.note),
    viewerLabel: clampLabel(src.viewerLabel),
  };
}

/**
 * Narrow the response allowance. Total: every input, including `null`, produces one.
 * @param {unknown} raw
 * @returns {Allowance}
 */
export function normalizeAllowance(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const used = count(src.used);
  const limit = count(src.limit);
  return { used, limit, full: src.full === true || (limit > 0 && used >= limit) };
}

/**
 * Narrow a list of stored responses, dropping the unusable ones.
 * @param {unknown} raw
 * @returns {FeedbackResponse[]}
 */
export function normalizeResponses(raw) {
  /** @type {FeedbackResponse[]} */
  const out = [];
  for (const candidate of Array.isArray(raw) ? raw : []) {
    const response = normalizeResponse(candidate);
    if (response) out.push(response);
  }
  return out;
}

/**
 * Index responses by slot, LAST ONE WINNING. The endpoint returns everything this link has
 * ever said, so a seller who approved a room and then changed their mind has two rows for
 * it; the page must show the second. Iterating forward and overwriting is what makes
 * "latest" the answer without depending on a timestamp field the contract does not promise.
 * @param {FeedbackResponse[]} responses
 * @returns {Map<string, FeedbackResponse>}
 */
export function indexResponses(responses) {
  /** @type {Map<string, FeedbackResponse>} */
  const map = new Map();
  for (const response of responses) map.set(slotKey(response.roomKey), response);
  return map;
}

/**
 * The name to prefill the "Your name" field with: the most recent one this link used.
 * Asked once, remembered, never required.
 * @param {FeedbackResponse[]} responses
 * @returns {string}
 */
export function rememberedLabel(responses) {
  let label = '';
  for (const response of responses) if (response.viewerLabel) label = response.viewerLabel;
  return label;
}
