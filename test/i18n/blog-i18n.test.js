// Tier: unit — the localized blog's markup contract and the hub's card pruning.
//
// WHAT THIS COVERS
// Three things that are invisible until they are wrong in a language nobody here reads:
//
//   1. THE BAKED CLUSTERS. Each English article carries an hreflang cluster naming the
//      languages it exists in. That set is a function of which packs are on disk, so it
//      moves every time a translation lands — and `node scripts/build-i18n-seo.js` is the
//      only thing that updates it. A cluster naming a locale with no pack points Google
//      at a 404, which is the single failure in this layer that actively costs rankings.
//   2. THE KEYS. The renderer localizes an article by looking up ~11 named slots in its
//      markup. A missing attribute does not error — it silently serves that element in
//      English inside an otherwise-translated page.
//   3. THE HUB GRID. One file of fifteen cards is rendered for every locale, so the cards
//      whose articles this language lacks have to be removed. Leaving one in offers the
//      reader a link that 404s, because routes/i18n.js never registered it.
//
// These checks live here rather than in test/i18n/page-entity-jsonld.test.js and friends
// because those scan `fs.readdirSync(PUBLIC)` — the TOP LEVEL only — so nothing under
// public/blog/ is visible to them. That is also why the "no language switcher on the
// blog" decision needs its own assertion: the test that would otherwise catch a
// half-built switcher cannot see these files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_LOCALES, BLOG_HUB, LOCALES, LOCALIZED_ARTICLES, localizedUrl,
} from '../../lib/i18n/locales.js';
import { articleLocales, localesForHub, slugsForLocale } from '../../lib/i18n/blog-packs.js';
import { pruneHubForLocale } from '../../lib/i18n/blog-hub.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(REPO_ROOT, 'public');

/** @param {{file: string}} entry */
function read(entry) {
  return fs.readFileSync(path.join(PUBLIC, ...entry.file.split('/')), 'utf8');
}

/** The hreflang values a page's baked cluster names, in document order. */
function bakedCluster(html) {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)]
    .map((m) => ({ hreflang: m[1], href: m[2] }));
}

// --- the baked clusters ---------------------------------------------------------------

test('every blog page carries exactly the cluster its translations justify', () => {
  for (const entry of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const cluster = bakedCluster(read(entry));
    const locales = articleLocales(entry.slug);
    const expected = [
      ...locales.map((l) => ({ hreflang: l.hreflang, href: localizedUrl(l, entry.path) })),
      { hreflang: 'x-default', href: localizedUrl(ALL_LOCALES[0], entry.path) },
    ];
    assert.deepEqual(
      cluster,
      expected,
      `${entry.file}: baked hreflang cluster disagrees with the packs on disk — rerun `
        + '`node scripts/build-i18n-seo.js` and commit the result',
    );
  }
});

test('no blog page advertises a locale that has no translation pack', () => {
  // The same rule as above, stated as the consequence rather than the equality, so a
  // failure reads as the damage rather than as a diff.
  for (const entry of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const live = new Set(articleLocales(entry.slug).map((l) => l.hreflang));
    for (const { hreflang, href } of bakedCluster(read(entry))) {
      if (hreflang === 'x-default') continue;
      assert.ok(live.has(hreflang), `${entry.file}: advertises ${hreflang} (${href}), which does not exist`);
    }
  }
});

test('a cluster is always self-referential and always ends with x-default', () => {
  for (const entry of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const cluster = bakedCluster(read(entry));
    assert.ok(cluster.length >= 2, `${entry.file}: even an English-only page gets en + x-default`);
    assert.equal(cluster[0].hreflang, 'en', `${entry.file}: English leads the cluster`);
    assert.equal(cluster[0].href, localizedUrl(ALL_LOCALES[0], entry.path), `${entry.file}: wrong self URL`);
    assert.equal(cluster.at(-1).hreflang, 'x-default', `${entry.file}: x-default must close the cluster`);
  }
});

// --- the keys -------------------------------------------------------------------------

const ARTICLE_KEYS = [
  ['post.meta.title', /<title[^>]*\bdata-lang="post\.meta\.title"/],
  ['post.meta.description', /<meta[^>]*name="description"[^>]*\bdata-lang-attr="post\.meta\.description\|content"/],
  ['post.eyebrow', /class="article-eyebrow"[^>]*\bdata-lang="post\.eyebrow"/],
  ['post.title', /class="article-title"[^>]*\bdata-lang="post\.title"/],
  ['post.byline', /class="article-meta"[^>]*\bdata-lang-html="post\.byline"/],
  ['post.crumb', /<span data-lang="post\.crumb">/],
  ['post.figureAlt', /\bdata-lang-attr="post\.figureAlt\|alt"/],
  ['post.body', /class="article-body"[^>]*\bdata-lang-html="post\.body"/],
  ['post.cta.title', /\bdata-lang="post\.cta\.title"/],
  ['post.cta.body', /\bdata-lang="post\.cta\.body"/],
  ['post.cta.link', /\bdata-lang="post\.cta\.link"/],
];

test('every article names all eleven translatable slots', () => {
  for (const article of LOCALIZED_ARTICLES) {
    const html = read(article);
    for (const [key, re] of ARTICLE_KEYS) {
      assert.match(html, re, `${article.file}: no ${key} key — that element would stay English`);
    }
    if (/class="article-disclaimer"/.test(html)) {
      assert.match(html, /class="article-disclaimer"[^>]*\bdata-lang="post\.disclaimer"/,
        `${article.file}: the disclaimer is unkeyed, so it would serve in English under a translated page`);
    }
  }
});

test('every article marks exactly one page-entity block, and it is the BlogPosting', () => {
  // page-entity-jsonld.test.js enforces this for the marketing pages but only scans the
  // top level of public/, so the blog needs its own copy of the rule. Marking the
  // BreadcrumbList would have the renderer rewrite the trail's container instead of the
  // article; marking the Organization block would rename the company after the post.
  for (const article of LOCALIZED_ARTICLES) {
    const html = read(article);
    const blocks = [...html.matchAll(/(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)<\/script>/gi)];
    const marked = blocks.filter((b) => /\bdata-lang-jsonld\b/i.test(b[1]));
    assert.equal(marked.length, 1, `${article.file}: expected exactly one marked block, found ${marked.length}`);
    const data = JSON.parse(marked[0][2]);
    assert.equal(data['@type'], 'BlogPosting', `${article.file}: the marked block is a ${data['@type']}`);
    assert.ok('headline' in data, `${article.file}: a BlogPosting titles itself with headline`);
    assert.match(marked[0][1], /data-lang-jsonld="post\.title"/,
      `${article.file}: the marked block must name post.title, or the headline inherits the `
        + '<title> key and every translation gains a " | Stagify.ai" suffix the English does not have');
  }
});

test('the hub names its own slots and keys every card by slug', () => {
  const html = read(BLOG_HUB);
  assert.match(html, /<title[^>]*\bdata-lang="hub\.meta\.title"/);
  assert.match(html, /\bdata-lang-attr="hub\.meta\.description\|content"/);
  assert.match(html, /\bdata-lang="hub\.hero\.title"/);
  assert.match(html, /\bdata-lang="hub\.hero\.body"/);

  const cards = [...html.matchAll(/<a class="blog-card" href="\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(cards.length, LOCALIZED_ARTICLES.length, 'the hub should carry one card per article');
  for (const slug of cards) {
    for (const field of ['tag', 'title', 'excerpt', 'meta']) {
      assert.ok(html.includes(`data-lang="hub.cards.${slug}.${field}"`), `hub: card ${slug} has no ${field} key`);
    }
    assert.ok(html.includes(`data-lang-attr="hub.cards.${slug}.alt|alt"`), `hub: card ${slug} has no alt key`);
  }
});

test('the blog carries no language switcher, deliberately', () => {
  // The functional switcher needs language-switcher.js, language-loader.js and the
  // .lang-switch CSS, none of which a blog page loads — and its markup contract
  // (exactly eleven options, checked by locale-data.test.js) is FALSE on an article that
  // exists in six languages. The alternates are advertised in the head instead.
  for (const entry of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    assert.ok(
      !read(entry).includes('id="language-select"'),
      `${entry.file}: a switcher here would be unverified (locale-data.test.js scans only the `
        + 'top level of public/) and its eleven-option invariant is false for a per-article matrix',
    );
  }
});

// --- hub pruning ----------------------------------------------------------------------

const HUB_FIXTURE = `<!doctype html>
<html lang="en"><body>
  <div class="blog-grid">
    <a class="blog-card" href="/blog/alpha"><div class="blog-card__body"><h2>Alpha</h2></div></a>
    <a class="blog-card" href="/blog/beta"><div class="blog-card__body"><h2>Beta</h2></div></a>
    <a class="blog-card" href="/blog/gamma"><div class="blog-card__body"><h2>Gamma</h2></div></a>
  </div>
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Blog","blogPost":[
    {"@type":"BlogPosting","url":"https://stagify.ai/blog/alpha"},
    {"@type":"BlogPosting","url":"https://stagify.ai/blog/beta"},
    {"@type":"BlogPosting","mainEntityOfPage":{"@id":"https://stagify.ai/blog/gamma"}}
  ]}
  </script>
</body></html>`;

/** The Blog block's parsed data from a rendered hub. */
function blogBlock(html) {
  const body = [...html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((b) => b.includes('"Blog"'));
  return JSON.parse(body);
}

test('pruning removes the cards whose articles this locale lacks', () => {
  const out = pruneHubForLocale(HUB_FIXTURE, new Set(['alpha', 'gamma']), 'es');
  const cards = [...out.matchAll(/<a class="blog-card" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['/blog/alpha', '/blog/gamma'], 'beta has no pack and must not be offered');
  assert.ok(!out.includes('Beta'), 'the whole card comes out, not just its link');
});

test('pruning drops the same posts from the structured data', () => {
  const data = blogBlock(pruneHubForLocale(HUB_FIXTURE, new Set(['alpha']), 'es'));
  assert.equal(data.blogPost.length, 1, 'schema must describe the grid the reader sees');
  assert.equal(data.blogPost[0].url, 'https://stagify.ai/es/blog/alpha');
});

test('surviving posts are rewritten into the locale tree, in both URL shapes', () => {
  const data = blogBlock(pruneHubForLocale(HUB_FIXTURE, new Set(['alpha', 'gamma']), 'fr'));
  assert.deepEqual(
    data.blogPost.map((p) => p.url || p.mainEntityOfPage['@id']),
    ['https://stagify.ai/fr/blog/alpha', 'https://stagify.ai/fr/blog/gamma'],
    'a localized hub listing its posts at English URLs would contradict its own hreflang cluster',
  );
});

test('an English render is left completely alone', () => {
  const out = pruneHubForLocale(HUB_FIXTURE, new Set(['alpha', 'beta', 'gamma']), '');
  assert.equal(out, HUB_FIXTURE, 'nothing to prune and no prefix to add');
});

test('pruning is idempotent', () => {
  const once = pruneHubForLocale(HUB_FIXTURE, new Set(['alpha']), 'es');
  assert.equal(pruneHubForLocale(once, new Set(['alpha']), 'es'), once);
});

test('malformed card markup is left in place rather than swallowing the page', () => {
  const broken = HUB_FIXTURE.replace('<a class="blog-card" href="/blog/beta">', '<a class="blog-card" href="/blog/beta">')
    .replace('<div class="blog-card__body"><h2>Beta</h2></div></a>', '<div class="blog-card__body"><h2>Beta</h2></div>');
  const out = pruneHubForLocale(broken, new Set(['alpha']), 'es');
  assert.ok(out.includes('Gamma') || out.includes('Beta'), 'an unbalanced card must not take the rest of the document with it');
});

// --- the live matrix ------------------------------------------------------------------

test('the hub exists in exactly the locales that have at least one article', () => {
  const hub = new Set(localesForHub().map((l) => l.prefix));
  for (const locale of LOCALES) {
    const has = slugsForLocale(locale.prefix).size > 0;
    assert.equal(hub.has(locale.prefix), has, `/${locale.prefix}/blog/ should ${has ? 'exist' : 'not exist'}`);
  }
});

test('every article a locale has is reachable from that locale hub', () => {
  // The crawl-island check: a translated article nobody links to is one Google has to
  // find from the sitemap alone.
  const hubHtml = read(BLOG_HUB);
  for (const locale of LOCALES) {
    for (const slug of slugsForLocale(locale.prefix)) {
      assert.ok(
        hubHtml.includes(`href="/blog/${slug}"`),
        `${slug} is translated into ${locale.prefix} but has no card on the hub, so the `
          + `localized copy would be reachable only from the sitemap`,
      );
    }
  }
});
