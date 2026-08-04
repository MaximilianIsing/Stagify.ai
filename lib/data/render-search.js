// Searching the gallery: what a query is split into, what each term is matched against, and
// the prepared statements that do it.
//
// Split out of lib/data/staged-renders.js, which had reached the 650-line cap
// (eslint.config.js) — the split the cap's own comment asks for rather than a raised
// ceiling. The seam is a real one: everything here is about TEXT MATCHING and none of it
// touches the cap, eviction, blobs or tombstones, which is the rest of that file's whole
// subject.
//
// The statement factory takes `db` rather than opening one, so this module stays as pure as
// a prepared-statement cache can be and the store keeps owning the connection.

/**
 * How long a search query may be, and how many words of it are honoured.
 *
 * The word cap is not cosmetic: each term becomes another `LIKE` in the WHERE, so an
 * unbounded query is an unbounded statement built from user input. Eight is far past any
 * real search — it bounds the STATEMENT, not the gallery, which matters more now that a
 * Stagify+ history has no ceiling of its own to bound it.
 */
export const MAX_SEARCH_QUERY = 80;
export const MAX_SEARCH_TERMS = 8;

/**
 * Split a raw query into the terms that will be matched.
 *
 * Every term must appear SOMEWHERE in the row (see `SEARCH_HAYSTACK`) — an AND of
 * substring matches rather than one match of the whole phrase. That is what makes the
 * derived default name searchable: a render with no name of its own shows as "Luxury
 * Bedroom", and neither `furniture_style` nor `room_type` contains that string, so a
 * whole-phrase match against either column would find nothing. Typing what is on the card
 * and getting no results is the failure that makes a search box feel broken.
 *
 * @param {unknown} raw
 * @returns {string[]} Empty when there is nothing to search for.
 */
export function searchTerms(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .slice(0, MAX_SEARCH_QUERY)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
}

/**
 * Escape a term for use inside a `LIKE '%…%'` pattern.
 *
 * Without this a query of `%` matches every row and `_` matches any character — the user
 * typing a literal punctuation mark and silently getting the wrong set. The backslash is
 * escaped FIRST, or escaping the wildcards would then re-escape their own escape.
 * @param {string} term @returns {string}
 */
export function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The text one search term is matched against.
 *
 * The owner's name, the style, the room type, the extra prompt and the naming payload,
 * joined — so a term can land in any of them and a multi-word query can straddle two.
 * `custom_name` is included as well as the others rather than instead of them: a render
 * named "412 Rosewood Lane" is still a luxury bedroom, and searching "luxury" should find
 * it.
 *
 * `extra_json` goes in RAW rather than through `json_extract`, and that is deliberate on
 * two counts. `json_extract` RAISES on malformed JSON, which would turn one damaged row
 * into a 500 for the entire listing, whereas `LIKE` over the raw text has no error mode at
 * all. And matching the raw text makes the studio searchable for free — typing "exterior"
 * or "masking" finds those renders, because the source id is in there verbatim. The only
 * false positives are the three literal key names, which nobody types.
 *
 * Case-insensitivity is SQLite's own `LIKE`, which is ASCII-only. A Cyrillic or Greek name
 * therefore matches case-sensitively. Fixing that properly means a normalized column and a
 * backfill; it is documented in docs/reference/data-stores.md rather than half-solved with
 * `lower()`, which is ASCII-only too and would only look like it had been handled.
 *
 * UNINDEXABLE BY CONSTRUCTION and measured, not assumed: a leading-`%` LIKE over a
 * CONCATENATION scans that user's rows, unbounded since PRO_GALLERY_LIMIT went Infinity.
 * 2026-08-04, per debounced keystroke: 6ms at 20k rows for one user, 32ms at 100k. FTS5 with
 * the `trigram` tokenizer was EVALUATED AND DECLINED — available, semantically drop-in, and
 * A WASH for terms that match. Numbers, workings and the revisit trigger are in
 * docs/reference/data-stores.md, so this does not need re-deriving.
 */
export const SEARCH_HAYSTACK = `(
  COALESCE(custom_name, '') || ' ' ||
  COALESCE(furniture_style, '') || ' ' ||
  COALESCE(room_type, '') || ' ' ||
  COALESCE(additional_prompt, '') || ' ' ||
  COALESCE(extra_json, '')
)`;

/**
 * Build the prepared-search-statement cache for one database connection.
 *
 * The WHERE grows one `LIKE` per term, so the SQL genuinely varies — but only with the
 * NUMBER of terms, never with their content, which stays bound. Caching by that number
 * keeps this to at most MAX_SEARCH_TERMS × 2 statements for the life of the process
 * instead of re-preparing on every keystroke that survives the client's debounce.
 *
 * @param {any} db - The shared better-sqlite3 connection.
 * @returns {(terms: number, counting: boolean) => any} A prepared statement for that many
 *   terms, either the page or its COUNT.
 */
export function createSearchStatements(db) {
  /** @type {Map<string, any>} */
  const cache = new Map();
  return function searchStatement(terms, counting) {
    const key = `${terms}:${counting}`;
    const cached = cache.get(key);
    if (cached) return cached;
    // One placeholder per term, all ANDed: every word must appear somewhere in the row.
    const clauses = Array.from({ length: terms }, () => `${SEARCH_HAYSTACK} LIKE ? ESCAPE '\\'`).join(' AND ');
    const stmt = db.prepare(counting
      ? `SELECT COUNT(*) AS n FROM staged_renders
         WHERE user_id = ? AND evicted_at IS NULL AND status = 'ok' AND ${clauses}`
      : `SELECT * FROM staged_renders
         WHERE user_id = ? AND evicted_at IS NULL AND status = 'ok' AND ${clauses}
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`);
    cache.set(key, stmt);
    return stmt;
  };
}
