// Runtime counters (rooms staged / contact submissions) shown on the home page.
//
// The counters are written from the staging + chat flows and read from the
// public stats endpoint. Keeping the mutable state here — with the accessors —
// makes this module the single owner: every importer shares the same live value
// rather than a snapshot. Increment uses `+= 1` (not `++`) so a global
// "++" -> "inc" rewrite of a caller can never make an accessor self-recurse.
//
// The seed values come from the CSV logs at boot, which means the counting has to
// agree with what logging.js actually writes — see countCsvRecords below.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { resolveDataDir } from './data-dir.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // two levels up: lib/data/ -> repo root

let promptCount = 0;
let contactCount = 0;

export function getPromptCount() { return promptCount; }
export function incPromptCount() { promptCount += 1; }
export function getContactCount() { return contactCount; }
export function incContactCount() { contactCount += 1; }

// The same directory the CSV writer in lib/services/logging.js appends to — both
// resolve it through lib/data/data-dir.js, so the seed can never read from a
// different folder than the one being written.
function defaultLogDir() {
  return resolveDataDir(rootDir);
}

// Read size for the streaming record count. The logs grow without bound, so the
// file is walked in chunks rather than slurped whole — memory stays flat whether
// the CSV is 2 KB or 2 GB.
const CHUNK_BYTES = 64 * 1024;

/**
 * Count the data records in a CSV file, excluding the header row.
 *
 * This is RFC4180-aware on the one point that matters here: a newline inside a
 * quoted field does not start a new record. That is not hypothetical — the writer
 * quotes and embeds free-text user input (`additionalPrompt` in prompt_logs.csv,
 * `userMessage` in chat_logs.csv), so a prompt containing a line break spans
 * multiple physical lines in the file while still being ONE record.
 *
 * The previous implementation counted lines matching /^\d{4}-\d{2}-\d{2}T.../gm,
 * which double-counted exactly those rows: a user prompt containing a newline
 * followed by anything ISO-timestamp-shaped inflated the public "Rooms Staged"
 * figure. Escaped quotes ("") are handled by the toggle below — the second quote
 * of the pair flips `inQuotes` back on, so the parser never leaves the field.
 *
 * Pass `statusColumn`/`accept` to count only the records whose value in that
 * column satisfies `accept` — see countStagedRooms, which needs successes only.
 * In that mode a record is skipped when its FIRST field does not begin with a
 * digit, which is how a header row (of either vintage) is recognised and dropped.
 *
 * @param {string} filePath - Absolute path to the CSV file.
 * @param {{ statusColumn?: number, accept?: (value: string, fieldCount: number) => boolean }} [options]
 *   Optional column filter. Omit to count every data record.
 * @returns {number} Data records excluding the header, or 0 if the file is absent/empty.
 */
export function countCsvRecords(filePath, options = {}) {
  const { statusColumn, accept } = options;
  const filtering = typeof statusColumn === 'number' && typeof accept === 'function';
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return 0; // no file yet — nothing has been logged
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const QUOTE = 0x22; // "
    const LF = 0x0a; // \n
    const COMMA = 0x2c; // ,
    const CR = 0x0d; // \r
    let inQuotes = false;
    let records = 0;
    let lines = 0; // every LF, quoted or not — the desync fallback below
    let sawAnyByte = false;
    let firstChunk = null;
    let lastByte = -1;

    // Filtering state, reset at every record boundary.
    let field = 0;
    let statusChars = '';
    let firstChar = -1;
    let matched = 0;
    const endRecord = () => {
      // A header row of either vintage starts with a letter, a data row with the
      // ISO timestamp's leading digit. Without this the LEGACY 9-column header
      // would be read as a legacy data row and counted as a success.
      const isData = firstChar >= 0x30 && firstChar <= 0x39;
      if (isData && accept && accept(statusChars, field + 1)) matched += 1;
      field = 0;
      statusChars = '';
      firstChar = -1;
    };

    for (;;) {
      const bytes = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (bytes === 0) break;
      if (!sawAnyByte) firstChunk = buf.toString('utf8', 0, Math.min(bytes, 64));
      sawAnyByte = true;
      for (let i = 0; i < bytes; i += 1) {
        const b = buf[i];
        if (b === QUOTE) inQuotes = !inQuotes;
        else if (b === LF) {
          lines += 1;
          if (!inQuotes) {
            records += 1;
            if (filtering) endRecord();
          } else if (filtering && field === statusColumn) statusChars += '\n';
        } else if (filtering && !inQuotes && b === COMMA) {
          field += 1;
        } else if (filtering && b !== CR) {
          if (field === 0 && firstChar < 0) firstChar = b;
          // Quotes are consumed above, so what accumulates is the unquoted value.
          if (field === statusColumn) statusChars += String.fromCharCode(b);
        }
      }
      lastByte = buf[bytes - 1];
    }

    if (!sawAnyByte) return 0;

    // Ending mid-field means the quotes never balanced, so the file is not
    // well-formed CSV and every LF after the stray quote was misread as being
    // inside a field — the record count will have collapsed, potentially to
    // near-zero. escapeCsvField always balances its quotes, so this should only
    // ever be reachable via hand-edited or pre-hardening rows, but a silently
    // collapsed public counter is a bad way to find that out. Fall back to the
    // physical line count (what the old line-scanning implementation effectively
    // used) and say so in the log.
    if (inQuotes) {
      logger.warn(
        `[counters] ${filePath} ends inside a quoted field (unbalanced quotes); ` +
          'falling back to a line count, which may over-count multi-line rows',
      );
      records = lines;
      // Field boundaries are just as desynced as record boundaries here, so the
      // per-record status reads cannot be trusted either. Fall back to the
      // unfiltered count rather than reporting a confidently wrong smaller number.
      if (filtering) {
        const hasHeaderRow = !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(firstChunk || '');
        return Math.max(0, records - (hasHeaderRow ? 1 : 0));
      }
    }

    // A file not ending in a newline still holds a final unterminated record.
    if (lastByte !== LF) {
      records += 1;
      if (filtering) endRecord();
    }
    if (filtering) return matched;
    // Every writer in lib/services/logging.js emits a header, but don't assume it:
    // a log rotated or hand-edited down to bare data rows would otherwise report
    // one render short forever. Data rows always start with an ISO timestamp, so a
    // first row that doesn't is the header.
    const hasHeader = !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(firstChunk || '');
    return Math.max(0, records - (hasHeader ? 1 : 0));
  } catch (error) {
    logger.error(`Error counting CSV records in ${filePath}:`, error);
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

// prompt_logs.csv column index of `status`, per PROMPT_LOG_HEADER in
// lib/services/logging.js. Rows written before the outcome columns existed have
// only the first nine fields and no status at all.
const PROMPT_STATUS_COLUMN = 9;
const PROMPT_LEGACY_FIELD_COUNT = 9;

/**
 * Does a prompt_logs.csv row represent a room that was actually staged?
 *
 * processStaging writes a row on BOTH outcomes — logOutcome('ok') and
 * logOutcome('failed') — but incPromptCount() only fires on success. Seeding the
 * counter from a plain record count therefore disagreed with the live counter:
 * the public "Rooms Staged" figure showed successes while the process was up,
 * then jumped by the cumulative failure count at the next restart and never came
 * back down.
 *
 * @param {string} status - The row's status field ('' for a legacy row).
 * @param {number} fieldCount - How many fields the row had.
 * @returns {boolean} True when the row should count towards rooms staged.
 */
function isStagedRoomRow(status, fieldCount) {
  // A legacy row predates the outcome columns, and back then only successes were
  // written — so it counts. Anything with the columns must say so explicitly.
  if (fieldCount <= PROMPT_LEGACY_FIELD_COUNT) return true;
  return status.trim().toLowerCase() === 'ok';
}

/**
 * Seed a counter from its CSV log.
 * @param {string} fileName - CSV basename inside the log directory.
 * @param {string} label - Human name for the debug line.
 * @param {string} [logDir] - Override the log directory (tests).
 * @param {{ statusColumn?: number, accept?: (value: string, fieldCount: number) => boolean }} [options]
 *   Column filter forwarded to countCsvRecords.
 * @returns {number} The seed value.
 */
function seedFromCsv(fileName, label, logDir, options) {
  try {
    const logFile = path.join(logDir || defaultLogDir(), fileName);
    if (!fs.existsSync(logFile)) {
      if (DEBUG_MODE) logger.debug(`No ${label} log file found, starting with count 0`);
      return 0;
    }
    const count = countCsvRecords(logFile, options);
    if (DEBUG_MODE) logger.debug(`${label} count successfully initialized from file:`, count);
    return count;
  } catch (error) {
    logger.error(`Error initializing ${label} count:`, error);
    return 0;
  }
}

/**
 * Seed the rooms-staged counter from prompt_logs.csv.
 * @param {string} [logDir] - Override the log directory (tests).
 * @returns {void}
 */
export function initializePromptCount(logDir) {
  promptCount = seedFromCsv('prompt_logs.csv', 'Prompt', logDir, {
    statusColumn: PROMPT_STATUS_COLUMN,
    accept: isStagedRoomRow,
  });
}

/**
 * Seed the contact-submissions counter from contact_logs.csv.
 * @param {string} [logDir] - Override the log directory (tests).
 * @returns {void}
 */
export function initializeContactCount(logDir) {
  contactCount = seedFromCsv('contact_logs.csv', 'Contact', logDir);
}
