// Tier: unit + integration — the home page's blog teaser, in every language.
//
// WHAT THIS COVERS
// The teaser shows six of the hub's cards. Its heading and its "Visit the Stagify blog"
// link carry site-pack keys and were translated from the start, so /es LOOKED finished
// while the six titles under the thumbnails stayed English — the most-read page on the
// site, half-translated, in a way that reads as correct at a glance. The localized cover
// images made it worse rather than better: a Spanish picture above an English headline.
//
// The fix reads the HUB pack from the home page rather than copying six titles into all
// eleven site packs, so what this file really guards is that reuse:
//
//   - every card names a key the hub pack actually has, in the hub namespace;
//   - `readTime` is derived, not stored, so it has to survive the derivation;
//   - the six slugs are hub slugs, or the keys resolve to nothing and English shows through
//     while every test that only counts attributes still passes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.js';
import { LOCALES } from '../../lib/i18n/locales.js';
import { withCardReadTimes } from '../../lib/i18n/blog-hub.js';
import { HUB_PACK_DIR } from '../../lib/i18n/blog-packs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
const hubPack = (lang) => JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'public', ...HUB_PACK_DIR.split('/'), `${lang}.json`), 'utf8',
));

const grid = () => /<div class="home-blog__grid[\s\S]*?<div class="home-blog__all/.exec(HOME)[0];
const cards = () => [...grid().matchAll(/<a class="home-blog__card" href="\/blog\/([a-z0-9-]+)">([\s\S]*?)<\/a>/g)]
  .map((m) => ({ slug: m[1], html: m[2] }));

// --- the derived key ---------------------------------------------------------------------

test('withCardReadTimes takes the half of meta after the separator', () => {
  const out = withCardReadTimes({ cards: { x: { meta: 'September 9, 2026 · 10 min read' } } });
  assert.equal(out.cards.x.readTime, '10 min read');
  assert.equal(out.cards.x.meta, 'September 9, 2026 · 10 min read', 'meta must survive intact');
});

test('withCardReadTimes never mutates the pack it is given', () => {
  // translations() hands back a CACHED object; mutating it would poison every later render
  // of that language.
  const pack = { cards: { x: { meta: 'a · b' } } };
  const out = withCardReadTimes(pack);
  assert.equal(pack.cards.x.readTime, undefined, 'the input pack was mutated');
  assert.notEqual(out.cards, pack.cards);
});

test('a card with no separator simply gets no readTime', () => {
  // Then the English markup shows through, like any unresolved key — not an empty span.
  const out = withCardReadTimes({ cards: { x: { meta: '10 min read' } } });
  assert.equal(out.cards.x.readTime, undefined);
  assert.deepEqual(withCardReadTimes({}), {});
});

// --- the markup and the packs agree -------------------------------------------------------

test('every teaser card is marked up against its own hub keys', () => {
  const found = cards();
  assert.equal(found.length, 6, 'the teaser shows six cards');
  for (const { slug, html } of found) {
    for (const [attr, key] of [
      ['data-lang-attr', `hub.cards.${slug}.alt|alt`],
      ['data-lang', `hub.cards.${slug}.tag`],
      ['data-lang', `hub.cards.${slug}.title`],
      ['data-lang', `hub.cards.${slug}.readTime`],
    ]) {
      assert.ok(html.includes(`${attr}="${key}"`), `public/index.html: ${slug} is missing ${attr}="${key}"`);
    }
  }
});

test('every key a teaser card names resolves in all ten hub packs', () => {
  // The failure this catches is silent: a slug typo, or a card for an article the hub does
  // not list, leaves the English text in place and looks like nothing happened.
  for (const locale of LOCALES) {
    const pack = withCardReadTimes(hubPack(locale.lang));
    for (const { slug } of cards()) {
      const card = pack.cards?.[slug];
      assert.ok(card, `${locale.lang}: the hub pack has no card '${slug}'`);
      for (const key of ['tag', 'title', 'alt', 'readTime']) {
        assert.ok(
          typeof card[key] === 'string' && card[key].trim(),
          `${locale.lang}/${slug}: '${key}' is missing or empty`,
        );
      }
    }
  }
});

// --- over HTTP ----------------------------------------------------------------------------

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

test('the teaser is translated on every localized home page', async () => {
  const english = cards().map(({ html }) => (/home-blog__title[^>]*>([\s\S]*?)<\/h3>/.exec(html) || [])[1].trim());

  for (const locale of LOCALES) {
    const html = await (await fetch(`${server.baseUrl}/${locale.prefix}`)).text();
    const titles = [...html.matchAll(/home-blog__title[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => m[1].trim());
    assert.equal(titles.length, 6, `/${locale.prefix}: expected six teaser cards`);
    for (const [i, title] of titles.entries()) {
      assert.notEqual(
        title, english[i],
        `/${locale.prefix}: teaser card ${i} still shows the English title`,
      );
    }
    const metas = [...html.matchAll(/home-blog__meta[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    for (const meta of metas) {
      assert.ok(!/min read$/.test(meta), `/${locale.prefix}: read time "${meta}" is still English`);
      assert.ok(!meta.includes('·'), `/${locale.prefix}: "${meta}" is the hub's full meta, not just the read time`);
    }
  }
});

test('the teaser links into the reader’s own language', async () => {
  const html = await (await fetch(`${server.baseUrl}/${LOCALES[0].prefix}`)).text();
  const hrefs = [...html.matchAll(/<a class="home-blog__card" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 6);
  for (const href of hrefs) {
    assert.ok(href.startsWith(`/${LOCALES[0].prefix}/blog/`), `${href} drops the reader back into English`);
    assert.equal((await fetch(`${server.baseUrl}${href}`)).status, 200, `${href} does not resolve`);
  }
});

test('the English home page is untouched', async () => {
  const html = await (await fetch(`${server.baseUrl}/`)).text();
  assert.match(html, /home-blog__title[^>]*>Most Listings Are Occupied/);
  assert.match(html, /home-blog__meta[^>]*>9 min read</);
  assert.match(html, /<a class="home-blog__card" href="\/blog\/home-staging-cost">/);
});
