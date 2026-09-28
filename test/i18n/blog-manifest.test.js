// Tier: unit — lib/i18n/blog-packs.js and the generated lib/i18n/blog-i18n-manifest.js.
//
// WHAT THIS COVERS
// The manifest is the single answer to "which blog article exists in which language",
// and four different things read it: the hreflang clusters baked into the English
// articles, the sitemap rows, the localized routes, and the hub's card grid. They agree
// only because they all read the same generated file — so the file has to match the packs
// actually sitting on disk.
//
// WHY IT IS COMMITTED RATHER THAN SCANNED. buildSitemap() is byte-compared against the
// committed public/sitemap.xml by test/i18n/i18n.test.js, so it must be a pure function;
// and routes/i18n.js registers routes at mount time without touching the filesystem. The
// cost of that choice is exactly one failure mode — someone adds a pack and forgets to
// rerun the build — and this file is what turns that into a red build rather than an
// hreflang pointing at a 404.
//
// The same idiom, and the same reasoning, as public/scripts/i18n/locale-data.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGLISH, LOCALES, LOCALIZED_ARTICLES, BLOG_HUB, LOCALIZED_BLOG_PATHS } from '../../lib/i18n/locales.js';
import {
  buildBlogManifestModule,
  scanBlogPacks,
  articleLocales,
  localesForHub,
  articlesForLocale,
  slugsForLocale,
  publishedArticlePages,
  packDirFor,
} from '../../lib/i18n/blog-packs.js';
import { BLOG_PACK_LOCALES } from '../../lib/i18n/blog-i18n-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(REPO_ROOT, 'public');
const MANIFEST = path.join(REPO_ROOT, 'lib', 'i18n', 'blog-i18n-manifest.js');

const PREFIXES = new Set(LOCALES.map((l) => l.prefix));
const SLUGS = new Set(LOCALIZED_ARTICLES.map((a) => a.slug));

test('the committed manifest matches the packs on disk', () => {
  const committed = fs.readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
  const generated = buildBlogManifestModule(PUBLIC);
  assert.equal(
    committed,
    generated,
    'lib/i18n/blog-i18n-manifest.js is out of date — rerun `node scripts/build-i18n-seo.js` ' +
      'and commit the result (it also refreshes the sitemap and the baked hreflang clusters)',
  );
});

test('every slug in the manifest is a real article', () => {
  for (const slug of Object.keys(BLOG_PACK_LOCALES)) {
    assert.ok(
      SLUGS.has(slug),
      `manifest lists '${slug}', which is not in LOCALIZED_ARTICLES — a pack under ` +
        `public/${packDirFor(slug)}/ for a post that does not exist would route nowhere`,
    );
  }
});

test('every prefix in the manifest is a language this site serves', () => {
  for (const [slug, prefixes] of Object.entries(BLOG_PACK_LOCALES)) {
    for (const prefix of prefixes) {
      assert.ok(prefix, `${slug}: '' is English, which is the source and never a pack`);
      assert.ok(PREFIXES.has(prefix), `${slug}: manifest lists prefix '${prefix}', which is not in LOCALES`);
    }
    assert.ok(prefixes.length > 0, `${slug}: an empty prefix list should be an absent key, not an empty array`);
    assert.deepEqual([...new Set(prefixes)], prefixes, `${slug}: duplicate prefixes`);
  }
});

test('manifest prefixes are in LOCALES order, so the generated file is stable', () => {
  // Directory order varies by filesystem. If the scan leaked it, the manifest would
  // differ between a developer's machine and CI and this file's first test would fail
  // for a reason that has nothing to do with the packs.
  const order = LOCALES.map((l) => l.prefix);
  for (const [slug, prefixes] of Object.entries(BLOG_PACK_LOCALES)) {
    const sorted = order.filter((p) => prefixes.includes(p));
    assert.deepEqual(prefixes, sorted, `${slug}: prefixes are not in LOCALES order`);
  }
});

test('the scan ignores files that are not packs for a served language', () => {
  const scanned = scanBlogPacks(PUBLIC);
  assert.deepEqual(scanned, BLOG_PACK_LOCALES, 'scanBlogPacks and the committed manifest disagree');
});

test('a missing pack directory is an English-only article, not an error', () => {
  // The normal state for most of the catalog during rollout: scanning must not throw,
  // and the article must simply report English.
  const withoutPacks = LOCALIZED_ARTICLES.filter((a) => !BLOG_PACK_LOCALES[a.slug]);
  for (const article of withoutPacks) {
    assert.deepEqual(articleLocales(article.slug), [ENGLISH], `${article.slug} should be English-only`);
  }
});

test('articleLocales always starts with English and never repeats a locale', () => {
  for (const article of LOCALIZED_ARTICLES) {
    const locales = articleLocales(article.slug);
    assert.equal(locales[0], ENGLISH, `${article.slug}: English is the source and leads the cluster`);
    assert.ok(locales.length >= 1, `${article.slug}: an article always has at least its English self`);
    const prefixes = locales.map((l) => l.prefix);
    assert.deepEqual([...new Set(prefixes)], prefixes, `${article.slug}: duplicate locale`);
  }
});

test('the hub is published in English plus every locale with at least one article', () => {
  const live = new Set();
  for (const prefixes of Object.values(BLOG_PACK_LOCALES)) for (const p of prefixes) live.add(p);

  const hub = localesForHub();
  assert.equal(hub[0], ENGLISH);
  assert.deepEqual(
    hub.slice(1).map((l) => l.prefix).sort(),
    [...live].sort(),
    'a locale earns a hub by having something to put on it, and loses it when it has nothing',
  );
  assert.deepEqual(articleLocales(BLOG_HUB.slug), hub, 'the hub is addressed by a null slug');
});

test('articlesForLocale and slugsForLocale agree with the manifest', () => {
  assert.equal(articlesForLocale('').length, LOCALIZED_ARTICLES.length, 'English has every article');
  for (const locale of LOCALES) {
    const expected = LOCALIZED_ARTICLES.filter((a) => (BLOG_PACK_LOCALES[a.slug] || []).includes(locale.prefix));
    assert.deepEqual(articlesForLocale(locale.prefix), expected, locale.prefix);
    assert.deepEqual(slugsForLocale(locale.prefix), new Set(expected.map((a) => a.slug)), locale.prefix);
  }
});

test('publishedArticlePages lists exactly the non-English pages that exist', () => {
  const pages = publishedArticlePages();
  const expected = Object.entries(BLOG_PACK_LOCALES).reduce((n, [, prefixes]) => n + prefixes.length, 0);
  assert.equal(pages.length, expected, 'one page per (article, translated locale) pair');
  for (const { locale, article } of pages) {
    assert.ok(locale.prefix, 'English articles are static files, not rendered routes');
    assert.ok(
      (BLOG_PACK_LOCALES[article.slug] || []).includes(locale.prefix),
      `${article.slug}/${locale.prefix} has no pack`,
    );
  }
});

test('every article and the hub has a unique path, and LOCALIZED_BLOG_PATHS mirrors them', () => {
  const paths = [BLOG_HUB.path, ...LOCALIZED_ARTICLES.map((a) => a.path)];
  assert.deepEqual([...new Set(paths)], paths, 'duplicate blog path');
  assert.deepEqual(LOCALIZED_BLOG_PATHS, new Set(paths));
  for (const article of LOCALIZED_ARTICLES) {
    assert.equal(article.path, `/blog/${article.slug}`, `${article.slug}: path must be derivable from the slug`);
    assert.equal(article.file, `blog/${article.slug}.html`, `${article.slug}: file must be derivable from the slug`);
    assert.ok(
      fs.existsSync(path.join(PUBLIC, ...article.file.split('/'))),
      `${article.slug}: ${article.file} does not exist`,
    );
  }
  assert.ok(fs.existsSync(path.join(PUBLIC, ...BLOG_HUB.file.split('/'))), 'the hub file must exist');
});

test('blog paths stay OUT of the marketing page set', () => {
  // LOCALIZED_PATHS is mirrored into the browser by locale-data.js, where it drives the
  // language switcher's href. An article in there would have the switcher promise a
  // Japanese copy of every post regardless of which packs exist.
  return import('../../lib/i18n/locales.js').then(({ LOCALIZED_PATHS }) => {
    for (const p of LOCALIZED_BLOG_PATHS) {
      assert.equal(LOCALIZED_PATHS.has(p), false, `${p} must not be in LOCALIZED_PATHS`);
    }
  });
});
