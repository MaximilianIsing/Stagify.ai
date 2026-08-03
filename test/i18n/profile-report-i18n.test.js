// Drift guard between the account menu's "Report an issue" dialog and the eleven
// language packs.
//
// WHY IT IS NEEDED HERE SPECIFICALLY: there is no cross-pack key-parity test in this
// repo (see docs/guides/i18n.md) — a key added to english.json ALONE ships green, and
// every string in this dialog is looked up with an English fallback baked into the
// markup, so a missing translation renders as English rather than as a raw key. The
// dialog would look finished in all eleven languages while being English in ten.
//
// Scoped to this namespace, like unstageable-i18n.test.js, because that is the only
// shape of parity guard the repo has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');
const TEMPLATE = path.join(ROOT, 'public', 'scripts', 'profile-menu', 'report-issue-template.js');
const MODAL = path.join(ROOT, 'public', 'scripts', 'profile-menu', 'report-issue-modal.js');
const MENU = path.join(ROOT, 'public', 'scripts', 'profile-menu.js');

// English is served at the root as static files rather than through a LOCALES entry,
// so pull it in explicitly — it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];

const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));

/**
 * Every `profile.report.*` key the shipped code asks for — read out of the source, not
 * hand-listed, so a key added to the dialog without a translation fails here rather
 * than falling back to English in ten languages.
 */
function requiredKeys() {
  const sources = [TEMPLATE, MODAL, MENU].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const keys = new Set();
  // Markup lookups: data-lang="profile.report.x" / data-lang-attr="profile.report.x|attr"
  for (const m of sources.matchAll(/data-lang(?:-attr)?="profile\.report\.([A-Za-z]+)/g)) keys.add(m[1]);
  // JS lookups: lang('profile.report.x', '…')
  for (const m of sources.matchAll(/lang\('profile\.report\.([A-Za-z]+)'/g)) keys.add(m[1]);
  return [...keys].sort();
}

const REQUIRED = requiredKeys();

test('the key scan finds the dialog it is guarding (self-test)', () => {
  // Set-based assertions below pass vacuously if the scan finds nothing. The dialog
  // has a title, a submit label and a failure message no matter how it is reworded.
  assert.ok(REQUIRED.length >= 10, `expected the dialog's strings, found ${REQUIRED.length}: ${REQUIRED}`);
  for (const key of ['title', 'submit', 'failed', 'needDescription']) {
    assert.ok(REQUIRED.includes(key), `the scan missed profile.report.${key}`);
  }
});

test('every language pack carries the menu row and every dialog string', () => {
  for (const lang of LANGS) {
    const profile = packFor(lang).profile;
    assert.equal(typeof profile?.reportIssue, 'string', `${lang}.json is missing profile.reportIssue`);
    assert.ok(profile.reportIssue.trim(), `${lang}.json has an empty profile.reportIssue`);
    const block = profile.report;
    assert.ok(block, `${lang}.json has no profile.report block`);
    for (const key of REQUIRED) {
      assert.equal(typeof block[key], 'string', `${lang}.json is missing profile.report.${key}`);
      assert.ok(block[key].trim().length > 0, `${lang}.json has an empty profile.report.${key}`);
    }
  }
});

test('no pack carries a profile.report key the dialog never looks up', () => {
  // Dead copy that translators keep maintaining, and usually the trace of a rename
  // that only happened on one side.
  for (const lang of LANGS) {
    for (const key of Object.keys(packFor(lang).profile.report)) {
      assert.ok(REQUIRED.includes(key), `${lang}.json has stale profile.report.${key}`);
    }
  }
});

test('non-English packs are actually translated, not copies of the English copy', () => {
  const english = packFor('english');
  // emailPlaceholder is an email address, not prose: several languages legitimately
  // keep "you@example.com", so it is exempt from the copied-string check.
  const prose = REQUIRED.filter((k) => k !== 'emailPlaceholder');
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const pack = packFor(lang);
    assert.notEqual(pack.profile.reportIssue, english.profile.reportIssue,
      `${lang}.json still has the English profile.reportIssue`);
    const copied = prose.filter((k) => pack.profile.report[k] === english.profile.report[k]);
    assert.equal(copied.length, 0, `${lang}.json still has the English string for: ${copied.join(', ')}`);
  }
});
