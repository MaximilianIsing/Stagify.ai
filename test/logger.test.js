// Central diagnostic logger (lib/logger.js) — unit tests.
//
// PURPOSE
// lib/logger.js is the single funnel for backend diagnostics. Two behaviours are
// worth pinning:
//   1. resolveThreshold(env, debugMode) — the precedence that decides which levels
//      print: an explicit LOG_LEVEL wins, else DEBUG_MODE flips debug on, else the
//      floor is 'info'. This is a pure (env, flag) -> number function, so it is
//      tested directly with hand-built env bags — no process.env mutation, no
//      module reload.
//   2. The logger's per-level gating and console routing — that debug/info go to
//      console.log, warn to console.warn, error to console.error, and that each is
//      emitted only when the active threshold allows it.
//
// WHY NO NETWORK / COST
// The logger wraps console and reads env/flags only. It touches no model client,
// no SQLite, no mailer, no filesystem and no network, so nothing here can incur a
// cost or send a request. The console methods are swapped for in-memory capture
// functions and restored in a finally block, so the suite prints nothing of its
// own and leaves global console untouched for other test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, resolveThreshold } from '../lib/logger.js';

// Ranks used by resolveThreshold; duplicated here so a regression in the source
// numbers is caught rather than mirrored.
const RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// --- resolveThreshold: precedence -------------------------------------------

test('resolveThreshold: an explicit LOG_LEVEL wins over DEBUG_MODE', () => {
  // LOG_LEVEL=warn even with debug on → warn floor (debug and info suppressed).
  assert.equal(resolveThreshold({ LOG_LEVEL: 'warn' }, true), RANK.warn);
  // LOG_LEVEL=debug even with debug off → debug floor.
  assert.equal(resolveThreshold({ LOG_LEVEL: 'debug' }, false), RANK.debug);
  // Case- and whitespace-insensitive, matching the flag helpers elsewhere.
  assert.equal(resolveThreshold({ LOG_LEVEL: '  ERROR ' }, true), RANK.error);
  // 'silent' is a valid threshold name (mutes everything).
  assert.equal(resolveThreshold({ LOG_LEVEL: 'silent' }, true), RANK.silent);
});

test('resolveThreshold: falls back to DEBUG_MODE when LOG_LEVEL is absent or unknown', () => {
  // No LOG_LEVEL: debug flag decides between debug and info.
  assert.equal(resolveThreshold({}, true), RANK.debug);
  assert.equal(resolveThreshold({}, false), RANK.info);
  // Unknown / blank LOG_LEVEL is ignored (does NOT throw) and falls through to the
  // DEBUG_MODE default — a typo like LOG_LEVEL=verbose must not silence the app.
  assert.equal(resolveThreshold({ LOG_LEVEL: 'verbose' }, false), RANK.info);
  assert.equal(resolveThreshold({ LOG_LEVEL: '' }, true), RANK.debug);
});

test('resolveThreshold: default floor is info — unguarded logs print, debug does not', () => {
  // The production default (no LOG_LEVEL, no debug) is the info floor. This is what
  // preserves the pre-logger behaviour: a plain console.log printed; an
  // `if (DEBUG_MODE)` block did not.
  const t = resolveThreshold({}, false);
  assert.ok(RANK.info >= t, 'info should print at the default floor');
  assert.ok(RANK.warn >= t && RANK.error >= t, 'warn/error should print');
  assert.ok(!(RANK.debug >= t), 'debug should be suppressed at the default floor');
});

// --- logger: gating + console routing ---------------------------------------

// Run `fn` with console.{log,warn,error} captured into arrays; always restores.
function capture(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const calls = { log: [], warn: [], error: [] };
  console.log = (...a) => calls.log.push(a);
  console.warn = (...a) => calls.warn.push(a);
  console.error = (...a) => calls.error.push(a);
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return calls;
}

test('logger: routes each level to the matching console method with args verbatim', () => {
  const prev = logger.level;
  try {
    logger.setLevel('debug'); // everything prints
    const calls = capture(() => {
      logger.debug('d', 1);
      logger.info('i', 2);
      logger.warn('w', 3);
      logger.error('e', 4);
    });
    // debug and info both go to stdout (console.log); warn/error to their own methods.
    assert.deepEqual(calls.log, [['d', 1], ['i', 2]]);
    assert.deepEqual(calls.warn, [['w', 3]]);
    assert.deepEqual(calls.error, [['e', 4]]);
  } finally {
    logger.setLevel(prev);
  }
});

test('logger: suppresses calls below the active threshold', () => {
  const prev = logger.level;
  try {
    logger.setLevel('warn'); // debug + info muted, warn + error live
    const calls = capture(() => {
      logger.debug('nope');
      logger.info('nope');
      logger.warn('yes-w');
      logger.error('yes-e');
    });
    assert.deepEqual(calls.log, [], 'debug/info must not reach console.log at warn floor');
    assert.deepEqual(calls.warn, [['yes-w']]);
    assert.deepEqual(calls.error, [['yes-e']]);
  } finally {
    logger.setLevel(prev);
  }
});

test('logger: silent mutes every level, including error', () => {
  const prev = logger.level;
  try {
    logger.setLevel('silent');
    const calls = capture(() => {
      logger.debug('x'); logger.info('x'); logger.warn('x'); logger.error('x');
    });
    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.warn, []);
    assert.deepEqual(calls.error, []);
  } finally {
    logger.setLevel(prev);
  }
});

test('logger: debugEnabled / enabled(level) reflect the active threshold', () => {
  const prev = logger.level;
  try {
    logger.setLevel('info');
    assert.equal(logger.debugEnabled, false, 'debug off at info floor');
    assert.equal(logger.enabled('info'), true);
    assert.equal(logger.enabled('error'), true);
    assert.equal(logger.enabled('debug'), false);
    assert.equal(logger.enabled('bogus'), false, 'unknown level name is never enabled');

    logger.setLevel('debug');
    assert.equal(logger.debugEnabled, true, 'debug on at debug floor');
    assert.equal(logger.enabled('debug'), true);
  } finally {
    logger.setLevel(prev);
  }
});

test('logger: refresh() re-reads LOG_LEVEL from the environment', () => {
  const prev = logger.level;
  try {
    assert.equal(logger.refresh({ LOG_LEVEL: 'error' }, false), 'error');
    assert.equal(logger.debugEnabled, false);
    assert.equal(logger.refresh({}, true), 'debug');
    assert.equal(logger.debugEnabled, true);
  } finally {
    logger.setLevel(prev);
  }
});
