// Shared CSV field escaper. Two independent jobs, both needed for a field that may
// contain attacker-controlled text (userAgent, referralSource, email, prompt, …):
//
//  1. RFC-4180 quoting — when the value holds a comma, double-quote, CR or LF, wrap
//     it in double quotes and double any embedded quote. Without this an embedded
//     comma or quote lets one field spill into adjacent columns/rows.
//  2. Formula-injection neutralization — a value that begins with = + - @ (or a
//     leading tab/CR some parsers skip to reach one) is executed as a formula when
//     the CSV is opened in Excel / Google Sheets (e.g. `=HYPERLINK(...)`,
//     `=cmd|...`). Prefixing with a single quote forces the cell to render as
//     literal text; the quote itself is not displayed by spreadsheet apps.
//
// Pure and dependency-free so any CSV writer can share one hardened implementation.

/**
 * @param {unknown} field - The raw value to place in a CSV cell.
 * @returns {string} The escaped, injection-safe cell text (no surrounding delimiters added beyond RFC-4180 quoting).
 */
export function escapeCsvField(field) {
  if (field === null || field === undefined) return '';
  let str = String(field);
  // Neutralize spreadsheet formula injection before quoting.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  // RFC-4180 quoting for structural CSV characters.
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
