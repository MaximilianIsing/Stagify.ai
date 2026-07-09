// Central diagnostic logger — the one funnel every backend stdout/stderr line
// flows through. Cross-cutting infrastructure, so it lives at the lib/ root next
// to lib/db.js rather than under a feature folder.
//
// WHY THIS EXISTS
// Diagnostics used to be ~360 raw console.* calls scattered across routes/ and
// lib/: half hand-gated behind `if (DEBUG_MODE)`, half always-on, with no shared
// notion of severity. That made production log volume unpredictable and mixed
// debug dumps (request payloads, image context) into the normal stream. Routing
// everything through here gives four ordered levels behind a single threshold.
//
// NOT lib/services/logging.js. That module is the CSV *business-event* writer
// (prompt / mask / chat rows appended to .csv files) — a data sink, not a
// diagnostic stream. The name collision is exactly what a code review tripped on;
// keep the two straight: `logger` = operator-facing diagnostics, `logging` = CSV
// analytics rows.
//
// LEVELS   debug < info < warn < error. A call prints only when its own level is
// at or above the active threshold. `silent` is a threshold, not a call level.
//
// THRESHOLD   resolved once at module load:
//   1. process.env.LOG_LEVEL, when it names a level (debug|info|warn|error|silent).
//   2. else DEBUG_MODE (env DEBUG / debug.txt, via runtime-flags) → 'debug'.
//   3. else 'info'.
// So a default production process (DEBUG off, no LOG_LEVEL) prints info/warn/error
// and drops debug — matching the old behaviour where an unguarded console.log
// always printed and an `if (DEBUG_MODE)` block did not. Set LOG_LEVEL=warn to
// quiet a chatty deploy, or LOG_LEVEL=silent to mute everything (e.g. in a test).
//
// ROUTING   debug/info → console.log (stdout); warn → console.warn; error →
// console.error (both stderr). Arguments are forwarded verbatim, so existing
// `logger.error('X failed:', err)` formatting and object logging are unchanged.
//
// `no-console` is disabled for this file in eslint.config.js — it is the ONE place
// allowed to call console directly. Everything else must import `logger`.
import { DEBUG_MODE } from './config/runtime-flags.js';

// Numeric ranks let the gate be a single `>=` comparison. `silent` sits above
// every real level so nothing clears it.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Pure, exported for unit tests: given an env bag and the debug flag, return the
// numeric threshold. LOG_LEVEL wins when it names a known level; otherwise the
// debug flag decides between 'debug' and 'info'. An unknown/blank LOG_LEVEL is
// ignored (falls through to the DEBUG_MODE default) rather than throwing.
export function resolveThreshold(env = process.env, debugMode = DEBUG_MODE) {
  const raw = String(env.LOG_LEVEL || '').trim().toLowerCase();
  if (raw && Object.prototype.hasOwnProperty.call(LEVELS, raw)) return LEVELS[raw];
  return debugMode ? LEVELS.debug : LEVELS.info;
}

let threshold = resolveThreshold();

// A message at `level` prints when its rank is at or above the threshold.
function prints(level) {
  return LEVELS[level] >= threshold;
}

export const logger = {
  // Current threshold as its textual name (for diagnostics and tests).
  get level() {
    return Object.keys(LEVELS).find((name) => LEVELS[name] === threshold) || 'info';
  },

  // True when debug output would be emitted. Guard expensive debug-only work
  // (building a big payload summary, stringifying an image) with this so it is
  // skipped entirely in production instead of computed and then dropped.
  get debugEnabled() {
    return prints('debug');
  },

  // Would a call at this level print? Mirrors `debugEnabled` for any level.
  enabled(level) {
    return Object.prototype.hasOwnProperty.call(LEVELS, level) && prints(level);
  },

  debug(...args) { if (prints('debug')) console.log(...args); },
  info(...args) { if (prints('info')) console.log(...args); },
  warn(...args) { if (prints('warn')) console.warn(...args); },
  error(...args) { if (prints('error')) console.error(...args); },

  // Re-resolve the threshold from the environment (and optional debug flag).
  // Used by tests that mutate process.env.LOG_LEVEL between cases; not needed in
  // normal operation, where the module-load resolution stands for the process.
  refresh(env = process.env, debugMode = DEBUG_MODE) {
    threshold = resolveThreshold(env, debugMode);
    return this.level;
  },

  // Force a threshold by name (test helper). Unknown names are ignored.
  setLevel(name) {
    if (Object.prototype.hasOwnProperty.call(LEVELS, name)) threshold = LEVELS[name];
    return this.level;
  },
};
