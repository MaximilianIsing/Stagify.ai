// Quote-aware CSV record parsing + in-place redaction of the cells that identify
// one person. Used by user-deletion.js: erasing an account has to reach the flat
// CSV logs too, not just SQLite, or the account is "deleted" while six files still
// hold the address it was registered with.
//
// Why REDACT rather than delete the row: the public "Rooms Staged" counter is
// seeded by counting records in prompt_logs.csv (lib/data/counters.js), and the
// admin dashboard reads these files positionally. Blanking the identifying cells
// removes the personal data while leaving every row, column and count exactly where
// it was — anonymisation, which is a valid alternative to erasure, and a far
// smaller blast radius than rewriting the row set.
//
// The parser is RFC-4180 correct on the point that matters: the writers quote and
// embed free-text user input (`additionalPrompt`, `userMessage`), so a newline
// inside a quoted field does NOT start a new record. Getting that wrong here would
// corrupt the file rather than merely miscount it (compare countCsvRecords, which
// only had to count).
import fs from 'fs';
import { escapeCsvField } from '../http/csv-escape.js';

/** What a redacted cell is replaced with. Chosen to be obvious in a spreadsheet. */
export const REDACTED = '[erased]';

/**
 * @typedef {{ fields: string[], raw: string }} CsvRecord
 * `fields` are decoded (quotes stripped, `""` unescaped); `raw` is the exact source
 * slice INCLUDING its line terminator, so an untouched record can be re-emitted
 * byte-for-byte instead of being re-serialised.
 */

/**
 * Split CSV text into records.
 * @param {string} text - Whole file contents.
 * @returns {CsvRecord[]} One entry per record, header included.
 */
export function parseCsvRecords(text) {
  /** @type {CsvRecord[]} */
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let recordStart = 0;
  let i = 0;

  const endRecord = (endIdx) => {
    fields.push(field);
    records.push({ fields, raw: text.slice(recordStart, endIdx) });
    fields = [];
    field = '';
    recordStart = endIdx;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is a literal quote; a lone one closes the field.
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { fields.push(field); field = ''; i += 1; continue; }
    if (ch === '\n') {
      // CRLF: the CR belongs to the terminator, not to the last field.
      if (field.endsWith('\r')) field = field.slice(0, -1);
      endRecord(i + 1); i += 1; continue;
    }
    field += ch; i += 1;
  }
  // Anything left is a final record with no trailing newline.
  if (recordStart < text.length) endRecord(text.length);
  return records;
}

/**
 * Overwrite a file by writing beside it and renaming: a crash mid-write leaves the
 * original intact rather than a truncated one. Shared with the JSON-store redaction
 * in user-deletion.js, which needs exactly the same guarantee.
 *
 * @param {string} filePath - The file to replace.
 * @param {string} content - Its new complete contents.
 * @returns {void}
 */
export function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.redact-tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** The line terminator a record ended with, so a rewrite preserves it. */
function terminatorOf(raw) {
  if (raw.endsWith('\r\n')) return '\r\n';
  if (raw.endsWith('\n')) return '\n';
  return '';
}

/**
 * Redact the identifying cells of every record that matches, in place.
 *
 * Non-matching records are copied through verbatim, so a file with no match is
 * never rewritten at all and one with a match differs only in the matched rows.
 *
 * @param {string} filePath - CSV to rewrite.
 * @param {{
 *   match: { column: string, value: string, caseInsensitive?: boolean }[],
 *   redact: string[],
 * }} spec - Columns to match on (OR-ed) and the column names to blank. Both are
 *   resolved against the file's own header row, so a column that this file does not
 *   have is simply skipped rather than shifting anything.
 * @returns {{ file: string, present: boolean, matched: number, reason?: string }}
 */
export function redactCsvFile(filePath, spec) {
  const result = { file: filePath, present: false, matched: 0 };
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return result; // never written yet
    throw err;
  }
  result.present = true;
  if (!text.trim()) return result;

  const records = parseCsvRecords(text);
  if (records.length < 2) return result; // header only (or no data rows)

  // Resolve column names against THIS file's header. Positional assumptions are
  // what make these logs fragile (see the prompt_logs column-order comment in
  // lib/services/logging.js), so never hard-code an index here.
  const header = records[0].fields.map((h) => h.trim());
  const indexOf = (name) => header.indexOf(name);
  const matchers = spec.match
    .map((m) => ({ ...m, idx: indexOf(m.column) }))
    .filter((m) => m.idx >= 0 && m.value);
  const redactIdx = spec.redact.map(indexOf).filter((i) => i >= 0);
  if (matchers.length === 0 || redactIdx.length === 0) {
    result.reason = 'no matching columns in this file';
    return result;
  }

  const out = [records[0].raw];
  let matched = 0;
  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    const hit = matchers.some((m) => {
      const cell = rec.fields[m.idx];
      if (cell == null) return false;
      return m.caseInsensitive
        ? cell.trim().toLowerCase() === m.value.trim().toLowerCase()
        : cell.trim() === m.value.trim();
    });
    if (!hit) {
      out.push(rec.raw);
      continue;
    }
    matched += 1;
    const fields = rec.fields.slice();
    for (const idx of redactIdx) if (idx < fields.length) fields[idx] = REDACTED;
    out.push(fields.map(escapeCsvField).join(',') + terminatorOf(rec.raw));
  }

  result.matched = matched;
  if (matched === 0) return result; // leave the file untouched

  let content = out.join('');
  // The app appends to these logs while this runs. Carry over anything written
  // since the read so a concurrent render's row is not lost. (A row appended
  // between here and the rename still is — this is an operator action, so run it
  // when traffic is low; the window is microseconds.)
  try {
    const nowSize = fs.statSync(filePath).size;
    const readSize = Buffer.byteLength(text, 'utf8');
    if (nowSize > readSize) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const tail = Buffer.allocUnsafe(nowSize - readSize);
        fs.readSync(fd, tail, 0, tail.length, readSize);
        content += tail.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch { /* best effort — the rewrite below is still correct for what we read */ }

  writeFileAtomic(filePath, content);
  return result;
}
