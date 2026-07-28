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

// ── The render-blocking gates' inlined locale-prefix regex ────────────────────
//
// ai-designer-gate.js and masking-studio-gate.js run as classic <script src> in
// <head> with no defer, BEFORE anything paints, so they cannot `import` the
// generated locale-data.js — an ES module is deferred by definition, and the gate
// would fire after the page it exists to hide. Each therefore inlines the same
// prefix regex and its own copy of localeTarget().
//
// The copies are defensible; the silence was not. The guard above catches a file
// naming three or more languages ('spanish', 'french', …) — these hardcode
// two-letter PREFIXES, which it cannot see. So an eleventh locale would leave both
// regexes short with nothing failing: a signed-out visitor on /pl/ai-designer.html
// is bounced to the ENGLISH homepage instead of /pl, and a signed-in one whose plan
// check stalls is thrown out of their language six seconds later. No error, no
// failed request — just the wrong language.
//
// So these assertions are behavioural rather than textual: the real function is
// pulled out of the source and run against every prefix the server serves.

const GATE_FILES = ['ai-designer-gate.js', 'masking-studio-gate.js'];

/** Read a gate's source. */
function gateSource(name) {
  return fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
}

/** Extract `function localeTarget(…) { … }` by brace matching. */
function extractLocaleTarget(src, name) {
  const start = src.indexOf('function localeTarget');
  assert.notEqual(start, -1, `${name}: no localeTarget() — the localized redirect is gone`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces in localeTarget()`);
}

/** Compile a gate's real localeTarget against a stubbed `location`. */
function compileLocaleTarget(name) {
  const body = extractLocaleTarget(gateSource(name), name);
  // `location` is a free variable inside the function, so passing it as a
  // parameter shadows the global: this runs the shipped code against a fake URL.
  const factory = new Function('location', `${body}; return localeTarget;`);
  return (pathname, rel) => factory({ pathname })(rel);
}

test('DRIFT GUARD: the classic gates hardcode exactly the server locale prefixes', () => {
  // Matches the head of the inlined regex: /^\/( es|fr|… )
  const ALTERNATION = new RegExp(String.raw`/\^\\/\(([a-z]{2}(?:\|[a-z]{2})+)\)`, 'g');

  const found = new Map();
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(SCRIPTS, full).replace(/\\/g, '/');
      for (const m of fs.readFileSync(full, 'utf8').matchAll(ALTERNATION)) {
        found.set(rel, (found.get(rel) || []).concat([m[1].split('|')]));
      }
    }
  };
  scan(SCRIPTS);

  // Exactly these two files may carry a hardcoded prefix list. A third one is a new
  // copy nobody will remember to update; one going missing means the localized
  // redirect was dropped.
  assert.deepEqual([...found.keys()].sort(), [...GATE_FILES].sort(),
    'the set of scripts inlining a locale-prefix regex changed — a new one needs a reason ' +
    '(it must be render-blocking, so it cannot import locale-data.js) and this list needs updating');

  const expected = [...LOCALES.map((l) => l.prefix)].sort();
  for (const [file, lists] of found) {
    for (const prefixes of lists) {
      assert.deepEqual([...prefixes].sort(), expected,
        `${file} lists ${prefixes.length} prefixes but the server serves ${expected.length} — ` +
        'update the inlined regex (it cannot import locale-data.js)');
    }
  }
});

test('DRIFT GUARD: each gate keeps the visitor in their language, for every served locale', () => {
  // The assertion that encodes the actual bug: add a locale to locales.js and this
  // fails for it, because the gate's regex would not match and the redirect would
  // drop that visitor at the English root.
  for (const name of GATE_FILES) {
    const localeTarget = compileLocaleTarget(name);
    const rel = name.startsWith('ai-designer') ? 'index.html#ai-designer-demo' : 'stagify-plus.html';

    for (const { prefix } of LOCALES) {
      const from = `/${prefix}/${name.replace('-gate.js', '.html')}`;
      const target = localeTarget(from, rel);
      assert.ok(target.startsWith(`/${prefix}`),
        `${name}: from ${from} the redirect went to "${target}" — outside /${prefix}`);
    }

    // English is the unprefixed root: the relative target is returned untouched.
    assert.equal(localeTarget('/ai-designer.html', rel), rel, `${name}: English must not gain a prefix`);
    assert.equal(localeTarget('/', rel), rel);
  }
});

test('the two gates resolve a target identically, and only for real prefixes', () => {
  const [ai, ms] = GATE_FILES.map(compileLocaleTarget);

  // The two copies must not drift from each other either.
  assert.equal(
    extractLocaleTarget(gateSource(GATE_FILES[0]), GATE_FILES[0]),
    extractLocaleTarget(gateSource(GATE_FILES[1]), GATE_FILES[1]),
    'the two inlined localeTarget() copies have diverged — fix both, or neither is trustworthy',
  );

  for (const target of [ai, ms]) {
    // A path that merely STARTS with a prefix is not that locale: '/estonia' is not
    // Spanish. The trailing (\/|$) is what makes that true, so pin it.
    assert.equal(target('/estonia/page.html', 'index.html'), 'index.html');
    assert.equal(target('/english', 'index.html'), 'index.html');
    // The bare prefix, with or without a trailing slash, IS the locale root.
    assert.equal(target('/es', 'index.html'), '/es');
    assert.equal(target('/es/', 'index.html'), '/es');
  }

  // index.html collapses to the locale root rather than /de/index.html, and a hash
  // or query rides along untouched.
  assert.equal(ai('/de/ai-designer.html', 'index.html#ai-designer-demo'), '/de#ai-designer-demo');
  assert.equal(ms('/ja/masking-studio.html', 'stagify-plus.html'), '/ja/stagify-plus.html');
  assert.equal(ms('/nl/masking-studio.html', 'stagify-plus.html?x=1'), '/nl/stagify-plus.html?x=1');
});
