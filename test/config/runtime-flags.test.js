// Boot-time env flags (lib/config/runtime-flags.js) — pure-helper unit tests.
//
// PURPOSE
// This module is the single source of truth for the process-wide runtime flags
// (debug / email-debug / staging / hero-stat overrides). Most of it is one-shot
// module-load side effect: it reads process.env (and a couple of fallback .txt
// files) exactly once and freezes the derived constants. Two building blocks are,
// however, exported as *pure* functions so they can be exercised without any of
// that boot machinery:
//   - isTruthyFlag(v)      — normalises an env-style flag to a boolean
//   - parseStatOverride(v) — parses an optional numeric override, NaN when absent
// This file tests those two directly. Because they take their input as an argument
// (not from process.env), no environment setup is needed and there are no side
// effects to undo for the bulk of the suite.
//
// WHY NO REAL API / EMAIL / NETWORK / COST
// These helpers are string→boolean and string→number transforms. They touch no
// model client, no mailer, no SQLite, no filesystem and no network — so there is
// nothing to stub and, more importantly, nothing that could ever incur a cost or
// send a real request. The single derivation check at the bottom re-imports the
// module in-process with a cache-busting query and only reads the exported
// SHOW_STAGING_BANNER constant; it likewise makes no external call. Every env var
// it mutates is snapshotted up front and restored in an after() hook so no other
// test file in the suite is affected.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTruthyFlag, parseStatOverride } from '../../lib/config/runtime-flags.js';

// --- isTruthyFlag -----------------------------------------------------------
// Anchored, case-insensitive /^(1|true|on|yes)$/i applied to String(v || '').trim().

test('isTruthyFlag: returns true only for the exact affirmative words, case-insensitively and after trimming', () => {
  // Each of the four accepted spellings, plus an upper-case and mixed variant.
  assert.equal(isTruthyFlag('1'), true);
  assert.equal(isTruthyFlag('true'), true);
  assert.equal(isTruthyFlag('TRUE'), true);
  assert.equal(isTruthyFlag('on'), true);
  assert.equal(isTruthyFlag('ON'), true);
  assert.equal(isTruthyFlag('yes'), true);
  assert.equal(isTruthyFlag('YES'), true);
  // Surrounding whitespace is stripped before matching.
  assert.equal(isTruthyFlag(' true '), true);
});

test('isTruthyFlag: returns false for negative, empty, nullish, and near-miss values', () => {
  assert.equal(isTruthyFlag('0'), false);
  assert.equal(isTruthyFlag('false'), false);
  assert.equal(isTruthyFlag(''), false);
  assert.equal(isTruthyFlag('no'), false);
  assert.equal(isTruthyFlag('maybe'), false);
  assert.equal(isTruthyFlag(undefined), false);
  assert.equal(isTruthyFlag(null), false);
  // "truthy" starts with "true" but the regex is anchored end-to-end, so no match.
  assert.equal(isTruthyFlag('truthy'), false);
});

test('isTruthyFlag: coerces non-string primitives via String() and treats whitespace-only as empty', () => {
  // Whitespace-only string is truthy (non-empty) so `v || ''` keeps it, but .trim()
  // reduces it to '' before the anchored regex runs — no match.
  assert.equal(isTruthyFlag('   '), false);
  // Non-string affirmatives: `1 || ''` -> 1 -> String(1) -> '1' matches; likewise
  // `true || ''` -> true -> String(true) -> 'true' matches. String() coercion, not
  // JS truthiness, is what the regex sees.
  assert.equal(isTruthyFlag(1), true);
  assert.equal(isTruthyFlag(true), true);
  // Numeric zero is falsy, so `0 || ''` collapses to '' -> String('') -> '' -> no match.
  assert.equal(isTruthyFlag(0), false);
});

// --- parseStatOverride ------------------------------------------------------
// String(v ?? '').trim(); '' → NaN; else Number(s), keeping only finite results.

test('parseStatOverride: parses finite numeric strings (including 0 and decimals) and trims whitespace', () => {
  assert.equal(parseStatOverride('5'), 5);
  assert.equal(parseStatOverride('3.2'), 3.2);
  assert.equal(parseStatOverride('0'), 0);
  assert.equal(parseStatOverride('  10  '), 10);
});

test('parseStatOverride: returns NaN for blank, non-numeric, partial-numeric, and nullish input', () => {
  assert.ok(Number.isNaN(parseStatOverride('')));
  assert.ok(Number.isNaN(parseStatOverride('   ')));
  assert.ok(Number.isNaN(parseStatOverride('abc')));
  assert.ok(Number.isNaN(parseStatOverride('5px')));
  assert.ok(Number.isNaN(parseStatOverride(null)));
  assert.ok(Number.isNaN(parseStatOverride(undefined)));
});

test('parseStatOverride: accepts numeric (non-string) inputs — the `??` guard, not `||`, preserves 0', () => {
  // `String(v ?? '')` only substitutes '' for null/undefined, so a real numeric 0
  // survives as '0' -> Number('0') -> 0. A regression to `String(v || '')` would
  // collapse 0 to '' -> NaN; this pins the correct sentinel behaviour.
  assert.equal(parseStatOverride(0), 0);
  assert.equal(parseStatOverride(5), 5);
  assert.equal(parseStatOverride(3.2), 3.2);
});

test('parseStatOverride: rejects non-finite numeric strings via the Number.isFinite filter', () => {
  // Number('Infinity') === Infinity and Number('1e400') overflows to Infinity; both
  // are non-finite, so the isFinite guard maps them to NaN rather than leaking ±Infinity.
  assert.ok(Number.isNaN(parseStatOverride('Infinity')));
  assert.ok(Number.isNaN(parseStatOverride('1e400')));
});

// --- SHOW_STAGING_BANNER derivation -----------------------------------------
// SHOW_STAGING_BANNER === (IS_STAGING && !HIDE_STAGING_BANNER), all read once at
// module load. Re-import the module in-process with a cache-busting query so a
// fresh evaluation picks up the env we set for each case. This reads only the
// exported constant — no client, no network, no cost.

const ENV_KEYS = ['IS_STAGING', 'HIDE_STAGING_BANNER'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setEnv(vals) {
  for (const k of ENV_KEYS) {
    if (vals[k] === undefined) delete process.env[k];
    else process.env[k] = vals[k];
  }
}

async function loadShowBanner(tag) {
  const mod = await import(`../../lib/config/runtime-flags.js?v=${tag}`);
  return mod.SHOW_STAGING_BANNER;
}

test('SHOW_STAGING_BANNER: true only when IS_STAGING is truthy and HIDE_STAGING_BANNER is not', async () => {
  setEnv({ IS_STAGING: '1', HIDE_STAGING_BANNER: undefined });
  assert.equal(await loadShowBanner('staging-only'), true);

  setEnv({ IS_STAGING: '1', HIDE_STAGING_BANNER: '1' });
  assert.equal(await loadShowBanner('staging-hidden'), false);

  setEnv({ IS_STAGING: undefined, HIDE_STAGING_BANNER: undefined });
  assert.equal(await loadShowBanner('not-staging'), false);
});

// --- DEBUG_EMAIL / EMAIL_DEBUG_MODE -----------------------------------------
// DEBUG_EMAIL is the address EMAIL_DEBUG redirects ALL outbound mail to. It used
// to be a hardcoded developer address in this module, so every fork redirected its
// debug mail into one person's inbox; it is now deployment config. The pair has a
// safety property worth pinning: an enabled flag with no address must NOT resolve
// to "send to the real recipients" — every consumer spells the redirect
// `EMAIL_DEBUG_MODE ? DEBUG_EMAIL : toEmail`, so a silent fallback to false would
// mail real users from a box the operator had explicitly put in debug mode. The
// module throws at load instead, and these tests are what stop that regressing.
//
// Each case sets BOTH env vars explicitly (rather than deleting one and relying on
// the ambient environment) so the .txt file fallbacks in the repo root cannot
// influence the result — except the two "unset" cases, which must delete the var
// by definition. Still no network, mailer or cost: this only reads exported
// constants from a re-imported module.

const EMAIL_KEYS = ['EMAIL_DEBUG', 'DEBUG_EMAIL'];
const savedEmailEnv = Object.fromEntries(EMAIL_KEYS.map((k) => [k, process.env[k]]));

after(() => {
  for (const k of EMAIL_KEYS) {
    if (savedEmailEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEmailEnv[k];
  }
});

function setEmailEnv(vals) {
  for (const k of EMAIL_KEYS) {
    if (vals[k] === undefined) delete process.env[k];
    else process.env[k] = vals[k];
  }
}

const loadFlags = (tag) => import(`../../lib/config/runtime-flags.js?v=${tag}`);

test('DEBUG_EMAIL: comes from the environment, trimmed — no address is baked into the module', async () => {
  setEmailEnv({ EMAIL_DEBUG: 'true', DEBUG_EMAIL: '  sink@example.test  ' });
  const mod = await loadFlags('debug-email-set');
  assert.equal(mod.DEBUG_EMAIL, 'sink@example.test');
  assert.equal(mod.EMAIL_DEBUG_MODE, true);
});

test('DEBUG_EMAIL: absent env leaves it an empty string, which is harmless while EMAIL_DEBUG is off', async () => {
  setEmailEnv({ EMAIL_DEBUG: 'false', DEBUG_EMAIL: undefined });
  const mod = await loadFlags('debug-email-unset');
  assert.equal(mod.DEBUG_EMAIL, '');
  assert.equal(mod.EMAIL_DEBUG_MODE, false);
});

test('EMAIL_DEBUG enabled with no DEBUG_EMAIL fails the boot instead of falling back to real recipients', async () => {
  setEmailEnv({ EMAIL_DEBUG: 'true', DEBUG_EMAIL: undefined });
  await assert.rejects(
    () => loadFlags('debug-email-missing'),
    /EMAIL_DEBUG is enabled but DEBUG_EMAIL is empty/,
  );
});

test('EMAIL_DEBUG enabled with a whitespace-only DEBUG_EMAIL fails the same way', async () => {
  // Trimming happens before the emptiness check, so "   " is not a usable address.
  setEmailEnv({ EMAIL_DEBUG: 'true', DEBUG_EMAIL: '   ' });
  await assert.rejects(
    () => loadFlags('debug-email-blank'),
    /EMAIL_DEBUG is enabled but DEBUG_EMAIL is empty/,
  );
});

// --- Drift guard: no address may creep back into the source ------------------
// The original bug was a literal address assigned to DEBUG_EMAIL. Comments are
// stripped BEFORE scanning so that prose — the explanation above the constant, or a
// future "e.g. you@example.com" — cannot fail the build for a line that ships no
// address. Only executable source is scanned. The sanity assertion guards the scan
// itself: if the file is renamed or the constant restructured away, the scan would
// otherwise pass vacuously on source it never found.

test('runtime-flags.js contains no hardcoded email address', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'config', 'runtime-flags.js'),
    'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^[ \t]*\/\/.*$/gm, '')    // whole-line // comments
    .replace(/([^:'"`])\/\/.*$/gm, '$1'); // trailing // comments

  // Sanity: the scan is actually looking at the declaration it is meant to police.
  assert.match(code, /export const DEBUG_EMAIL\s*=/);

  const emailLiteral = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const hit = code.match(emailLiteral);
  assert.equal(
    hit,
    null,
    `runtime-flags.js must read the debug address from the environment, but the source contains ${hit?.[0]}`,
  );
});
