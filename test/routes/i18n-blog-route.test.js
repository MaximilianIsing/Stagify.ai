// Tier: integration — the localized blog URLs, over real HTTP.
//
// WHAT THIS COVERS
// Everything else about the blog's localization is checked as a pure function: the
// manifest, the clusters baked into files, the renderer's output for a given descriptor.
// This file is the one that asks the running server, because the property that matters
// most is a routing property and cannot be established any other way:
//
//   a localized blog URL exists if and only if the translation behind it exists.
//
// Get that wrong in one direction and the sitemap advertises pages that 404; get it wrong
// in the other and a reader lands on an English article under a Spanish URL wearing a
// Spanish hreflang. Both are invisible to a unit test of the renderer, which is only ever
// handed descriptors someone already decided were real.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { LOCALES, LOCALIZED_ARTICLES, localizedUrl, ENGLISH } from '../../lib/i18n/locales.js';
import { articleLocales, articlesForLocale, localesForHub, slugsForLocale } from '../../lib/i18n/blog-packs.js';

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());
const get = (p, opts) => fetch(`${server.baseUrl}${p}`, opts);

test('every article a locale has been translated into is served there', async () => {
  for (const locale of LOCALES) {
    for (const article of articlesForLocale(locale.prefix)) {
      const url = `/${locale.prefix}${article.path}`;
      const res = await get(url);
      assert.equal(res.status, 200, `${url} should be served (its pack exists)`);
      const html = await res.text();
      assert.match(html, new RegExp(`<html[^>]*lang="${locale.bcp47}"`), `${url}: wrong <html lang>`);
      assert.ok(
        html.includes(`<link rel="canonical" href="${localizedUrl(locale, article.path)}">`),
        `${url}: canonical must be self-referential, or this page tells Google it is a copy`,
      );
    }
  }
});

test('an article a locale has NOT been translated into 404s there', async () => {
  // The inverse, and the more important half: a URL must not exist just because the
  // pattern would allow it. routes/i18n.js registers pairs from the manifest precisely so
  // this falls through to the 404 handler rather than serving a half-English page.
  let checked = 0;
  for (const locale of LOCALES) {
    const available = slugsForLocale(locale.prefix);
    for (const article of LOCALIZED_ARTICLES) {
      if (available.has(article.slug)) continue;
      const res = await get(`/${locale.prefix}${article.path}`);
      assert.equal(res.status, 404, `/${locale.prefix}${article.path} has no pack and must not be served`);
      checked += 1;
    }
  }
  // When the matrix is full there is nothing to check, which is a pass, not a hole —
  // but say so rather than looking like a test that ran and proved nothing.
  if (checked === 0) assert.ok(true, 'every article is translated into every locale');
});

test('a slug that does not exist at all 404s in every locale', async () => {
  for (const locale of LOCALES) {
    const res = await get(`/${locale.prefix}/blog/not-a-real-article`);
    assert.equal(res.status, 404, `/${locale.prefix}/blog/not-a-real-article should 404`);
  }
});

test('the hub is served in every locale that has an article, and lists only those', async () => {
  for (const locale of localesForHub()) {
    if (!locale.prefix) continue;
    const res = await get(`/${locale.prefix}/blog/`);
    assert.equal(res.status, 200, `/${locale.prefix}/blog/ should be served`);
    const html = await res.text();

    const linked = [...html.matchAll(/<a class="blog-card" href="([^"]+)"/g)].map((m) => m[1]);
    const expected = articlesForLocale(locale.prefix).map((a) => `/${locale.prefix}${a.path}`);
    assert.deepEqual(
      linked.slice().sort(),
      expected.slice().sort(),
      `/${locale.prefix}/blog/ must offer exactly the articles this language has — every other `
        + 'card would be a link to a page that 404s',
    );
  }
});

test('/<prefix>/blog/index.html 301s to the canonical trailing-slash form', async () => {
  for (const locale of localesForHub()) {
    if (!locale.prefix) continue;
    const res = await get(`/${locale.prefix}/blog/index.html`, { redirect: 'manual' });
    assert.equal(res.status, 301, `/${locale.prefix}/blog/index.html should 301`);
    assert.equal(res.headers.get('location'), `/${locale.prefix}/blog/`);
  }
});

test('a served article advertises only clusters that resolve', async () => {
  // The one failure in this layer that actively costs rankings. Every alternate a page
  // names is fetched here and must come back 200 — a cluster is a promise about URLs, and
  // this is the only test that makes the server keep it.
  const [article] = LOCALIZED_ARTICLES.filter((a) => articleLocales(a.slug).length > 1);
  if (!article) return; // nothing translated yet
  const res = await get(article.path);
  assert.equal(res.status, 200);
  const html = await res.text();

  const hrefs = [...html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2, 'an article with a translation carries a real cluster');
  for (const href of hrefs) {
    const path = href.replace('https://stagify.ai', '');
    const probe = await get(path);
    assert.equal(probe.status, 200, `${article.path} advertises ${href}, which does not resolve`);
  }
});

test('the English article is untouched by all of this', async () => {
  const article = LOCALIZED_ARTICLES[0];
  const res = await get(article.path);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html[^>]*lang="en"/);
  assert.ok(html.includes(`<link rel="canonical" href="${localizedUrl(ENGLISH, article.path)}">`));
  // The data-lang attributes are inert when the file is served statically: the English
  // page must still read as English, not as a template.
  assert.ok(!html.includes('data-lang="post.body"'), 'the body key is data-lang-html, not data-lang');
  assert.match(html, /class="article-body" data-lang-html="post\.body"/);
});
