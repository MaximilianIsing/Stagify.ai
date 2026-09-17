// Tier: unit — scripts/blog-pack.js and the translation packs under public/blog/i18n/.
//
// WHAT THIS COVERS
// The packs are machine-translated into ten languages nobody on the team reads end to
// end. That makes the usual review loop unavailable, so the guarantees have to be
// structural, and they have to be checked here rather than trusted at write time:
//
//   1. STALENESS. A pack records the fingerprint of the English article it was made
//      from. Edit the article and the fingerprint moves, and this file goes red until
//      the translations are redone. Without it the English quietly improves for months
//      while ten languages serve the original draft, and nothing anywhere says so.
//   2. STRUCTURE. A translation must reproduce the English body's tag sequence and its
//      exact set of links. A model that merges two paragraphs or localizes an href
//      produces something that still looks like fluent Spanish — the defect is
//      invisible unless a machine compares shapes.
//   3. COMPLETENESS. Every slot the renderer names must be present and non-empty, or
//      the page silently falls back to English mid-article.
//
// `reviewed` is asserted to EXIST and be a boolean, and deliberately not asserted to be
// true: nobody has read these yet, and pretending otherwise in a test would be the
// wrong kind of green. Turning it into a gate is a one-line change here, marked below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { articleSourceHash, extractArticleStrings, hubSourceHash } from '../../lib/content/article-extract.js';
import { verifyPack, verifyHubPack, checkPacks, US_SPECIFIC } from '../../scripts/blog-pack.js';
import { ARTICLES_BY_SLUG, LOCALES, localeByLang } from '../../lib/i18n/locales.js';
import { PACK_ROOT, scanBlogPacks } from '../../lib/i18n/blog-packs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(REPO_ROOT, 'public');
const PACKS = path.join(PUBLIC, ...PACK_ROOT.split('/'));
const ARTICLE_SLUGS = [...ARTICLES_BY_SLUG.keys()];

/**
 * Every ARTICLE pack on disk as { slug, lang, file, pack }.
 *
 * Underscore-prefixed directories are skipped: `_hub` holds the blog index's own pack,
 * which has a different shape (cards keyed by slug, no body) and its own checks below.
 * No article slug can collide with it — BLOG_SLUG_PATTERN requires an alphanumeric first
 * character.
 */
function everyPack() {
  const out = [];
  if (!fs.existsSync(PACKS)) return out;
  for (const slug of fs.readdirSync(PACKS)) {
    if (slug.startsWith('_')) continue;
    const dir = path.join(PACKS, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const file = path.join(dir, name);
      out.push({ slug, lang: name.slice(0, -'.json'.length), file, pack: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
  }
  return out;
}

/** The English article HTML for a slug. */
function englishHtml(slug) {
  return fs.readFileSync(path.join(PUBLIC, ...ARTICLES_BY_SLUG.get(slug).file.split('/')), 'utf8');
}

test('every pack belongs to a real article and a language this site serves', () => {
  for (const { slug, lang, file } of everyPack()) {
    assert.ok(ARTICLES_BY_SLUG.has(slug), `${file}: '${slug}' is not in LOCALIZED_ARTICLES`);
    const locale = localeByLang(lang);
    assert.ok(locale, `${file}: '${lang}' is not a language in LOCALES`);
    assert.ok(locale.prefix, `${file}: english.json is the SOURCE, never a translation pack`);
  }
});

test('no pack is stale: every fingerprint matches its English article', () => {
  const stale = [];
  for (const { slug, lang, pack } of everyPack()) {
    if (pack?._meta?.sourceHash !== articleSourceHash(englishHtml(slug))) stale.push(`${slug}/${lang}`);
  }
  assert.deepEqual(
    stale,
    [],
    'these translations were made from an older version of their English article. Retranslate '
      + 'them (the English strings are `node scripts/blog-pack.js extract <slug> <out.json>`, and '
      + '`node scripts/blog-pack.js add <slug> <lang> <file>` re-stamps the fingerprint), then '
      + 'rerun `node scripts/build-i18n-seo.js`',
  );
});

test('every pack reproduces its English article structurally', () => {
  // The real check: tag sequence, link set, no injected markup, balanced tags. Run
  // through the same function scripts/blog-pack.js gates writes with, so a pack edited
  // by hand after the fact is caught exactly like one that was never valid.
  for (const { slug, lang, pack } of everyPack()) {
    assert.deepEqual(verifyPack(slug, pack), [], `${slug}/${lang}`);
  }
});

test('every pack carries the metadata this repo owns, and nothing it does not', () => {
  for (const { slug, lang, pack } of everyPack()) {
    const meta = pack._meta;
    assert.ok(meta, `${slug}/${lang}: no _meta`);
    assert.match(meta.sourceHash, /^sha256:[0-9a-f]{64}$/, `${slug}/${lang}: malformed fingerprint`);
    assert.equal(meta.slug, slug, `${slug}/${lang}: _meta.slug disagrees with its folder`);
    assert.equal(meta.lang, lang, `${slug}/${lang}: _meta.lang disagrees with its filename`);
    assert.equal(meta.hreflang, localeByLang(lang).hreflang, `${slug}/${lang}: wrong hreflang`);
    assert.match(meta.translatedAt, /^\d{4}-\d{2}-\d{2}$/, `${slug}/${lang}: malformed translatedAt`);
    assert.equal(meta.marketNote, US_SPECIFIC.has(slug), `${slug}/${lang}: marketNote disagrees with US_SPECIFIC`);

    // Recorded, not enforced. Change this to `assert.equal(meta.reviewed, true, …)` to
    // turn the review gate on once someone has actually read the translations.
    assert.equal(typeof meta.reviewed, 'boolean', `${slug}/${lang}: reviewed must be a boolean`);
  }
});

test('a pack holds exactly the slots the English article has', () => {
  // A stray key is harmless to the renderer but means the translator invented something,
  // and a missing one means a paragraph of the page silently stays English.
  for (const { slug, lang, pack } of everyPack()) {
    const english = extractArticleStrings(englishHtml(slug));
    const expected = new Set([...Object.keys(english), '_meta']);
    const actual = new Set(Object.keys(pack));
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${slug}/${lang}: slot set differs from English`);
    assert.deepEqual(
      Object.keys(pack.cta).sort(),
      Object.keys(english.cta).sort(),
      `${slug}/${lang}: cta slots differ`,
    );
  }
});

test('the market-note callout appears only on the US-specific articles', () => {
  for (const { slug, lang, pack } of everyPack()) {
    const english = extractArticleStrings(englishHtml(slug));
    const englishCallouts = (english.body.match(/<div class="article-callout"/g) || []).length;
    const packCallouts = (pack.body.match(/<div class="article-callout"/g) || []).length;
    const allowed = US_SPECIFIC.has(slug) ? englishCallouts + 1 : englishCallouts;
    assert.ok(
      packCallouts === englishCallouts || packCallouts === allowed,
      `${slug}/${lang}: ${packCallouts} callouts, English has ${englishCallouts} (max ${allowed})`,
    );
  }
});

test('checkPacks agrees with the filesystem', () => {
  const report = checkPacks();
  assert.deepEqual(report.broken, [], 'scripts/blog-pack.js check reports broken packs');
  assert.deepEqual(report.stale, [], 'scripts/blog-pack.js check reports stale packs');
  assert.equal(report.ok.length, everyPack().length, 'checkPacks and the pack scan disagree on how many packs exist');
});

test('the manifest and the packs on disk describe the same matrix', () => {
  // scanBlogPacks feeds the generated manifest; this asserts the scan itself matches
  // what is really there, which is the half test/i18n/blog-manifest.test.js assumes.
  const fromDisk = {};
  for (const { slug, lang } of everyPack()) {
    const prefix = localeByLang(lang).prefix;
    (fromDisk[slug] ||= []).push(prefix);
  }
  for (const slug of Object.keys(fromDisk)) {
    fromDisk[slug] = LOCALES.filter((l) => fromDisk[slug].includes(l.prefix)).map((l) => l.prefix);
  }
  assert.deepEqual(scanBlogPacks(PUBLIC), fromDisk);
});

// --- the hub's own pack ---------------------------------------------------------------

/** Every hub pack on disk as { lang, pack }. */
function everyHubPack() {
  const dir = path.join(PACKS, '_hub');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ lang: f.slice(0, -'.json'.length), pack: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

test('no hub pack is stale', () => {
  // The hub's cards carry their own copy, so editing one card's excerpt has to invalidate
  // the hub translations exactly the way editing an article invalidates its own.
  const hubHtml = fs.readFileSync(path.join(PUBLIC, 'blog', 'index.html'), 'utf8');
  const want = hubSourceHash(hubHtml);
  const stale = everyHubPack().filter(({ pack }) => pack?._meta?.sourceHash !== want).map((p) => p.lang);
  assert.deepEqual(
    stale,
    [],
    'the hub copy moved since these were translated — retranslate with '
      + '`node scripts/blog-pack.js extract-hub <out.json>` and `add-hub <lang> <file>`',
  );
});

test('every hub pack carries a card for every article', () => {
  // Not just the articles this locale has today: which cards survive is decided per
  // request from the manifest, so a pack missing a card would leave that card in English
  // the day its article is translated — a gap nobody would think to look for.
  for (const { lang, pack } of everyHubPack()) {
    assert.deepEqual(verifyHubPack(pack), [], `hub/${lang}`);
    assert.deepEqual(
      Object.keys(pack.cards).sort(),
      ARTICLE_SLUGS.slice().sort(),
      `hub/${lang}: card set differs from the article catalog`,
    );
  }
});

test('hub strings are plain text, and hub metadata is stamped by us', () => {
  for (const { lang, pack } of everyHubPack()) {
    assert.equal(pack._meta.lang, lang, `hub/${lang}: _meta.lang disagrees with its filename`);
    assert.equal(pack._meta.slug, null, 'the hub has no slug');
    assert.equal(pack._meta.hreflang, localeByLang(lang).hreflang, `hub/${lang}: wrong hreflang`);
    assert.equal(typeof pack._meta.reviewed, 'boolean', `hub/${lang}: reviewed must be a boolean`);
    for (const [slug, card] of Object.entries(pack.cards)) {
      for (const [field, value] of Object.entries(card)) {
        assert.ok(!/[<>]/.test(value), `hub/${lang}: cards.${slug}.${field} contains markup`);
      }
    }
  }
});
