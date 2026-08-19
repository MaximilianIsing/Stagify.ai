// Tier: drift guard — WHICH JSON-LD block the two renderers localize, and what a
// localized page's breadcrumb trail points at.
//
// Both renderers used to take the FIRST ld+json block in document order:
// applyStructuredData() in lib/i18n/render-page.js regex-matched it non-globally, and
// language-loader.js's updateStructuredData() used a bare querySelector. On the three
// pages that lead with their breadcrumb trail — guides, enterprise, stagify-plus — the
// first block IS the BreadcrumbList, so:
//
//   • the page title and description were stamped onto the trail, which has neither a
//     name nor a description of its own (schema.org permits the properties, so nothing
//     errored and no validator complained);
//   • the block that actually describes the page never got localized. stagify-plus.html
//     ships a SoftwareApplication with the plan name, the price and the offer — English
//     in all eleven locales, on the page whose entire job is selling the plan.
//
// Position cannot fix this. Skipping the BreadcrumbList would hand guides.html's page
// title to the first of its six HowTo blocks and clobber "Your first free staging" —
// those describe individual guides, not the page. So the block declares itself with
// `data-lang-jsonld`, and this file pins that every page either marks exactly one or is
// a listed exemption. Without that sweep an unmarked new page fails the quiet way: its
// JSON-LD simply stays English, on every locale, with nothing to notice.
//
// The second half covers breadcrumb item URLs. They are authored as absolute English
// URLs, so /es/stagify-plus.html used to publish a trail rooted in the English tree
// while its own canonical said /es/ — the trail and the canonical disagreeing about
// which tree the page lives in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLocalizedPage } from '../../lib/i18n/render-page.js';
import { localeByPrefix, LOCALIZED_PAGES, SITE_ORIGIN } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

/**
 * Pages that carry JSON-LD but legitimately have no block describing the page itself.
 * Each entry is a reason, not an excuse — the list is asserted to be exact, so a page
 * that grows a page-entity block must be removed from it rather than sitting here.
 */
const NO_PAGE_ENTITY = new Map([
  ['developers.html', 'carries only a BreadcrumbList — a trail is navigation, not a subject, and the page is English-only so nothing here is localized'],
  ['enterprise.html', 'carries only a BreadcrumbList — a trail is navigation, not a subject'],
  ['guides.html', 'a BreadcrumbList plus six HowTo blocks, one per guide; none of them is the page'],
  ['privacy.html', 'carries only a BreadcrumbList — a trail is navigation, not a subject'],
  ['terms.html', 'carries only a BreadcrumbList — a trail is navigation, not a subject'],
]);

/** Every ld+json block on the page, as { open tag, parsed data }. */
function jsonLd(html) {
  return [...html.matchAll(/(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)<\/script>/gi)]
    .map((m) => ({ open: m[1], data: JSON.parse(m[2]) }));
}

const marked = (blocks) => blocks.filter((b) => /\bdata-lang-jsonld\b/.test(b.open));

test('sanity: the sweep finds the pages that carry JSON-LD', () => {
  // A broken walk makes every assertion below pass vacuously.
  assert.ok(pages.length >= 15, `expected the public pages, found ${pages.length}`);
  const withLd = pages.filter((f) => jsonLd(read(f)).length > 0);
  assert.ok(withLd.length >= 8, `expected the JSON-LD pages, found ${withLd}`);
  for (const name of ['index.html', 'stagify-plus.html', 'guides.html']) {
    assert.ok(withLd.includes(name), `${name} must be in the scan`);
  }
});

test('every JSON-LD page marks exactly one page-entity block, or is a listed exemption', () => {
  const unmarked = [];
  for (const file of pages) {
    const blocks = jsonLd(read(file));
    if (!blocks.length) continue;
    const hits = marked(blocks);

    if (NO_PAGE_ENTITY.has(file)) {
      assert.equal(
        hits.length, 0,
        `${file} is listed as having no page-entity block but marks ${hits.length} — `
          + 'remove it from NO_PAGE_ENTITY',
      );
      continue;
    }
    if (hits.length !== 1) { unmarked.push({ page: file, marked: hits.length }); }
  }
  assert.deepEqual(
    unmarked, [],
    'each of these must put data-lang-jsonld on the one block describing the page — '
      + 'without it neither renderer localizes its JSON-LD, silently, in all eleven '
      + 'locales. If the page genuinely has no such block, add it to NO_PAGE_ENTITY.',
  );
});

test('a marked block is never the breadcrumb trail', () => {
  // The bug this whole file exists for, stated directly.
  for (const file of pages) {
    for (const block of marked(jsonLd(read(file)))) {
      const type = block.data['@type'];
      const types = Array.isArray(type) ? type : [type];
      assert.ok(
        !types.includes('BreadcrumbList'),
        `${file} marks its BreadcrumbList as the page entity — a trail has no name or `
          + 'description to localize',
      );
    }
  }
});

test('stagify-plus.html marks its SoftwareApplication, not the trail it leads with', () => {
  // The concrete regression: the block is second in document order, behind the trail.
  const blocks = jsonLd(read('stagify-plus.html'));
  assert.equal(blocks[0].data['@type'], 'BreadcrumbList', 'the trail still comes first');
  assert.deepEqual(marked(blocks).map((b) => b.data['@type']), ['SoftwareApplication']);
});

test('the renderer localizes the marked block and leaves the trail alone', () => {
  const spanish = localeByPrefix('es');
  assert.ok(spanish, 'the es locale must exist');

  const out = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title>'
      + '<script type="application/ld+json">'
      + '{"@type":"BreadcrumbList","itemListElement":[]}</script>'
      + '<script type="application/ld+json" data-lang-jsonld>'
      + '{"@type":"SoftwareApplication","name":"EN","description":"EN"}</script>'
      + '</head><body></body></html>',
    translations: { meta: { title: 'Título ES', description: 'Descripción ES' } },
    locale: spanish,
    path: '/stagify-plus.html',
  });

  const blocks = jsonLd(out);
  assert.equal(blocks[0].data.name, undefined, 'the trail must not grow a name');
  assert.equal(blocks[0].data.description, undefined, 'the trail must not grow a description');
  assert.equal(blocks[1].data.name, 'Título ES');
  assert.equal(blocks[1].data.description, 'Descripción ES');
});

test('an unmarked page keeps its JSON-LD exactly as authored', () => {
  // guides.html's six HowTo blocks: the page title belongs to none of them.
  const spanish = localeByPrefix('es');
  const out = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title>'
      + '<script type="application/ld+json">'
      + '{"@type":"HowTo","name":"Your first free staging"}</script>'
      + '</head><body></body></html>',
    translations: { meta: { title: 'Título ES', description: 'Descripción ES' } },
    locale: spanish,
    path: '/guides.html',
  });
  const [howTo] = jsonLd(out);
  assert.equal(howTo.data.name, 'Your first free staging');
  assert.equal(howTo.data.description, undefined);
});

test('a localized page points its breadcrumb trail at the localized tree', () => {
  const spanish = localeByPrefix('es');
  const out = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title>'
      + '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":['
      + `{"@type":"ListItem","position":1,"name":"Home","item":"${SITE_ORIGIN}/"},`
      + `{"@type":"ListItem","position":2,"name":"Stagify+","item":"${SITE_ORIGIN}/stagify-plus.html"},`
      + `{"@type":"ListItem","position":3,"name":"Blog","item":"${SITE_ORIGIN}/blog/"}`
      + ']}</script></head><body></body></html>',
    translations: { meta: { title: 'T', description: 'D' } },
    locale: spanish,
    path: '/stagify-plus.html',
  });

  const items = jsonLd(out)[0].data.itemListElement.map((i) => i.item);
  assert.deepEqual(items, [
    `${SITE_ORIGIN}/es`,
    `${SITE_ORIGIN}/es/stagify-plus.html`,
    // The blog has no localized copy, so the English URL is the correct target — a
    // blanket prefix rewrite would point it at a page that does not exist.
    `${SITE_ORIGIN}/blog/`,
  ]);
});

test('English renders leave the trail as authored', () => {
  const english = localeByPrefix('');
  assert.ok(english, 'the root locale must exist');
  const html = '<html><head><title data-lang="meta.title">T</title>'
    + '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":['
    + `{"@type":"ListItem","position":1,"name":"Home","item":"${SITE_ORIGIN}/"}`
    + ']}</script></head><body></body></html>';
  const out = renderLocalizedPage({
    html, translations: { meta: { title: 'T', description: 'D' } }, locale: english, path: '/stagify-plus.html',
  });
  assert.equal(jsonLd(out)[0].data.itemListElement[0].item, `${SITE_ORIGIN}/`);
});

test('every authored breadcrumb URL for a localized page is one the renderer can rewrite', () => {
  // The rewrite matches on the exact LOCALIZED_PAGES path. An authored trail that spells
  // the same page differently ('/index.html', a trailing slash, a stray query) would not
  // match, and would silently keep pointing at English.
  const localizedPaths = new Set(LOCALIZED_PAGES.map((p) => p.path));
  const offenders = [];
  for (const file of pages) {
    for (const block of jsonLd(read(file))) {
      if (block.data['@type'] !== 'BreadcrumbList') continue;
      for (const entry of block.data.itemListElement || []) {
        if (typeof entry.item !== 'string' || !entry.item.startsWith(SITE_ORIGIN)) continue;
        const p = entry.item.slice(SITE_ORIGIN.length) || '/';
        if (p === '/index.html') offenders.push({ page: file, item: entry.item });
        // A path that is neither a localized page nor a known English-only URL is fine;
        // only the aliases of a localized page are a problem.
        if (p.endsWith('.html/') && localizedPaths.has(p.slice(0, -1))) {
          offenders.push({ page: file, item: entry.item });
        }
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    "spell a localized page the way LOCALIZED_PAGES does ('/' not '/index.html') or the "
      + 'locale rewrite skips it',
  );
});

test('the client mirrors the server: language-loader selects the marked block', () => {
  // The two renderers are separate implementations of one rule, and both had this bug.
  const src = fs.readFileSync(path.join(PUBLIC, 'scripts', 'language-loader.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')          // a comment naming the selector is not the selector
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /querySelector\(\s*['"]script\[type="application\/ld\+json"\]\[data-lang-jsonld\]['"]\s*\)/);
  assert.doesNotMatch(
    src,
    /querySelector\(\s*['"]script\[type="application\/ld\+json"\]['"]\s*\)/,
    'the bare first-block selector is the bug: on guides/enterprise/stagify-plus it '
      + 'returns the breadcrumb trail',
  );
});
