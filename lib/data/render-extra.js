// What a staged render is, beyond its columns: which studio made it, the one setting worth
// putting in its name, and the photo it came from. Pure — no filesystem, no network, no
// database, exactly like its peer lib/data/object-keys.js.
//
// WHY extra_json AND NOT THREE NEW COLUMNS
// There is no migration runner (a documented tradeoff — docs/reference/data-stores.md), so
// a new field rides in `extra_json` and anything that truly needs a column gets a guarded
// ALTER. See the header of lib/data/gallery-schema.js. `staged_renders.extra_json` has
// existed since the table did and nothing had ever written it; this is its first use.
//
// WHY THIS IS A MODULE AND NOT PART OF staged-renders.js
// Both routes/gallery.js (the owner's listing) and routes/share-public.js (the anonymous
// share manifest) have to read this back, and neither should have to import the store to
// do it. The store deals in rows; this deals in one column's contents.
//
// THE RULE THAT DECIDES WHAT GETS STORED — read this before adding a fourth source:
//
//     `qualifier` is written ONLY when it is not already a column.
//
// The exterior qualifier ("Golden hour") is a lookup from preset ids that no column
// carries, and the masking qualifier ("3 areas") is a count nothing records — so both are
// stored. The interior qualifier IS `furniture_style` + `room_type`, and the AI Designer's
// IS `room_type`, so neither stores one: public/scripts/render-name.js derives those on
// read. Freezing a copy of a column is strictly worse than deriving it — the copy is what
// goes stale — so resist the pull to make all four writers look uniform. They are not
// uniform, and the asymmetry is the point.
//
// Nothing here throws. Every function on this path runs while a paid render is in flight,
// and a naming detail must never be able to fail one — the same posture `clauseFrom` takes
// in lib/staging/exterior-prompts.js.

/**
 * What one render's `extra_json` holds. `qualifier` and `sourceName` are absent rather than
 * empty when unknown — see `buildRenderExtra`.
 * @typedef {{ source: string, qualifier?: string, sourceName?: string }} RenderExtra
 */

/**
 * The tools that can produce a gallery entry.
 *
 * The one vocabulary, and it is duplicated ON PURPOSE in `SOURCE_RULES`
 * (public/scripts/render-name.js): a browser module cannot import from lib/, and nothing in
 * lib/ imports from public/. test/data/render-extra.test.js asserts the two sets are equal
 * in both directions, which is what pays for the duplication.
 *
 * `interior` is in the set even though it stores no qualifier, because a row still records
 * which tool made it — the gallery's Source row shows it, and search matches on it.
 *
 * `api` is here for the same reason and one more. Membership is what makes
 * `buildRenderExtra` keep the row's payload at all: an unrecognised source returns
 * `null`, which nulls the WHOLE column and takes `sourceName` down with it, so an
 * unregistered id costs a render its filename as well as its origin. It is also the
 * only way `renders.bySource` (lib/analytics/admin-metrics.js) can separate the paid
 * API from studio usage — without it every API render buckets as `unknown`, alongside
 * the legacy rows written before this column existed.
 */
export const RENDER_SOURCES = Object.freeze(['interior', 'exterior', 'designer', 'masking', 'api']);

const SOURCE_SET = new Set(RENDER_SOURCES);

/**
 * How long the one stored setting may be. "Golden hour, clear sky" is 22; the ceiling is
 * only here to bound what a future writer can put in a name.
 */
export const MAX_QUALIFIER = 48;

/**
 * How long the source photo's stem may be.
 *
 * 32 rather than the 80 `MAX_RENDER_NAME` allows, because this is a SUFFIX on a name that
 * already has a head: "Exterior — Golden hour · <32>" is about as much as the gallery
 * card's single ellipsised line takes before it truncates.
 */
export const MAX_SOURCE_NAME = 32;

/**
 * Stems that identify nothing, and so are worse than no suffix at all.
 *
 * `photo` earns its place: public/scripts/app.js re-wraps a masked "before" as `photo.png`
 * before re-staging it, so without this every re-stage in the gallery would read "· photo".
 * A suffix whose whole job is to tell two renders apart must not be the same on all of them.
 */
const GENERIC_STEMS = new Set(['photo', 'image', 'img', 'untitled', 'download', 'screenshot', 'blob']);

/**
 * Strip one string down to something safe to put in a name, and clamp it.
 *
 * Extracted from `normalizeRenderName` (lib/data/staged-renders.js), which still calls it —
 * there is one definition of "what may appear in a render's name" and both the owner's typed
 * name and the derived filename suffix go through it.
 *
 * Control characters and bidi overrides go first and unconditionally: these strings land in
 * the gallery grid, the detail dialog's heading and the card's aria-label, and a stray
 * newline or an RLO in any of those is a display bug at best. The clamp happens last so the
 * ceiling applies to what is actually kept.
 *
 * @param {unknown} raw
 * @param {number} max - Ceiling in code points.
 * @returns {string} `''` when there is nothing left, which every caller treats as absent.
 */
export function sanitizeLabel(raw, max) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  // Spread, not slice: `.slice(n)` on a string ending in an emoji or any other astral
  // character cuts it between surrogates and stores half a code point.
  return [...cleaned].slice(0, max).join('');
}

/**
 * The source photo's filename, reduced to the part worth showing.
 *
 * Four steps, and the first two are defensive rather than cosmetic:
 *
 * 1. BASENAME. `originalname` is client-supplied — a crafted Content-Disposition can put
 *    path segments in it. We never use it as a path (that is what lib/data/object-keys.js
 *    is for), so this is not a traversal fix; it is that a card reading
 *    "C:\fakepath\house.jpg" is a bug the user will report.
 * 2. DE-EXTENSION. ".jpg" on every card is noise, and HEIC intake rewrites the extension
 *    anyway, so keeping it would not even be truthful about what was uploaded.
 * 3. `sanitizeLabel`, for the reasons given there.
 * 4. DROP A GENERIC STEM — see GENERIC_STEMS.
 *
 * @param {unknown} raw - A filename, or anything else.
 * @returns {string} `''` when there is nothing worth appending.
 */
export function normalizeSourceName(raw) {
  if (typeof raw !== 'string') return '';
  const base = raw.split(/[/\\]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const clean = sanitizeLabel(stem, MAX_SOURCE_NAME);
  if (!clean) return '';
  return GENERIC_STEMS.has(clean.toLowerCase()) ? '' : clean;
}

/**
 * Build the object that gets serialized into `extra_json`.
 *
 * Returns `null` — the column's own default — when there is nothing worth storing, so a
 * writer that knows nothing about its render does not leave `{}` in every row.
 *
 * An unrecognised `source` yields `null` rather than throwing: this is called on the paid
 * render path, and a typo in a new writer should cost that render its NAME, not its
 * existence. The drift guard in test/data/render-extra.test.js is what catches the typo,
 * because it asserts every `recordPending` call site passes a known source.
 *
 * @param {{ source?: string, qualifier?: string, sourceName?: string } | null} [input]
 * @returns {RenderExtra | null}
 */
export function buildRenderExtra(input) {
  const source = typeof input?.source === 'string' ? input.source : '';
  if (!SOURCE_SET.has(source)) return null;
  const qualifier = sanitizeLabel(input?.qualifier, MAX_QUALIFIER);
  const sourceName = normalizeSourceName(input?.sourceName);
  /** @type {RenderExtra} */
  const extra = { source };
  // Absent rather than empty, so a row carries only what it actually knows and the
  // serialized column stays small enough to sit inside the search haystack.
  if (qualifier) extra.qualifier = qualifier;
  if (sourceName) extra.sourceName = sourceName;
  return extra;
}

/**
 * Read one row's `extra_json` back.
 *
 * ALWAYS returns the three-key shape with `''` for anything missing, and never throws. A
 * row whose JSON is malformed — hand-edited, half-written, or from a future version —
 * yields empty strings and the entry simply falls back to its derived `<Style> <Room type>`
 * name. The alternative is one bad row taking down the whole listing, which is the same
 * reasoning behind the `?? []` guards in routes/gallery.js.
 *
 * Values are re-sanitized on the way OUT as well as in. What is in the column today was
 * written by `buildRenderExtra`, but this function is what the two routes trust, and a
 * reader that trusts its own storage is one restore-from-backup away from being wrong.
 *
 * @param {{ extra_json?: string | null } | null} [row]
 * @returns {{ source: string, qualifier: string, sourceName: string }}
 */
export function readRenderExtra(row) {
  const empty = { source: '', qualifier: '', sourceName: '' };
  const raw = row?.extra_json;
  if (typeof raw !== 'string' || !raw) return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const source = typeof parsed.source === 'string' && SOURCE_SET.has(parsed.source) ? parsed.source : '';
  return {
    source,
    qualifier: sanitizeLabel(parsed.qualifier, MAX_QUALIFIER),
    sourceName: sanitizeLabel(parsed.sourceName, MAX_SOURCE_NAME),
  };
}
