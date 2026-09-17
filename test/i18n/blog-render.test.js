// Tier: unit — the renderer capability that makes a blog article localizable.
//
// WHAT THIS COVERS
// renderLocalizedPage() grew four optional arguments so that a page whose translations
// are SPARSE can be rendered correctly. Every one of them exists to stop the renderer
// asserting something about a translation that was never written:
//
//   locales         → the hreflang cluster and og:locale alternates name only the
//                     variants that exist. Naming one that does not is the single
//                     failure in this whole layer that actively costs rankings.
//   localizedPaths  → a link or a breadcrumb is prefixed only when the target has a copy
//                     in THIS locale, so /es/blog/a does not link to a Spanish /es/blog/b
//                     that nobody translated.
//   crumbKeys       → an article's own crumb is its title, which lives in its own pack,
//                     not in the eleven shared packs every LOCALIZED_PAGES crumb must.
//   (locale on applyStructuredData) → a BlogPosting's title property is `headline`, not
//                     `name`, and it gets an `inLanguage` that is not a translation of
//                     anything.
//
// Plus page-renderer's two-pack merge, which is what keeps ~170 K chars of article prose
// out of public/languages/*.json — a file the browser fetches whole on every page load.
//
// Every existing caller omits all four arguments; the first test pins that omitting them
// reproduces the old behaviour exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderLocalizedPage } from '../../lib/i18n/render-page.js';
import { createPageRenderer } from '../../lib/i18n/page-renderer.js';
import { ENGLISH, LOCALES, localeByPrefix } from '../../lib/i18n/locales.js';

const ES = /** @type {any} */ (localeByPrefix('es'));
const FR = /** @type {any} */ (localeByPrefix('fr'));
const JA = /** @type {any} */ (localeByPrefix('ja'));

/** An article-shaped page with the markup the Stage 3 retrofit adds. */
function articleHtml({ body = '<p>English body.</p>', extra = '' } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title data-lang="post.meta.title">English Title | Stagify.ai</title>
    <meta name="description" data-lang-attr="post.meta.description|content" content="English description.">
    <link rel="canonical" href="https://stagify.ai/blog/a">
    <meta property="og:url" content="https://stagify.ai/blog/a">
    <meta property="og:title" content="English Title">
    <meta property="og:description" content="English description.">
    <script type="application/ld+json" data-lang-jsonld>
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "headline": "English Title",
      "description": "English description.",
      "datePublished": "2026-07-17"
    }
    </script>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://stagify.ai/" },
        { "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://stagify.ai/blog/" },
        { "@type": "ListItem", "position": 3, "name": "A", "item": "https://stagify.ai/blog/a" }
      ]
    }
    </script>
${extra}  </head>
  <body>
    <a class="blog-cta-btn" href="/">Try Stagify Free</a>
    <div class="article-body" data-lang-html="post.body">${body}</div>
    <a href="/blog/b">Another post</a>
    <a href="/guides.html">Guides</a>
  </body>
</html>
`;
}

const PACK = {
  post: {
    meta: { title: 'Título en español | Stagify.ai', description: 'Descripción en español.' },
    body: '<p>Cuerpo en español.</p>',
    crumb: 'Un artículo',
  },
  navigation: { home: 'Inicio', blog: 'Blog ES' },
};

test('omitting the new arguments reproduces the previous behaviour', () => {
  // The marketing pages call renderLocalizedPage with four keys and must keep getting a
  // full eleven-locale cluster and the marketing path set.
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
  });
  const hreflangs = [...out.matchAll(/hreflang="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hreflangs.length, LOCALES.length + 2, 'English + 10 locales + x-default');
  assert.ok(hreflangs.includes('ja'));
});

test('the cluster names only the locales that exist', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES, FR],
  });
  const hreflangs = [...out.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hreflangs, ['en', 'es', 'fr', 'x-default']);
  assert.ok(!out.includes('hreflang="ja"'), 'an untranslated locale must never appear');
  assert.match(out, /<link rel="canonical" href="https:\/\/stagify\.ai\/es\/blog\/a">/);
  assert.match(out, /hreflang="x-default" href="https:\/\/stagify\.ai\/blog\/a"/);
});

test('og:locale alternates follow the same subset', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES, FR],
  });
  assert.match(out, /<meta property="og:locale" content="es_ES">/);
  const alternates = [...out.matchAll(/og:locale:alternate" content="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(alternates, ['en_US', 'fr_FR'], 'itself excluded, absent locales excluded');
});

test('a single-locale article still gets a valid self-referential cluster', () => {
  // The state of every article before its first pack lands. English + x-default is a
  // complete, correct cluster — not an empty one, and not a lie.
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: {},
    locale: ENGLISH,
    path: '/blog/a',
    locales: [ENGLISH],
  });
  const hreflangs = [...out.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hreflangs, ['en', 'x-default']);
});

test('the BlogPosting headline is localized, and no phantom `name` appears', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES],
  });
  const marked = JSON.parse(/data-lang-jsonld>(\{[\s\S]*?\})<\/script>/.exec(out)[1]);
  assert.equal(marked.headline, 'Título en español | Stagify.ai');
  assert.equal('name' in marked, false, 'a BlogPosting titles itself with headline, not name');
  assert.equal(marked.description, 'Descripción en español.');
  assert.equal(marked.inLanguage, 'es');
  assert.equal(marked.datePublished, '2026-07-17', 'dates are not translations');
});

test('inLanguage is not stamped on the English render', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: {},
    locale: ENGLISH,
    path: '/blog/a',
    locales: [ENGLISH],
  });
  const marked = JSON.parse(/data-lang-jsonld>(\{[\s\S]*?\})<\/script>/.exec(out)[1]);
  assert.equal('inLanguage' in marked, false);
});

test('a WebPage-ish block still gets `name`, so the marketing pages are unchanged', () => {
  const html = articleHtml().replace(
    '"@type": "BlogPosting",\n      "headline": "English Title",',
    '"@type": "WebPage",\n      "name": "English Title",',
  );
  const out = renderLocalizedPage({
    html,
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES],
  });
  const marked = JSON.parse(/data-lang-jsonld>(\{[\s\S]*?\})<\/script>/.exec(out)[1]);
  assert.equal(marked.name, 'Título en español | Stagify.ai');
  assert.equal('headline' in marked, false);
  assert.equal('inLanguage' in marked, false, 'only a BlogPosting gets inLanguage');
});

test('the article body is injected raw, replacing the English one', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES],
  });
  assert.match(out, /<div class="article-body" data-lang-html="post.body"><p>Cuerpo en español\.<\/p><\/div>/);
  assert.ok(!out.includes('English body.'));
});

test('a nested callout inside the body survives the swap', () => {
  const body = '<p>One.</p><div class="article-callout"><strong>Note</strong></div><p>Two.</p>';
  const pack = { post: { ...PACK.post, body: '<p>Uno.</p><div class="article-callout"><strong>Nota</strong></div><p>Dos.</p>' } };
  const out = renderLocalizedPage({
    html: articleHtml({ body }),
    translations: pack,
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH, ES],
  });
  assert.match(out, /<p>Dos\.<\/p><\/div>/, 'the close-tag scan must run past the nested div');
  assert.match(out, /<a href="\/es\/guides\.html">/, 'the rest of the document is still processed');
});

test('a missing pack leaves the English article completely intact', () => {
  // The opt-out path: a locale with no pack for this article. Every post.* key resolves
  // null, so the fallback is the authored English rather than a half-translated page.
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: { navigation: { home: 'Inicio' } },
    locale: ES,
    path: '/blog/a',
    locales: [ENGLISH],
  });
  assert.match(out, /<p>English body\.<\/p>/);
  assert.match(out, /English Title \| Stagify\.ai/);
  assert.match(out, /content="English description\."/);
});

test('links are prefixed only for paths that exist in this locale', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    localizedPaths: new Set(['/', '/guides.html', '/blog/', '/blog/a']),
    locales: [ENGLISH, ES],
  });
  assert.match(out, /<a href="\/es\/guides\.html">/, 'a marketing page is in the set');
  assert.match(out, /<a href="\/blog\/b">/, 'an untranslated sibling article stays English');
  assert.match(out, /<a class="blog-cta-btn" href="\/es">/, 'the home link follows the locale');
});

test('the breadcrumb trail follows the same availability rule', () => {
  const crumbKeys = new Map([
    ['/blog/', 'navigation.blog'],
    ['/blog/a', 'post.crumb'],
  ]);
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: ES,
    path: '/blog/a',
    localizedPaths: new Set(['/', '/blog/', '/blog/a']),
    crumbKeys,
    locales: [ENGLISH, ES],
  });
  const trail = JSON.parse(
    [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((b) => b.includes('BreadcrumbList')),
  );
  assert.deepEqual(
    trail.itemListElement.map((e) => [e.name, e.item]),
    [
      ['Inicio', 'https://stagify.ai/es'],
      ['Blog ES', 'https://stagify.ai/es/blog/'],
      ['Un artículo', 'https://stagify.ai/es/blog/a'],
    ],
    "an article's own crumb comes from its pack, the others from the shared keys",
  );
});

test('a crumb for a path with no localized copy keeps its English name and URL', () => {
  const out = renderLocalizedPage({
    html: articleHtml(),
    translations: PACK,
    locale: JA,
    path: '/blog/a',
    localizedPaths: new Set(['/']), // the hub and the article are not translated into ja
    crumbKeys: new Map([['/blog/', 'navigation.blog']]),
    locales: [ENGLISH, JA],
  });
  const trail = JSON.parse(
    [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((b) => b.includes('BreadcrumbList')),
  );
  const [, blog, self] = trail.itemListElement;
  assert.equal(blog.item, 'https://stagify.ai/blog/', 'a trail must not invent a page');
  assert.equal(self.item, 'https://stagify.ai/blog/a');
});

// --- page-renderer: the two-pack merge ------------------------------------------------

/** A throwaway public/ with a site pack and optionally one article pack. */
function rendererFixture({ articlePack } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-render-'));
  fs.mkdirSync(path.join(dir, 'languages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'blog', 'i18n', 'a'), { recursive: true });
  for (const lang of ['english', 'spanish']) {
    fs.writeFileSync(
      path.join(dir, 'languages', `${lang}.json`),
      JSON.stringify({ navigation: { home: lang === 'spanish' ? 'Inicio' : 'Home', blog: 'Blog' } }),
    );
  }
  if (articlePack) {
    fs.writeFileSync(path.join(dir, 'blog', 'i18n', 'a', 'spanish.json'), JSON.stringify(articlePack));
  }
  fs.writeFileSync(path.join(dir, 'article.html'), articleHtml());
  return dir;
}

test('the article pack is mounted under `post`, beside the shared chrome', () => {
  const dir = rendererFixture({ articlePack: PACK.post });
  const renderer = createPageRenderer({ publicDir: dir, DEBUG_MODE: true });
  const out = renderer.render(ES, {
    path: '/blog/a',
    file: 'article.html',
    packDir: 'blog/i18n/a',
    locales: [ENGLISH, ES],
    localizedPaths: new Set(['/', '/blog/a']),
  });
  assert.match(out, /<p>Cuerpo en español\.<\/p>/, 'article prose from its own pack');
  assert.match(out, /<a class="blog-cta-btn" href="\/es">/, 'shared chrome still resolves');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pack file that does not exist renders the English fallback rather than throwing', () => {
  const dir = rendererFixture(); // no article pack written
  const renderer = createPageRenderer({ publicDir: dir, DEBUG_MODE: true });
  const out = renderer.render(ES, {
    path: '/blog/a',
    file: 'article.html',
    packDir: 'blog/i18n/a',
    locales: [ENGLISH],
  });
  assert.match(out, /<p>English body\.<\/p>/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing SITE pack is still a hard failure', () => {
  // Opting out of an article is routine; shipping without a language file is not.
  const dir = rendererFixture({ articlePack: PACK.post });
  fs.rmSync(path.join(dir, 'languages', 'spanish.json'));
  const renderer = createPageRenderer({ publicDir: dir, DEBUG_MODE: true });
  assert.throws(() => renderer.render(ES, { path: '/blog/a', file: 'article.html', packDir: 'blog/i18n/a' }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('postProcess runs on the finished string, inside the memo', () => {
  const dir = rendererFixture({ articlePack: PACK.post });
  const renderer = createPageRenderer({ publicDir: dir, DEBUG_MODE: false });
  let calls = 0;
  const page = {
    path: '/blog/a',
    file: 'article.html',
    packDir: 'blog/i18n/a',
    locales: [ENGLISH, ES],
    postProcess: (/** @type {string} */ html) => {
      calls += 1;
      return html.replace('</body>', '<!--pruned--></body>');
    },
  };
  const first = renderer.render(ES, page);
  const second = renderer.render(ES, page);
  assert.equal(first, second);
  assert.equal(calls, 1, 'the hook is memoized like the rest of the render');
  assert.ok(first.includes('<!--pruned-->'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('English renders skip the merge entirely', () => {
  // English is the source: the static file already says what it says, and merging a pack
  // over it could only introduce a difference between the static and rendered copies.
  const dir = rendererFixture({ articlePack: PACK.post });
  const renderer = createPageRenderer({ publicDir: dir, DEBUG_MODE: true });
  const out = renderer.render(ENGLISH, {
    path: '/blog/a',
    file: 'article.html',
    packDir: 'blog/i18n/a',
    locales: [ENGLISH],
  });
  assert.match(out, /<p>English body\.<\/p>/);
  fs.rmSync(dir, { recursive: true, force: true });
});
