// How the Listing Studio renders a judge's verdict: the score scale, the "we never
// checked" state, and the sentence that explains a low consistency number.
//
// Split out of ./render-grid.js because all four helpers are pure string/number work over
// what the backend stored, and the grid file was at the 650-line cap. Nothing here touches
// the DOM.
//
// THE SCALE WAS MISDOCUMENTED, WHICH IS WHY IT WAS MISRENDERED. `formatScore`'s docblock
// said "Scores are 0..1" while the judges emit `SCORE: <0-100>`, so the grid printed
// `Quality 100.00 / Consistency 62.00` — two decimals of false precision on an integer
// scale, with no unit, no scale and no threshold anywhere near it.

/** What the grid shows for a score the judges never produced. See formatScore. */
export const UNCHECKED_SCORE_LABEL = 'Not checked';

/**
 * Consistency at or below this is called out as low.
 *
 * The judges have no threshold of their own — they emit a number and the pipeline stores
 * it — so this is a presentation decision, made here and once: below 70/100 the frame is
 * visibly off its room's look often enough to be worth an operator's eye.
 */
export const SCORE_FLOOR = 70;

/**
 * A score as the grid shows it.
 *
 * SCORES ARE 0..100, NOT 0..1. This docblock claimed 0..1 while the judges emit
 * `SCORE: <0-100>`, and the grid rendered the raw number through `toFixed(2)` — so a
 * perfect frame read "Quality 100.00" and a mediocre one "Consistency 62.00", unlabelled,
 * with no scale and nothing to compare against. Two decimal places on an integer scale is
 * also false precision.
 *
 * `null` is NOT the same as a low score and not the same as an em dash. The backend's own
 * type comment insists that "unchecked must not be indistinguishable from checked and
 * clean", and an em dash is exactly that: identical to the placeholder a hero frame shows
 * for a score it never had. So a missing score says so in words.
 * @param {number|null|undefined} value
 * @returns {string} e.g. `'84 / 100'`, or 'Not checked'.
 */
export function formatScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNCHECKED_SCORE_LABEL;
  return `${Math.round(value)} / 100`;
}

/**
 * Is this score low enough to flag? A missing score is not low — it is unknown.
 * @param {number|null|undefined} value
 * @returns {boolean}
 */
export function isLowScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value <= SCORE_FLOOR;
}

/**
 * The sentence naming which bible pieces a render drifted on, or '' when none did.
 *
 * This is the actual explanation for a low consistency score, and without it the number is
 * a grade with no feedback: the operator can see 62/100 but not that the sofa and the rug
 * are the reason. Slot names come from the bible and are lowercase single words, so the
 * first is capitalized for the sentence.
 * @param {string[]|null|undefined} slots - `render.extra.mismatchedSlots`.
 * @returns {string}
 */
export function mismatchSentence(slots) {
  const names = (Array.isArray(slots) ? slots : [])
    .map((slot) => String(slot === null || slot === undefined ? '' : slot).trim())
    .filter(Boolean);
  if (!names.length) return '';
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const sentence = `${list} drifted from the look bible.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The slots a render drifted on, tolerating whatever `extra` actually holds.
 *
 * `extra` is a JSON column, so it can be null, a non-object, or carry a `mismatchedSlots`
 * that is not an array. Read as a boundary rather than trusted to match its type.
 * @param {import('./state.js').PjRender|null|undefined} render
 * @returns {string[]}
 */
export function mismatchedSlots(render) {
  const extra = render && render.extra;
  if (!extra || typeof extra !== 'object') return [];
  const slots = /** @type {any} */ (extra).mismatchedSlots;
  return Array.isArray(slots) ? slots : [];
}
