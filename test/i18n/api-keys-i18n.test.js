// Drift guard between the API dashboard's copy and the language packs.
//
// Like the gallery, this page has NO localized URL — it is noindex, behind a session,
// and deliberately absent from LOCALIZED_PAGES — so it swaps the pack in place
// ([data-lang-inplace] in public/api-keys.html) and every string is a runtime lookup
// with an English fallback.
//
// A FALLBACK IS EXACTLY WHAT HIDES A MISSING KEY. English looks perfect while a German
// visitor reads half a dashboard in English, and nothing fails. That is what these
// assertions are for. Same shape as gallery-i18n.test.js and unstageable-i18n.test.js,
// which exist for the same reason.
//
// The general english→others parity gate in test/server/static.test.js already catches a
// key missing from a pack. What it CANNOT catch, and what is below: a key nothing on the
// page asks for, a placeholder dropped in translation, a half-filled plural group, and a
// "translation" that is still the English sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES, LOCALIZED_PAGES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');
const PUBLIC = path.join(ROOT, 'public');

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

const ENGLISH = flatten(packFor('english').apiKeys);

// The plural forms only Russian supplies. They are legitimately absent elsewhere —
// scripts/api-keys/i18n.js reads a pack WITHOUT `few` as one/other, which is what keeps
// English's "21 credits" correct while Russian gets "21 кредит".
const OPTIONAL = /\.few$/;

/** Every source file that can look a key up, plus the page itself. */
function sources() {
  const dir = path.join(PUBLIC, 'scripts', 'api-keys');
  return [
    fs.readFileSync(path.join(PUBLIC, 'api-keys.html'), 'utf8'),
    fs.readFileSync(path.join(PUBLIC, 'scripts', 'api-keys-app.js'), 'utf8'),
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
  ].join('\n');
}

test('sanity: the English apiKeys block is substantial and interpolated', () => {
  // Without this every assertion below passes vacuously if the namespace disappears.
  assert.ok(
    Object.keys(ENGLISH).length >= 100,
    `expected the full dashboard copy, found ${Object.keys(ENGLISH).length} keys`,
  );
  assert.equal(ENGLISH['list.credits.other'], '{count} credits');
  assert.equal(ENGLISH['value.none'], 'n/a');
});

test('every language pack carries the whole apiKeys namespace', () => {
  const missing = [];
  for (const lang of LANGS) {
    const block = packFor(lang).apiKeys;
    assert.ok(block, `${lang}.json has no apiKeys block`);
    const flat = flatten(block);
    for (const key of Object.keys(ENGLISH)) {
      const value = flat[key];
      if (typeof value !== 'string' || !value.trim()) missing.push(`${lang}.json: apiKeys.${key}`);
    }
  }
  assert.deepEqual(missing, [], `missing or empty apiKeys string(s):\n${missing.join('\n')}`);
});

test('no pack carries an apiKeys key the page never asks for', () => {
  // Stale copy is copy translators keep maintaining for nothing, and it usually means a
  // key was renamed without a pack update.
  const stale = [];
  for (const lang of LANGS) {
    for (const key of Object.keys(flatten(packFor(lang).apiKeys))) {
      if (key in ENGLISH || OPTIONAL.test(key)) continue;
      stale.push(`${lang}.json: apiKeys.${key}`);
    }
  }
  assert.deepEqual(stale, [], `stale apiKeys key(s):\n${stale.join('\n')}`);
});

test('every English key is actually reachable from the page', () => {
  // The other direction of the same problem: copy nobody renders. A plural group is
  // asked for by its BASE (`plural('apiKeys.ago.minutes', …)`), so the forms are matched
  // by stripping the trailing `.one` / `.other`.
  const src = sources();
  const unused = [];
  for (const key of Object.keys(ENGLISH)) {
    const base = key.replace(/\.(one|other)$/, '');
    if (src.includes(`apiKeys.${key}`) || src.includes(`apiKeys.${base}`)) continue;
    // The ledger's reason labels are looked up by a computed path — `'apiKeys.ledger.' +
    // reason` — so the literal never appears. Their codes come from the database.
    if (/^ledger\./.test(key)) continue;
    // Likewise the three key states: `t('apiKeys.status.' + status, …)`.
    if (/^status\./.test(key)) continue;
    unused.push(`apiKeys.${key}`);
  }
  assert.deepEqual(unused, [], `English copy no source file asks for:\n${unused.join('\n')}`);
});

test('every translation keeps the placeholders its English original has', () => {
  // The failure this catches is worse than a missing translation: a dropped {count}
  // renders "credits" with no number, and a renamed one renders the literal brace.
  const broken = [];
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const flat = flatten(packFor(lang).apiKeys);
    for (const [key, english] of Object.entries(ENGLISH)) {
      const wanted = placeholders(english);
      if (!wanted.size || typeof flat[key] !== 'string') continue;
      const got = placeholders(flat[key]);
      for (const name of wanted) {
        if (!got.has(name)) broken.push(`${lang}.json: apiKeys.${key} lost {${name}}`);
      }
      for (const name of got) {
        if (!wanted.has(name)) broken.push(`${lang}.json: apiKeys.${key} invented {${name}}`);
      }
    }
  }
  assert.deepEqual(broken, [], `placeholder mismatch:\n${broken.join('\n')}`);
});

test('a pack that supplies a `few` plural supplies the other two as well', () => {
  // scripts/api-keys/i18n.js switches to the Slavic rule the moment `few` exists, so a
  // half-filled group would start resolving to undefined and fall back to English.
  const bad = [];
  for (const lang of LANGS) {
    const flat = flatten(packFor(lang).apiKeys);
    for (const key of Object.keys(flat).filter((k) => OPTIONAL.test(k))) {
      const base = key.replace(/\.few$/, '');
      for (const form of ['one', 'other']) {
        if (typeof flat[`${base}.${form}`] !== 'string') {
          bad.push(`${lang}.json: apiKeys.${base} has few but no ${form}`);
        }
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
    const flat = flatten(packFor(lang).apiKeys);
    const copied = PROSE.filter((key) => flat[key] === ENGLISH[key]);
    assert.deepEqual(copied, [], `${lang}.json still has the English text for: ${copied.join(', ')}`);
  }
});

test('every language keeps the mailto address in the suspended notice', () => {
  // It is the only way out of a suspended account, it is rendered with data-lang-html,
  // and a translation that dropped the anchor would leave a dead end that nothing else
  // would notice.
  for (const lang of LANGS) {
    const value = packFor(lang).apiKeys.billing.suspended;
    assert.match(value, /mailto:team@stagify\.ai/, `${lang}.json: apiKeys.billing.suspended lost the address`);
  }
});

test('every language states UTC in the sample footnote', () => {
  // The buckets are UTC days (lib/data/api-billing.js), and the footnote is the only
  // place the page says so. A translation that dropped it would leave a reader in
  // Auckland quietly comparing our days against theirs.
  for (const lang of LANGS) {
    assert.match(
      packFor(lang).apiKeys.usage.sampleNote,
      /UTC/,
      `${lang}.json: apiKeys.usage.sampleNote drops UTC`,
    );
  }
});

test('the dashboard is still an in-place page, and still has no localized URL', () => {
  // The pairing that makes the whole namespace necessary: were api-keys.html ever added
  // to LOCALIZED_PAGES, it would be server-rendered per language and the marker would
  // have to come out. test/i18n/gallery-i18n.test.js owns the marker sweep; this is the
  // half that belongs with the copy.
  const html = fs.readFileSync(path.join(PUBLIC, 'api-keys.html'), 'utf8');
  assert.match(html, /data-lang-inplace/, 'the picker lost its in-place marker');
  assert.ok(
    !LOCALIZED_PAGES.some((p) => p.file === 'api-keys.html'),
    'api-keys.html gained a localized URL — drop [data-lang-inplace] and let the switcher navigate',
  );
});

test('the shipped markup keeps an English fallback for every apiKeys data-lang key', () => {
  // The page is static English with the pack applied over it, so the markup IS the
  // fallback a visitor sees before the fetch resolves. An empty element would flash blank.
  const html = fs.readFileSync(path.join(PUBLIC, 'api-keys.html'), 'utf8');
  const used = [...html.matchAll(/data-lang="(apiKeys\.[\w.]+)"[^>]*>([^<]*)/g)];
  assert.ok(used.length >= 8, `expected the page to use the namespace, found ${used.length} keys`);

  const empty = used.filter(([, , text]) => !text.trim()).map(([, key]) => key);
  assert.deepEqual(empty, [], `data-lang with no English fallback in the markup: ${empty.join(', ')}`);

  const unknown = used.map(([, key]) => key).filter((key) => !(key.replace(/^apiKeys\./, '') in ENGLISH));
  assert.deepEqual(unknown, [], `markup asks for a key english.json does not have: ${unknown.join(', ')}`);
});
