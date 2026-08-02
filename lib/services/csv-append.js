// One race-free way to append a row to a CSV log, header included on first write.
//
// The pattern this replaces was copy-pasted across five writers:
//
//     const fileExists = fs.existsSync(logFile);
//     if (!fileExists) fs.writeFileSync(logFile, HEADER + '\n' + row);  // truncating!
//     else fs.appendFile(logFile, row, cb);
//
// Two concurrent requests on a fresh volume both observe `!fileExists`, and the
// second writeFileSync TRUNCATES the file, destroying the first one's row. That is
// not hypothetical: on Render the data dir is a fresh mount on first deploy and
// /api/process-image is routinely concurrent, so the loss window is real — and it
// is the FIRST rows of a brand-new log, which is exactly when nobody is looking.
//
// The fix has two halves, and both matter:
//
//   1. The header goes out under the `wx` flag — create-only, which the OS makes
//      atomic. Whoever loses the race gets EEXIST and simply skips it, so the
//      header is written exactly once and no existing bytes are ever replaced.
//      (The obvious `existsSync` guard cannot give this: the gap between the check
//      and the write is precisely the bug.)
//   2. The row goes out with appendFile, which is O_APPEND — concurrent appends
//      interleave at record boundaries rather than overwriting one another.
//
// routes/public.js's bug-report writer already reasoned its way to half of this
// ("appendFile creates the file when it is missing, so the header and the first row
// go out in the same write"); this generalises it and closes the header race too.
import fs from 'fs';

import { logger } from '../logger.js';

/**
 * Append one row to a CSV log, creating it with `header` if it does not exist yet.
 *
 * BOTH writes are synchronous, which is a deliberate simplification of what these
 * writers did before (first row synchronous, every later row a fire-and-forget
 * async append whose error only ever reached a log line). The rows are a few
 * hundred bytes and are written once per render / chat message / contact form —
 * not per request — so the syscall cost is noise beside the multi-second model
 * call that precedes it, and in exchange the row is on disk before the response is
 * sent and the write order is deterministic. test/services/logging.test.js depends
 * on that ("synchronous first write") and is right to.
 *
 * @param {string} logFile - Absolute path to the CSV.
 * @param {string} header - Header line WITHOUT its trailing newline.
 * @param {string} row - The row to append, INCLUDING its trailing newline.
 * @param {string} [label] - Name used in the error log line.
 * @returns {void}
 */
export function appendCsvRow(logFile, header, row, label = 'CSV log') {
  try {
    // 'wx' = create-exclusive: succeeds only if the file is absent, and the
    // check-and-create is atomic in the kernel. EEXIST simply means somebody else
    // created it first, which is the expected case on every call but the first.
    fs.writeFileSync(logFile, header + '\n', { flag: 'wx' });
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'EEXIST') {
      logger.error(`Error creating ${label}:`, err);
      return; // No header means no usable file; don't append an orphan row.
    }
  }

  try {
    // O_APPEND: the offset is taken at write time, so concurrent appends land one
    // after another instead of overwriting each other.
    fs.appendFileSync(logFile, row);
  } catch (err) {
    logger.error(`Error writing to ${label}:`, err);
  }
}
