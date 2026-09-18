// Tier: unit — the localized blog cover images and lib/i18n/blog-covers.js.
//
// WHAT THIS COVERS
// A cover variant is referenced by URL, from markup, and nothing at render time checks the
// file is there. So the two ways this breaks are both silent:
//
//   - the manifest lists a variant that was never rendered → a broken image, in one
//     language, on the page's `og:image`, which is the one image nobody on the team ever
//     loads because it only appears in someone else's Slack unfurl;
//   - a variant was rendered but the manifest was not regenerated → the English cover is
//     served under a translated headline, and everything still looks fine locally.
//
// Both are "you forgot to commit the other half", which is exactly what a drift test is
// for. The English covers are asserted untouched for the same reason: this pipeline writes
// beside them, never over them, and a regression there would hit every reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, LOCALIZED_ARTICLES } from '../../lib/i18n/locales.js';
import { BLOG_COVER_LOCALES } from '../../lib/i18n/blog-covers-manifest.js';
import { localizeCoverUrls, coverLanguages } from '../../lib/i18n/blog-covers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEDIA = path.join(REPO_ROOT, 'public', 'media-webp', 'blog');
const RECIPE = path.join(REPO_ROOT, 'to-build', 'media-png', 'blog', 'covers');

/** Every rendered variant on disk, as coverId → [lang]. */
function variantsOnDisk() {
  /** @type {Record<string, string[]>} */
  const found = {};
  for (const name of fs.readdirSync(MEDIA)) {
    const m = /^(cover-\d+)\.([a-z]+)\.webp$/.exec(name);
    if (!m) continue;
    (found[m[1]] ||= []).push(m[2]);
  }
  return found;
}

test('the manifest matches the variants on disk', () => {
  const disk = variantsOnDisk();
  const order = LOCALES.map((l) => l.lang);
  const normalized = Object.fromEntries(
    Object.entries(disk).map(([id, langs]) => [id, order.filter((l) => langs.includes(l))]),
  );
  assert.deepEqual(
    BLOG_COVER_LOCALES,
    normalized,
    'lib/i18n/blog-covers-manifest.js is out of date — rerun `node scripts/build-blog-covers.js` '
      + 'and commit the manifest with the images',
  );
});

test('every variant the manifest promises has all three files', () => {
  // The page spends a cover on three URLs: the <figure>, the og:image and the card thumb.
  // Rendering the webp but not the jpg is a broken social card only, which is the copy
  // least likely to be noticed and most likely to matter.
  for (const [coverId, langs] of Object.entries(BLOG_COVER_LOCALES)) {
    for (const lang of langs) {
      for (const suffix of ['.webp', '-og.jpg', '-thumb.webp']) {
        const file = path.join(MEDIA, `${coverId}.${lang}${suffix}`);
        assert.ok(fs.existsSync(file), `missing ${path.basename(file)}`);
      }
    }
  }
});

test('every manifest language is one this site serves', () => {
  const known = new Set(LOCALES.map((l) => l.lang));
  for (const [coverId, langs] of Object.entries(BLOG_COVER_LOCALES)) {
    for (const lang of langs) {
      assert.ok(known.has(lang), `${coverId}: '${lang}' is not a language in LOCALES`);
    }
    assert.ok(!langs.includes('english'), `${coverId}: English is the source, never a variant`);
  }
});

test('every localized cover belongs to an article that uses it', () => {
  // A variant of a cover no article references is wasted bytes in the repo, and usually
  // means a recipe was pointed at the wrong base image.
  const referenced = new Set();
  for (const article of LOCALIZED_ARTICLES) {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'public', ...article.file.split('/')), 'utf8');
    for (const m of html.matchAll(/cover-(\d+)\./g)) referenced.add(`cover-${m[1]}`);
  }
  const hub = fs.readFileSync(path.join(REPO_ROOT, 'public', 'blog', 'index.html'), 'utf8');
  for (const m of hub.matchAll(/cover-(\d+)-thumb/g)) referenced.add(`cover-${m[1]}`);

  for (const coverId of Object.keys(BLOG_COVER_LOCALES)) {
    assert.ok(referenced.has(coverId), `${coverId} is localized but no article or card uses it`);
  }
});

test('every recipe has text for every language it claims to render', () => {
  const recipes = JSON.parse(fs.readFileSync(path.join(RECIPE, 'covers.json'), 'utf8'));
  for (const [coverId, langs] of Object.entries(BLOG_COVER_LOCALES)) {
    assert.ok(recipes[coverId], `${coverId} has a rendered variant but no recipe`);
    for (const lang of langs) {
      const textFile = path.join(RECIPE, 'text', `${lang}.json`);
      assert.ok(fs.existsSync(textFile), `${coverId}/${lang}: no text/${lang}.json`);
      const strings = JSON.parse(fs.readFileSync(textFile, 'utf8'))[coverId];
      assert.ok(strings, `${coverId}/${lang}: text/${lang}.json has no entry for this cover`);
    }
  }
});

test('the English covers are untouched by the localized pipeline', () => {
  for (const coverId of Object.keys(BLOG_COVER_LOCALES)) {
    for (const suffix of ['.webp', '-og.jpg', '-thumb.webp']) {
      assert.ok(
        fs.existsSync(path.join(MEDIA, `${coverId}${suffix}`)),
        `${coverId}${suffix} is gone — the localized pipeline writes BESIDE the English covers, never over them`,
      );
    }
  }
});

// --- the URL rewrite -------------------------------------------------------------------

test('a localized page points at its localized cover, in all three URL forms', () => {
  const [coverId, langs] = Object.entries(BLOG_COVER_LOCALES)[0] || [];
  if (!coverId) return; // nothing rendered yet
  const lang = langs[0];
  const html = `<img src="/media-webp/blog/${coverId}.webp">`
    + `<meta property="og:image" content="https://stagify.ai/media-webp/blog/${coverId}-og.jpg">`
    + `<img class="blog-card__thumb" src="/media-webp/blog/${coverId}-thumb.webp">`;
  const out = localizeCoverUrls(html, lang);
  assert.match(out, new RegExp(`${coverId}\\.${lang}\\.webp`));
  assert.match(out, new RegExp(`${coverId}\\.${lang}-og\\.jpg`));
  assert.match(out, new RegExp(`${coverId}\\.${lang}-thumb\\.webp`));
});

test('a cover with no variant for this language is left alone', () => {
  // The fallback that makes a partial render safe: an unrendered variant means the English
  // image is served, never a URL pointing at a file that does not exist.
  const html = '<img src="/media-webp/blog/cover-11.webp">';
  assert.equal(localizeCoverUrls(html, 'spanish'), html);
  assert.deepEqual(coverLanguages('cover-11'), []);
});

test('English renders are never rewritten', () => {
  const html = '<img src="/media-webp/blog/cover-10.webp">';
  assert.equal(localizeCoverUrls(html, 'english'), html);
  assert.equal(localizeCoverUrls(html, ''), html);
});

test('the rewrite touches only blog cover URLs', () => {
  const html = '<img src="/media-webp/logo/Logo64x64.webp"><img src="/media-webp/blog/exterior-after.webp">';
  assert.equal(localizeCoverUrls(html, 'spanish'), html);
});
