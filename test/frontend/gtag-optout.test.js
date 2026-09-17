// The advertising opt-out gate in public/scripts/gtag.js.
//
// WHY THIS IS A SOURCE-ORDER TEST RATHER THAN AN EXECUTION TEST. gtag.js is a
// CLASSIC script — deliberately, so it can expose the `gtag` global (see its
// header) — which puts it outside the ESM harness every other frontend test uses;
// it is listed in BLOCKED_CLASSIC in untested-frontend-modules.test.js for exactly
// that reason. Executing it here would mean hand-building a window, a document and
// a localStorage, and the thing most worth protecting would still not be covered by
// that: not *whether* the gate runs, but that it runs BEFORE anything is queued or
// fetched. An opt-out that still sent the config call and still pulled the script
// off googletagmanager.com is not an opt-out, and it would look perfectly healthy in
// a behavioural test that only asserted "no ad cookies set".
//
// So this reads the file and pins the order. Crude instrument, exact property.
//
// The e2e counterpart is e2e/index.spec.js, which asserts the tag DOES initialize in
// a normal browser — the other half of the same contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG_PATH = path.join(ROOT, 'public', 'scripts', 'gtag.js');
const OPTOUT_PATH = path.join(ROOT, 'public', 'scripts', 'ad-optout.js');

/** Strip comments so the prose explaining the gate cannot satisfy a check for it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const tag = stripComments(fs.readFileSync(TAG_PATH, 'utf8'));
const optout = stripComments(fs.readFileSync(OPTOUT_PATH, 'utf8'));

test('the gate is checked before the tag is configured or fetched', () => {
  const gate = tag.indexOf('stagifyAdOptedOut()');
  const config = tag.indexOf("gtag('config'");
  const loader = tag.indexOf('googletagmanager.com');

  assert.ok(gate > -1, 'gtag.js must consult the opt-out gate');
  assert.ok(config > -1 && loader > -1, 'precondition: the config call and loader are still here');
  // The call site, not the declaration — `indexOf` finds the invocation inside the
  // `if`, since the function is declared as `function stagifyAdOptedOut()`.
  assert.ok(gate < config, 'the opt-out must be checked BEFORE gtag(config) queues anything');
  assert.ok(gate < loader, 'the opt-out must be checked BEFORE the Google script is appended');
});

test('both opt-out routes are honored: the browser signal and the stored flag', () => {
  assert.match(tag, /navigator\.globalPrivacyControl === true/, 'GPC must be read strictly');
  assert.match(tag, /localStorage\.getItem\(STAGIFY_AD_OPTOUT_KEY\)/, 'the stored flag must be read');
});

test('GPC is read outside the try/catch that guards storage', () => {
  // Storage throws in private mode. If the GPC read sat inside the same try, a
  // storage exception would discard a signal the policy promises to honor.
  const gpc = tag.indexOf('globalPrivacyControl');
  const tryBlock = tag.indexOf('try {', tag.indexOf('function stagifyAdOptedOut'));
  assert.ok(gpc > -1 && tryBlock > -1);
  assert.ok(gpc < tryBlock, 'GPC must be checked before the storage try/catch, not inside it');
});

test('a storage failure loads the tag rather than silently opting everyone out', () => {
  // The deliberate direction of the failure, and the one a future edit is most
  // likely to flip while "making it safer".
  const fn = tag.slice(tag.indexOf('function stagifyAdOptedOut'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /catch[\s\S]*?return false/, 'the catch must return false (= not opted out)');
});

test('the two files agree on the storage key', () => {
  // gtag.js is classic and cannot import from a module, so the key is spelled out
  // twice. This is the guard that keeps the copies identical — a silent mismatch
  // would leave the opt-out button writing a flag nothing ever reads.
  assert.match(tag, /STAGIFY_AD_OPTOUT_KEY = 'stagifyAdOptOut'/);
  assert.match(optout, /STORAGE_KEY = 'stagifyAdOptOut'/);
});

test('the opt-out control never assumes storage is available', () => {
  // Same reason the tag guards it: a browser that throws on localStorage must get a
  // control that says so, not one that reports success it did not achieve.
  const reads = (optout.match(/try \{/g) || []).length;
  assert.ok(reads >= 2, `expected read and write both guarded, found ${reads} try blocks`);
  assert.match(optout, /could not be saved/, 'a failed write must be surfaced to the visitor');
});

test('the region gate is checked before the tag is configured or fetched', () => {
  // Same property as the opt-out gate above, for the other reason the tag can be
  // withheld: an EEA visitor whose browser still fetched googletagmanager.com has
  // not been spared anything, whatever the code did afterwards.
  const gate = tag.indexOf('stagifyAdRegionBlocked()');
  const config = tag.indexOf("gtag('config'");
  const loader = tag.indexOf('googletagmanager.com');

  assert.ok(gate > -1, 'gtag.js must consult the region gate');
  assert.ok(gate < config, 'the region must be checked BEFORE gtag(config) queues anything');
  assert.ok(gate < loader, 'the region must be checked BEFORE the Google script is appended');
});

test('the region gate covers the EEA zones that are not under Europe/', () => {
  // Iceland and the Spanish/Portuguese Atlantic territories are in the EEA but sort
  // under `Atlantic/`, so a bare `Europe/` prefix check would miss them entirely.
  assert.match(tag, /tz\.indexOf\('Europe\/'\) === 0/, 'the Europe/ prefix must be matched');
  for (const zone of ['Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Azores', 'Atlantic/Madeira']) {
    assert.ok(tag.includes(zone), `${zone} is in the EEA and must be covered`);
  }
});

test('an Intl failure loads the tag rather than blocking every visitor', () => {
  // Matches the storage branch: the failure direction is chosen deliberately, and
  // this is the one a future edit is most likely to flip while "making it safer".
  const fn = tag.slice(tag.indexOf('function stagifyAdRegionBlocked'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /catch[\s\S]*?return false/, 'the catch must return false (= not blocked)');
});

test('a region block is reported to the opt-out control as its own state', () => {
  // ad-optout.js must be able to tell "this visitor chose to opt out" from "this
  // region never gets the tag" — offering the second one a toggle would be a button
  // that cannot change the outcome.
  assert.match(tag, /__gtagRegionBlocked = true/, 'the region block must set its own flag');
  assert.match(optout, /__gtagRegionBlocked/, 'the control must read that flag');
});
