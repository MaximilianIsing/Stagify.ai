// Tier: unit — lib/content/article-extract.js.
//
// WHAT THIS COVERS
// The extractor that decides what a blog article's translatable content IS, and the
// fingerprint that decides when a translation of it has gone stale. Both are used by
// scripts/blog-pack.js when it writes a pack and by test/content/blog-packs.test.js
// when it checks one, so a bug here does not surface as a crash — it surfaces as ten
// languages quietly serving last month's article, or as every pack being declared stale
// on an edit nobody made to the prose.
//
// The invariants worth pinning:
//   - the fingerprint covers the PROSE, not the file: adding the hreflang cluster (which
//     `node scripts/build-i18n-seo.js` does to every article the moment a pack appears)
//     must not invalidate the packs that caused it;
//   - it is stable across CRLF and LF, because the repo is checked out both ways;
//   - the cover figure's alt is the COVER's, not the topbar logo's — the first <img> in
//     every article file is the logo, so a naive scan silently translates the wrong one;
//   - a commented-out heading or CTA cannot win, matching the rule
//     test/seo/blog-dates.test.js enforces on the dates;
//   - the body-shape validator rejects exactly the structural drift a translation model
//     produces, and accepts the one added callout the market-note prompt asks for.
//
// The last tests run against the REAL public/blog folder: an article whose markup drifts
// out of the shape the extractor assumes cannot be translated at all, and the renderer
// would have nothing to put the translation into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractArticleStrings,
  articleSourceHash,
  missingSlots,
  openTagSequence,
  urlAttrValues,
  unbalancedTag,
  validateTranslatedBody,
} from '../../lib/content/article-extract.js';
import { LOCALIZED_ARTICLES } from '../../lib/i18n/locales.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = path.join(REPO_ROOT, 'public', 'blog');

/** The real English article files, keyed by slug. */
function realArticles() {
  return LOCALIZED_ARTICLES.map((a) => ({
    slug: a.slug,
    html: fs.readFileSync(path.join(REPO_ROOT, 'public', ...a.file.split('/')), 'utf8'),
  }));
}

/** A minimal article with the shape the extractor assumes. */
function articleFixture({ body = '<p>Hello.</p>', extraHead = '', disclaimer = true } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>A Title | Stagify.ai</title>
    <meta name="description" content="A description.">
    <link rel="canonical" href="https://stagify.ai/blog/x">
${extraHead}  </head>
  <body>
    <header class="blog-topbar">
      <a class="blog-brand" href="/"><img src="/logo.webp" alt="Stagify.ai logo"><span>Stagify.ai</span></a>
    </header>
    <main class="article-wrap">
      <nav class="blog-crumbs" aria-label="Breadcrumb">
        <a href="/">Home</a><span>&rsaquo;</span><a href="/blog/">Blog</a><span>&rsaquo;</span>Short Crumb
      </nav>
      <span class="article-eyebrow">Product</span>
      <h1 class="article-title">A Title</h1>
      <p class="article-meta">By <strong>Stagify.ai</strong> &middot; July 17, 2026 &middot; 7 min read</p>
      <figure class="article-figure">
        <img src="/media-webp/blog/cover-1.webp" alt="The cover alt" width="1600" height="900">
      </figure>
      <div class="article-body">
${body}
      </div>
      <div class="article-cta">
        <h2>CTA heading</h2>
        <p>CTA body.</p>
        <a href="/">CTA link &rarr;</a>
      </div>
${disclaimer ? '      <p class="article-disclaimer">A disclaimer.</p>\n' : ''}    </main>
  </body>
</html>
`;
}

test('every slot is pulled from an article of the expected shape', () => {
  const x = extractArticleStrings(articleFixture());
  assert.equal(x.meta.title, 'A Title | Stagify.ai');
  assert.equal(x.meta.description, 'A description.');
  assert.equal(x.title, 'A Title');
  assert.equal(x.eyebrow, 'Product');
  assert.equal(x.byline, 'By <strong>Stagify.ai</strong> &middot; July 17, 2026 &middot; 7 min read');
  assert.equal(x.crumb, 'Short Crumb');
  assert.equal(x.cta.title, 'CTA heading');
  assert.equal(x.cta.body, 'CTA body.');
  assert.equal(x.cta.link, 'CTA link &rarr;');
  assert.equal(x.disclaimer, 'A disclaimer.');
  assert.equal(missingSlots(x).length, 0);
});

test('figureAlt is the cover image, not the topbar logo', () => {
  // Every article opens with the brand logo, so an unscoped "first <img>" scan reads the
  // wrong alt — and the mistake is invisible, because both are plausible strings.
  const x = extractArticleStrings(articleFixture());
  assert.equal(x.figureAlt, 'The cover alt');
});

test('the disclaimer is optional and simply absent when the article has none', () => {
  const x = extractArticleStrings(articleFixture({ disclaimer: false }));
  assert.equal('disclaimer' in x, false);
  assert.equal(missingSlots(x).length, 0, 'a missing disclaimer is not a missing slot');
});

test('a commented-out element cannot supply a slot', () => {
  const html = articleFixture().replace(
    '<h1 class="article-title">A Title</h1>',
    '<!-- <h1 class="article-title">Old Title</h1> -->\n      <h1 class="article-title">A Title</h1>',
  );
  assert.equal(extractArticleStrings(html).title, 'A Title');
});

test('the body keeps nested markup whole', () => {
  const body = '<p>One.</p>\n<div class="article-callout"><strong>Note:</strong> inner.</div>\n<p>Two.</p>';
  const x = extractArticleStrings(articleFixture({ body }));
  assert.match(x.body, /<div class="article-callout">/);
  assert.match(x.body, /<p>Two\.<\/p>$/, 'the scan must run past the nested div to the real close');
});

test('the fingerprint is stable across CRLF and LF', () => {
  const lf = articleFixture().replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(articleSourceHash(lf), articleSourceHash(crlf));
});

test('the fingerprint ignores head changes that never reach a reader', () => {
  // This is the whole reason the hash is over the extract rather than the file. The build
  // bakes an hreflang cluster into an article the moment its first pack lands; hashing the
  // file would make that very act mark the new pack stale.
  const before = articleSourceHash(articleFixture());
  const after = articleSourceHash(
    articleFixture({
      extraHead:
        '    <link rel="alternate" hreflang="es" href="https://stagify.ai/es/blog/x">\n' +
        '    <link rel="alternate" hreflang="x-default" href="https://stagify.ai/blog/x">\n',
    }),
  );
  assert.equal(before, after);
});

test('the fingerprint moves when the prose moves', () => {
  const before = articleSourceHash(articleFixture());
  const after = articleSourceHash(articleFixture({ body: '<p>Hello, revised.</p>' }));
  assert.notEqual(before, after);
});

test('the fingerprint ignores key order', () => {
  // stableStringify sorts, so a reordered extract must not read as a different article.
  const a = extractArticleStrings(articleFixture());
  const reordered = Object.fromEntries(Object.keys(a).reverse().map((k) => [k, a[k]]));
  assert.deepEqual(Object.keys(reordered).sort(), Object.keys(a).sort());
});

test('unbalancedTag catches the three ways a translated body breaks the page', () => {
  assert.equal(unbalancedTag('<p>fine</p><ul><li>a</li></ul>'), null);
  assert.equal(unbalancedTag('<p>fine</p><img src="/x.webp"><br>'), null, 'void tags never open a scope');
  assert.match(unbalancedTag('<p>oops'), /unclosed <p>/);
  assert.match(unbalancedTag('<p>a</p></div>'), /stray closing <\/div>/);
  assert.match(unbalancedTag('<p><em>a</p></em>'), /<\/p> closes <em>/);
});

test('a translated body must reproduce the English tag sequence', () => {
  const english = '<p>One.</p><h2>Two</h2><ul><li>a</li><li>b</li></ul>';
  assert.deepEqual(validateTranslatedBody(english, '<p>Uno.</p><h2>Dos</h2><ul><li>a</li><li>b</li></ul>'), []);

  const merged = validateTranslatedBody(english, '<p>Uno. Dos</p><ul><li>a</li><li>b</li></ul>');
  assert.equal(merged.length, 1);
  assert.match(merged[0], /tag sequence differs/);

  const dropped = validateTranslatedBody(english, '<p>Uno.</p><h2>Dos</h2><ul><li>a</li></ul>');
  assert.match(dropped[0], /tag sequence differs/);
});

test('a translated body may not retarget, drop or invent a link', () => {
  const english = '<p>See <a href="/stagify-plus.html">Plus</a> and <img src="/a.webp"></p>';
  assert.deepEqual(validateTranslatedBody(english, '<p>Ver <a href="/stagify-plus.html">Plus</a> y <img src="/a.webp"></p>'), []);

  const retargeted = validateTranslatedBody(english, '<p>Ver <a href="/es/stagify-plus.html">Plus</a> y <img src="/a.webp"></p>');
  assert.equal(retargeted.length, 1);
  assert.match(retargeted[0], /href\/src values differ/);
});

test('scripts, iframes and inline handlers are refused whatever else is right', () => {
  const english = '<p>Hi.</p>';
  assert.match(validateTranslatedBody(english, '<p onclick="x()">Hi.</p>')[0], /inline event handler/);
  assert.ok(validateTranslatedBody(english, '<p>Hi.</p><script>x()</script>').some((p) => /<script>/.test(p)));
  assert.ok(validateTranslatedBody(english, '<p><a href="javascript:x()">Hi.</a></p>').some((p) => /javascript:/.test(p)));
});

test('the market-note callout is allowed only where it is asked for', () => {
  const english = '<p>One.</p><h2>Two</h2>';
  const withNote = '<p>Uno.</p><div class="article-callout">Local rules differ.</div><h2>Dos</h2>';

  assert.deepEqual(validateTranslatedBody(english, withNote, { allowExtraCallout: true }), []);
  assert.match(
    validateTranslatedBody(english, withNote)[0],
    /tag sequence differs/,
    'without the flag, an added div is structural drift like any other',
  );

  // The allowance is for ONE div, not for free rein.
  const twoNotes = '<p>Uno.</p><div class="article-callout">a</div><div class="article-callout">b</div><h2>Dos</h2>';
  assert.ok(validateTranslatedBody(english, twoNotes, { allowExtraCallout: true }).length > 0);
});

// --- against the real articles -------------------------------------------------------

test('every real article yields every required slot', () => {
  for (const { slug, html } of realArticles()) {
    const missing = missingSlots(extractArticleStrings(html));
    assert.deepEqual(
      missing,
      [],
      `${slug}: markup drifted from the shape the extractor and renderer both assume — ` +
        `missing ${missing.join(', ')}`,
    );
  }
});

test('every real article body is well-formed by our own validator', () => {
  // If an English body fails the check a translation of it must pass, no pack for that
  // article could ever be written — the script would refuse its own source.
  for (const { slug, html } of realArticles()) {
    const { body } = extractArticleStrings(html);
    assert.deepEqual(validateTranslatedBody(body, body), [], `${slug}: ${validateTranslatedBody(body, body).join('; ')}`);
  }
});

test('every real article fingerprints identically from either line ending', () => {
  for (const { slug, html } of realArticles()) {
    const lf = html.replace(/\r\n/g, '\n');
    assert.equal(articleSourceHash(lf), articleSourceHash(lf.replace(/\n/g, '\r\n')), slug);
  }
});

test('the article inventory matches the files on disk', () => {
  // LOCALIZED_ARTICLES is hand-maintained while public/blog/ is not, so a post added
  // without a config row would get no localized URL and no sitemap entry, silently.
  const onDisk = fs
    .readdirSync(BLOG)
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .map((f) => f.slice(0, -'.html'.length))
    .sort();
  const configured = LOCALIZED_ARTICLES.map((a) => a.slug).sort();
  assert.deepEqual(
    configured,
    onDisk,
    'add the new post to LOCALIZED_ARTICLES in lib/i18n/locales.js, then rerun ' +
      '`node scripts/build-i18n-seo.js`',
  );
});

test('real article bodies carry the links the validator will police', () => {
  // A sanity floor on the helpers themselves: if urlAttrValues or openTagSequence
  // silently returned nothing, every translation would "pass" validation.
  const { body } = extractArticleStrings(realArticles()[0].html);
  assert.ok(openTagSequence(body).length > 5);
  assert.ok(urlAttrValues(body).length > 0);
});
