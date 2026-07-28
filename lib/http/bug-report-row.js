// Row builder for /api/bug-report — an UNAUTHENTICATED endpoint that writes to the
// persistent volume `auth-store.db` lives on (see lib/data/data-dir.js). It is not
// the only one: GET /email/logo.png appends an open-tracking row on the same volume,
// and carries its own ceilings in lib/services/email.js for the same reason.
//
// Nothing upstream bounds what lands there: the JSON body parser sets the only size
// ceiling and `emailLimiter` (6 requests / 15 min / IP) is the only other brake — so
// an unclamped row let one IP append tens of MB per request and fill the disk out
// from under SQLite, which fails auth/sessions/memories along with it. Every field
// is therefore clamped HERE, before it can reach the file, and the caller enforces
// BUG_REPORT_LOG_MAX_BYTES as a second, absolute ceiling on the file itself.
//
// Pure and fs-free so the caps are unit-testable without touching the data dir.
import { escapeCsvField } from './csv-escape.js';

// Column order for bug_reports.csv. As with prompt_logs.csv, the admin tooling reads
// this file positionally — append new columns, never insert one mid-row.
export const BUG_REPORT_HEADER =
  'timestamp,description,stepsToReproduce,email,userId,userAgent,url,ipAddress,conversationHistory\n';

// Per-field ceilings, in characters of RAW input (escaping can at most roughly double
// a field, so the worst-case escaped row is still tens of KB, not tens of MB).
// Generous enough that a real report is never clipped; small enough that abuse is
// bounded to a few hundred KB per rate-limit window per IP.
export const BUG_REPORT_LIMITS = {
  description: 4000,
  steps: 4000,
  email: 320, // RFC 5321 maximum address length
  userId: 128,
  userAgent: 512,
  url: 512,
  timestamp: 64,
  /** Newest-N history messages kept; older ones are dropped, not truncated. */
  historyMessages: 40,
  /** Per-message ceiling inside the flattened log. */
  historyMessageChars: 500,
  /** Ceiling on the whole flattened log, applied after the per-message clamp. */
  historyChars: 12000,
};

// Absolute ceiling on bug_reports.csv itself. A backstop for the case where the
// per-field caps are wrong or a future column escapes them: past this size the route
// stops appending and reports the failure rather than eating the volume.
export const BUG_REPORT_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The live ceiling, read per call so an operator can raise it (or a test lower it)
 * via `BUG_REPORT_LOG_MAX_BYTES` without a code change. A missing or nonsense value
 * falls back to the compiled default rather than disabling the backstop.
 * @returns {number} Maximum bug_reports.csv size in bytes.
 */
export function bugReportLogCeiling() {
  const override = Number(process.env.BUG_REPORT_LOG_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : BUG_REPORT_LOG_MAX_BYTES;
}

const TRUNCATION_MARKER = ' [truncated]';

/**
 * Clamp a single untrusted value to `max` characters, marking any loss.
 * @param {unknown} value - Raw value off the request body.
 * @param {number} max - Character ceiling.
 * @returns {string} The value as a string, no longer than `max` + the marker.
 */
function clamp(value, max) {
  const str = String(value ?? '');
  return str.length <= max ? str : str.slice(0, max) + TRUNCATION_MARKER;
}

/**
 * Flatten a chat transcript into the single CSV cell the report stores.
 *
 * Image payloads are deliberately NOT stored — only a per-message count — so the
 * route never needs to accept (or persist) base64 data URLs.
 *
 * @param {unknown} history - The client's `conversationHistory` array, untrusted.
 * @returns {string} A one-line, length-bounded transcript summary.
 */
export function flattenConversationHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return 'No conversation history';

  // Keep the NEWEST messages: the tail is what explains the bug being reported.
  const dropped = Math.max(0, history.length - BUG_REPORT_LIMITS.historyMessages);
  const kept = dropped > 0 ? history.slice(dropped) : history;

  const formatted = kept.map((msg, index) => {
    const entry = /** @type {any} */ (msg) || {};
    let content;
    if (Array.isArray(entry.content)) {
      // Array content may carry images; keep the text parts and count the rest.
      const textParts = entry.content
        .filter((item) => item && item.type === 'text')
        .map((item) => String(item.text ?? ''));
      const imageCount = entry.content.filter((item) => item && item.type === 'image_url').length;
      content = textParts.join(' ');
      if (imageCount > 0) content += ` [${imageCount} image(s)]`;
    } else {
      content = String(entry.content ?? '');
    }
    // Collapse newlines so one message can't split the CSV row.
    content = clamp(content, BUG_REPORT_LIMITS.historyMessageChars).replace(/[\n\r]/g, ' ');
    const role = clamp(entry.role || 'unknown', 32).toUpperCase();
    return `Message ${dropped + index + 1} [${role}]: ${content}`;
  });

  if (dropped > 0) formatted.unshift(`[${dropped} earlier message(s) omitted]`);
  return clamp(formatted.join(' | '), BUG_REPORT_LIMITS.historyChars);
}

/**
 * Build one fully-clamped, CSV-escaped bug-report row (including its trailing newline).
 * @param {any} body - The parsed request body, untrusted.
 * @param {string} ipAddress - Caller IP, resolved by the route.
 * @returns {string} The row to append to bug_reports.csv.
 */
export function buildBugReportRow(body, ipAddress) {
  const b = body || {};
  return (
    [
      escapeCsvField(clamp(b.timestamp || new Date().toISOString(), BUG_REPORT_LIMITS.timestamp)),
      escapeCsvField(clamp(b.description, BUG_REPORT_LIMITS.description)),
      escapeCsvField(clamp(b.steps, BUG_REPORT_LIMITS.steps)),
      escapeCsvField(clamp(b.email, BUG_REPORT_LIMITS.email)),
      escapeCsvField(clamp(b.userId || 'unknown', BUG_REPORT_LIMITS.userId)),
      escapeCsvField(clamp(b.userAgent || 'unknown', BUG_REPORT_LIMITS.userAgent)),
      escapeCsvField(clamp(b.url || 'unknown', BUG_REPORT_LIMITS.url)),
      escapeCsvField(ipAddress),
      escapeCsvField(flattenConversationHistory(b.conversationHistory)),
    ].join(',') + '\n'
  );
}
