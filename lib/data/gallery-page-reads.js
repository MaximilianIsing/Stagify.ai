// The three batched reads behind one page of the owner's gallery.
//
// Text only — no connection, no statements. Each store prepares these against its own
// handle; they live together because they exist for ONE caller (the listing in
// routes/gallery.js) and share one non-obvious decision that would otherwise be explained
// three times and drift twice.
//
// WHY `json_each(?)` AND NOT A GENERATED RUN OF `?, ?, ?`
// The placeholder count would vary with the page size, so the SQL TEXT would vary with it —
// and better-sqlite3 caches prepared statements by text, so a gallery that returned 60, then
// 47, then 12 rows would prepare three statements instead of reusing one. That is the same
// trap `searchStatement()` in staged-renders.js has to work around with a cache keyed on term
// count. One bound parameter carrying a JSON array sidesteps it entirely, and takes
// SQLITE_MAX_VARIABLE_NUMBER off the table for good measure. Requires JSON1, which is
// compiled into better-sqlite3's bundled SQLite.
//
// The plan for all three is a seek per id against the leading-column index, driven by a scan
// of the json array — never a table scan. test/data/gallery-batch-reads.test.js EXPLAINs
// these exact strings and fails if that degrades, which is why they are exported as text
// rather than inlined at each `db.prepare` call: a plan assertion against a retyped copy
// passes happily while the real query rots.
//
// These replaced one statement PER ROW each. A full page cost ~182 statements and now costs
// 5; test/routes/gallery-route.test.js asserts that a listing's statement count does not grow
// with the page.

/** Blobs (after/before/thumb) for a page of renders. PK is (render_id, role). */
export const BLOBS_FOR_RENDERS_SQL = `
  SELECT render_id, role, storage_key, bytes FROM render_blobs
  WHERE render_id IN (SELECT value FROM json_each(?))
`;

/**
 * Furniture reference photos for a page of renders, joined to the content-addressed objects
 * they point at. `rr.render_id` is selected because the grouping key has to come back from
 * SQL; `rr.seq` orders each render's own list, matching the single-render statement.
 */
export const REFS_FOR_RENDERS_SQL = `
  SELECT rr.render_id, rr.seq, o.ref_hash, o.storage_key, o.bytes, o.width, o.height
  FROM render_refs rr JOIN ref_objects o ON o.ref_hash = rr.ref_hash
  WHERE rr.render_id IN (SELECT value FROM json_each(?))
  ORDER BY rr.render_id, rr.seq
`;

/**
 * Live share links for a page of renders.
 *
 * No LIMIT and no window function: the ORDER BY puts each render's rows in the order the
 * single-render statement uses, so keeping the FIRST row seen per `render_id` reproduces its
 * `LIMIT 1` exactly. `revoked_at IS NULL` is in the SQL rather than applied in JS afterwards,
 * so a revoked share cannot reach the caller and cannot be resurrected by the batched path.
 * That is the one invariant this must not lose.
 */
export const ACTIVE_FOR_RENDERS_SQL = `
  SELECT * FROM gallery_shares
  WHERE render_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL
  ORDER BY render_id, created_at DESC, rowid DESC
`;
