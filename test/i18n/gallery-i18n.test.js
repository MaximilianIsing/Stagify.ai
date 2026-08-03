// Drift guard between the gallery's copy and the language packs.
//
// The gallery is the one localized page with NO localized URL: it is absent from
// LOCALIZED_PAGES on purpose, so it is never server-rendered per language and instead
// swaps the pack in place ([data-lang-inplace] in public/gallery.html). That makes every
// string here a runtime lookup with an English fallback — and a fallback is exactly what
// hides a missing key. English looks perfect while a German visitor reads half a page of
// English, and nothing fails.
//
// Same shape as unstageable-i18n.test.js, which exists for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES, LOCALIZED_PAGES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

// English is served at the root as static files rather than through a LOCALES entry,
// so pull it in explicitly — it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];
const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));

/** Every leaf of an object as `a.b.c` -> string. */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') Object.assign(out, flatten(value, at));
    else out[at] = value;
  }
  return out;
}

/** `{count}`-style placeholders in a template. */
const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

const ENGLISH = flatten(packFor('english').gallery);

// The plural forms only Russian supplies. They are legitimately absent elsewhere —
// scripts/gallery/i18n.js reads a pack WITHOUT `few` as one/other, which is what keeps
// English's "21 staged rooms" correct while Russian gets "21 оформленная комната".
const OPTIONAL = /\.few$/;

test('sanity: the English gallery block is substantial and interpolated', () => {
  // Without this every assertion below passes vacuously if the namespace disappears.
  assert.ok(Object.keys(ENGLISH).length >= 45, `expected the full gallery copy, found ${Object.keys(ENGLISH).length} keys`);
  assert.equal(ENGLISH['count.other'], '{count} staged rooms');
});

test('every language pack carries the whole gallery namespace', () => {
  const missing = [];
  for (const lang of LANGS) {
    const block = packFor(lang).gallery;
    assert.ok(block, `${lang}.json has no gallery block`);
    const flat = flatten(block);
    for (const key of Object.keys(ENGLISH)) {
      const value = flat[key];
      if (typeof value !== 'string' || !value.trim()) missing.push(`${lang}.json: gallery.${key}`);
    }
  }
  assert.deepEqual(missing, [], `missing or empty gallery string(s):\n${missing.join('\n')}`);
});

test('no pack carries a gallery key the page never asks for', () => {
  // Stale copy is copy translators keep maintaining for nothing, and it usually means a
  // key was renamed without a pack update.
  const stale = [];
  for (const lang of LANGS) {
    for (const key of Object.keys(flatten(packFor(lang).gallery))) {
      if (key in ENGLISH || OPTIONAL.test(key)) continue;
      stale.push(`${lang}.json: gallery.${key}`);
    }
  }
  assert.deepEqual(stale, [], `stale gallery key(s):\n${stale.join('\n')}`);
});

test('every translation keeps the placeholders its English original has', () => {
  // The failure this catches is worse than a missing translation: a dropped {count}
  // renders "staged rooms" with no number, and a renamed one renders the literal brace.
  const broken = [];
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const flat = flatten(packFor(lang).gallery);
    for (const [key, english] of Object.entries(ENGLISH)) {
      const wanted = placeholders(english);
      if (!wanted.size || typeof flat[key] !== 'string') continue;
      const got = placeholders(flat[key]);
      for (const name of wanted) {
        if (!got.has(name)) broken.push(`${lang}.json: gallery.${key} lost {${name}}`);
      }
      for (const name of got) {
        if (!wanted.has(name)) broken.push(`${lang}.json: gallery.${key} invented {${name}}`);
      }
    }
  }
  assert.deepEqual(broken, [], `placeholder mismatch:\n${broken.join('\n')}`);
});

test('a pack that supplies a `few` plural supplies the other two as well', () => {
  // scripts/gallery/i18n.js switches to the Slavic rule the moment `few` exists, so a
  // half-filled group would start resolving to undefined and fall back to English.
  const bad = [];
  for (const lang of LANGS) {
    const flat = flatten(packFor(lang).gallery);
    for (const key of Object.keys(flat).filter((k) => OPTIONAL.test(k))) {
      const base = key.replace(/\.few$/, '');
      for (const form of ['one', 'other']) {
        if (typeof flat[`${base}.${form}`] !== 'string') bad.push(`${lang}.json: gallery.${base} has few but no ${form}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('non-English packs are actually translated, not copies of the English copy', () => {
  // Cheap smoke test for "added the key, forgot to translate it". Scoped to the prose:
  // short UI words legitimately coincide across languages, and a false failure here
  // would train someone to delete the test.
  const PROSE = Object.keys(ENGLISH).filter((k) => ENGLISH[k].length > 40);
  assert.ok(PROSE.length >= 10, 'expected a decent body of prose to check');

  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const flat = flatten(packFor(lang).gallery);
    const copied = PROSE.filter((key) => flat[key] === ENGLISH[key]);
    assert.deepEqual(copied, [], `${lang}.json still has the English text for: ${copied.join(', ')}`);
  }
});

test('every language states the 15-minute delay on taking a share link down', () => {
  // The English copy says "within 15 minutes", never "immediately", because image URLs
  // are presigned and one already handed out keeps working until it expires — there is a
  // test in gallery-app.test.js pinning that. A translation that rounded it to "at once"
  // would be the same bug in another language, and nothing else would catch it.
  // Checking for the digits is crude, but it is language-independent and it is the part
  // that must survive translation.
  for (const lang of LANGS) {
    assert.match(packFor(lang).gallery.share.note, /15/, `${lang}.json: gallery.share.note drops the 15-minute delay`);
  }
});

test('no pack still offers to create a link or turn one off', () => {
  // The keys are gone from english.json, so the stale-key test above already fails a pack
  // that keeps them — this states WHY, and catches the reverse mistake of somebody adding
  // the copy back to English on the way to rebuilding the buttons.
  for (const lang of LANGS) {
    const share = packFor(lang).gallery.share;
    for (const dead of ['create', 'creating', 'created', 'createFailed', 'revoke', 'revoked', 'revokeFailed', 'none', 'unreadable']) {
      assert.ok(!(dead in share), `${lang}.json: gallery.share.${dead} describes a control that no longer exists`);
    }
    assert.ok(!('linkOn' in packFor(lang).gallery), `${lang}.json: the "link on" badge is gone from the grid`);
  }
});

test('the gallery swaps language in place, and it is the only page that does', () => {
  // hrefForLanguage() sends a page with no localized URL to the locale HOME
  // (i18n-routing.js:59). That is right for a link and wrong for a switcher — the
  // visitor asked to read THIS page in another language. The gallery therefore opts out
  // of navigating. The "only page" half is the important one: every other page carrying
  // a switcher IS in LOCALIZED_PAGES, which is why this change cannot affect them.
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const marked = pages.filter((f) => /data-lang-inplace/.test(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')));
  assert.deepEqual(marked, ['gallery.html'], 'a second page opted out of localized-URL navigation');

  const loader = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'language-loader.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(loader, /data-lang-inplace/, 'the loader no longer reads the opt-out marker');
  assert.match(loader, /if \(!inPlace\)[\s\S]{0,120}location\.assign/, 'the navigate is no longer gated on the marker');
});

test('a page that opts out of navigating is genuinely not localizable by URL', () => {
  // The opt-out is only correct BECAUSE the page has no localized variant. If the
  // gallery were ever added to LOCALIZED_PAGES, in-place swapping would be the wrong
  // behaviour and the marker would have to come back out.
  assert.ok(!LOCALIZED_PAGES.some((p) => p.file === 'gallery.html'),
    'gallery.html gained a localized URL — remove [data-lang-inplace] and let the switcher navigate');
});

test('the shipped markup keeps an English fallback for every gallery data-lang key', () => {
  // The page is static English with the pack applied over it, so the markup IS the
  // fallback a visitor sees before the fetch resolves. An empty element would flash blank.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'gallery.html'), 'utf8');
  const used = [...html.matchAll(/data-lang="(gallery\.[\w.]+)"[^>]*>([^<]*)/g)];
  assert.ok(used.length >= 10, `expected the page to use the namespace, found ${used.length} keys`);

  for (const [, key, text] of used) {
    const short = key.replace(/^gallery\./, '');
    assert.ok(short in ENGLISH, `gallery.html uses ${key}, which english.json does not define`);
    assert.ok(text.trim().length > 0, `gallery.html leaves ${key} empty, so it flashes blank before the pack loads`);
  }
});
