// Drift guards for the language set.
//
// CLAUDE.md declares lib/i18n/locales.js the single source of truth, but the
// browser cannot import it, so the frontend kept its own copies: two maps in
// i18n-routing.js, a BCP-47 map plus a hand-written switch in language-detect.js,
// a flag map plus another BCP-47 map in language-switcher.js, a three-of-eleven
// class list in language-loader.js, and a block of switcher markup in each of the
// eight pages that has a language picker. Nothing compared any of them to the
// server's list — the existing i18n drift test only exercised the ROUTING helpers'
// behaviour, so a language added to locales.js and missed in one of those files
// shipped green.
//
// The JS copies are now generated (lib/i18n/locale-data.js →
// public/scripts/locale-data.js). The markup cannot be generated, so it is
// asserted here instead. Between them, adding a language without finishing the job
// now fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_LOCALES, LOCALES } from '../../lib/i18n/locales.js';
import { buildLocaleDataModule } from '../../lib/i18n/locale-data.js';
import {
  LANGUAGES,
  PREFIX_TO_LANG,
  LANG_TO_PREFIX,
  LANG_BCP47,
  LANG_FLAG,
  PRIMARY_SUBTAG_TO_LANG,
  LOCALIZED_PATHS,
} from '../../public/scripts/locale-data.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(repoRoot, 'public');
const SCRIPTS = path.join(PUBLIC, 'scripts');

const ALL_LANGS = ALL_LOCALES.map((l) => l.lang);

test('committed locale-data.js matches the generator (rebuild if this fails)', () => {
  const committed = fs.readFileSync(path.join(SCRIPTS, 'locale-data.js'), 'utf8');
  assert.equal(committed.replace(/\r\n/g, '\n'), buildLocaleDataModule(),
    'public/scripts/locale-data.js is stale — run `node scripts/build-i18n-seo.js`');
});

test('every generated table is keyed by exactly the server locale set', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.lang), ALL_LANGS);
  assert.deepEqual(Object.keys(PREFIX_TO_LANG), LOCALES.map((l) => l.prefix),
    'PREFIX_TO_LANG covers the non-English locales only — English has no prefix');
  assert.deepEqual(Object.keys(LANG_TO_PREFIX), ALL_LANGS);
  assert.deepEqual(Object.keys(LANG_BCP47), ALL_LANGS);
  assert.deepEqual(Object.keys(LANG_FLAG), ALL_LANGS);
  assert.deepEqual(Object.values(PRIMARY_SUBTAG_TO_LANG).sort(), [...ALL_LANGS].sort(),
    'every language must be reachable from some browser tag, or auto-detect skips it');
});

test('prefix maps round-trip, and every flag asset exists', () => {
  for (const locale of ALL_LOCALES) {
    assert.equal(LANG_TO_PREFIX[locale.lang], locale.prefix);
    if (locale.prefix) assert.equal(PREFIX_TO_LANG[locale.prefix], locale.lang);
    assert.equal(LANG_BCP47[locale.lang], locale.bcp47);
    const asset = path.join(PUBLIC, LANG_FLAG[locale.lang]);
    assert.ok(fs.existsSync(asset), `missing flag asset for ${locale.lang}: ${LANG_FLAG[locale.lang]}`);
  }
});

test('LOCALIZED_PATHS mirrors the server page set', async () => {
  const { LOCALIZED_PATHS: serverPaths } = await import('../../lib/i18n/locales.js');
  assert.deepEqual([...LOCALIZED_PATHS].sort(), [...serverPaths].sort());
});

test('DRIFT GUARD: no frontend script hard-codes the language list', () => {
  // A file naming three or more languages in CODE is maintaining its own copy of
  // the set. Two or fewer is a legitimate special case — 'english' as a default,
  // say. Comments are stripped first: prose is free to discuss languages by name
  // (this very refactor's comments do), and only executable references can drift.
  const NAMES = new RegExp(`\\b(${ALL_LANGS.join('|')})\\b`, 'g');
  const offenders = [];

  // Deliberately crude, and only ever used to make the check MORE forgiving: the
  // `[^:]` guard keeps it from eating the tail of a `https://…` string literal.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(PUBLIC, full).replace(/\\/g, '/');
      if (rel === 'scripts/locale-data.js') continue; // the generated copy
      const named = new Set(stripComments(fs.readFileSync(full, 'utf8')).match(NAMES) || []);
      if (named.size >= 3) offenders.push(`${rel} (names ${named.size}: ${[...named].join(', ')})`);
    }
  }
  scan(SCRIPTS);

  assert.deepEqual(offenders, [],
    'these scripts enumerate languages by hand instead of importing from ' +
    './locale-data.js — a new language would have to be added here too, and nothing ' +
    'but this test would notice if it were not');
});

test('every language switcher in the markup lists exactly the server locale set', () => {
  // Keyed on the FUNCTIONAL element (#language-select, what language-loader.js
  // drives), not the decorative list — otherwise a page that grew a selector but
  // no custom list would be skipped by the very test meant to cover it.
  const pages = fs.readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => /<select[^>]*id="language-select"/i.test(fs.readFileSync(path.join(PUBLIC, f), 'utf8')));

  assert.ok(pages.length > 0, 'no page with a language switcher was found — did the markup change?');

  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');

    // The visually-hidden native <select> that language-loader.js drives.
    const selectBlock = html.match(/<select[^>]*id="language-select"[\s\S]*?<\/select>/i);
    assert.ok(selectBlock, `${page}: no #language-select`);
    assert.ok(html.includes('lang-switch__option'),
      `${page}: has a #language-select but no custom switcher list to drive it`);
    const optionValues = [...selectBlock[0].matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...optionValues].sort(), [...ALL_LANGS].sort(),
      `${page}: the native <select> options do not match the locale set`);

    // The custom listbox the user actually sees. Parsed structurally rather than
    // with one big shape regex, so reformatting the markup (attribute order, a
    // non-self-closing <img>) fails on the real assertion below instead of
    // silently matching zero items and blaming the locale set.
    const items = [...html.matchAll(/<li\b[^>]*\bclass="[^"]*\blang-switch__option\b[^"]*"[\s\S]*?<\/li>/g)]
      .map((m) => m[0])
      .map((li) => ({
        lang: (li.match(/\bdata-value="([^"]+)"/) || [])[1],
        flag: (li.match(/<img\b[^>]*\bsrc="([^"]+)"/) || [])[1],
        label: (li.match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1],
      }));

    assert.deepEqual(items.map((i) => i.lang).sort(), [...ALL_LANGS].sort(),
      `${page}: the switcher listbox does not match the locale set`);

    for (const { lang, flag, label } of items) {
      const locale = ALL_LOCALES.find((l) => l.lang === lang);
      assert.equal(flag, LANG_FLAG[lang], `${page}: wrong flag for ${lang}`);
      assert.equal(label, locale.label, `${page}: wrong native label for ${lang}`);
    }
  }
});
