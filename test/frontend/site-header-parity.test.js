// Tier: stale-bake guard — the whole `<header class="site-header">` block, across every
// page that carries it.
//
// WHY THIS EXISTS
// The header has to sit literally in every page: lib/i18n/render-page.js is a PURE
// STRING TRANSFORM over the static English HTML, so a header injected by client-side JS
// would never be server-side translated. It used to be hand-copied into sixteen files
// and drifted (a missing data-lang-attr on #profile-menu-btn shipped an English
// "Account menu" to screen readers on every localized page; two studios lost the brand
// wordmark's data-lang). It is now baked from lib/site/partials/site-header.html by
// scripts/build-i18n-seo.js, between generated markers. This file fails the build when
// a page's baked copy is stale, or when a page carries the header without being listed
// in CHROME_PAGES (lib/site/chrome.js), i.e. was hand-copied again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { navPages, publicPages, extractSiteHeader, maskComments } from '../helpers/nav-pages.js';
import {
  CHROME_PAGES,
  HEADER_BEGIN,
  HEADER_END,
  HEADER_OPEN,
  bakedRegion,
  expectedRegion,
  injectChrome,
  renderSiteHeader,
} from '../../lib/site/chrome.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const REBUILD = 'rerun `node scripts/build-i18n-seo.js`';

const headerPages = CHROME_PAGES.filter((p) => p.header);

/** @param {string} file @returns {string} CRLF-normalized source */
function read(file) {
  return fs.readFileSync(path.join(PUBLIC, file), 'utf8').replace(/\r\n/g, '\n');
}

test('every page carrying the site header is listed in CHROME_PAGES', () => {
  const carrying = publicPages()
    .filter((p) => extractSiteHeader(p.html) !== null)
    .map((p) => p.name)
    .sort();
  assert.ok(carrying.length >= 10, `expected the header on at least 10 pages, found ${carrying.length}`);
  assert.deepEqual(
    carrying,
    headerPages.map((p) => p.file).sort(),
    'the set of pages with <header class="site-header"> differs from CHROME_PAGES in ' +
      `lib/site/chrome.js. Add the page there (do not copy the header by hand), then ${REBUILD}`,
  );
});

test('every listed page carries the current baked header', () => {
  const stale = [];
  for (const page of headerPages) {
    const html = read(page.file);
    const region = bakedRegion(html, 'header');
    assert.ok(region, `${page.file}: no ${HEADER_BEGIN.slice(0, 22)}… marker. ${REBUILD}`);
    if (region !== expectedRegion(html, page, 'header')) stale.push(page.file);
  }
  assert.deepEqual(stale, [], `the baked site header is stale on: ${stale.join(', ')}. ${REBUILD}`);
});

test('each page has exactly one site header, and it is the baked one', () => {
  for (const page of headerPages) {
    const html = read(page.file);
    const count = maskComments(html).split(HEADER_OPEN).length - 1;
    assert.equal(count, 1, `${page.file}: expected one ${HEADER_OPEN} outside comments, found ${count}`);
    const region = bakedRegion(html, 'header');
    const header = extractSiteHeader(html);
    assert.ok(region && header && region.includes(header), `${page.file}: the site header sits outside its markers`);
  }
});

test('the header partial localizes the account menu, the brand, and the nav links', () => {
  // The keys whose absence actually shipped. The bake makes every page agree; this makes
  // sure what they agree on is right.
  const html = renderSiteHeader();
  const required = [
    'data-lang-attr="auth.accountMenu|aria-label"',
    'data-lang-attr="navigation.logoAlt|alt"',
    'data-lang="navigation.brand"',
    'data-lang="navigation.brandSuffix"',
    'data-lang="navigation.home"',
    'data-lang="navigation.gallery"',
    'data-lang="navigation.guides"',
    'data-lang="navigation.contactUs"',
    'data-hover-glow',
  ];
  const missing = required.filter((attr) => !html.includes(attr));
  assert.deepEqual(missing, [], `header i18n hooks missing from site-header.html: ${missing.join(', ')}`);
});

test('variants: navId lands on the <nav>, trailing:false empties .nav-trailing', () => {
  const base = renderSiteHeader();
  const gallery = renderSiteHeader({ navId: 'gal-nav' });
  assert.ok(gallery.startsWith(HEADER_OPEN), 'the <header> open tag must stay attribute-free');
  assert.ok(gallery.includes('<nav class="nav" id="gal-nav">'));

  const bare = renderSiteHeader({ trailing: false });
  assert.ok(bare.includes('<div class="nav-trailing"></div>'));
  assert.ok(!bare.includes('mobile-test-text'));
  assert.ok(base.includes('mobile-test-text'));
  assert.ok(bare.endsWith('</header>'), 'emptying .nav-trailing truncated the header');
});

test('injectChrome bakes bare markup, then refreshes idempotently, preserving CRLF and indent', () => {
  const bare = ['<body>', '  <header class="site-header"><nav class="nav">old</nav></header>', '  <main></main>', '</body>', ''].join('\r\n');
  const page = { file: 'x.html', header: {} };
  const once = injectChrome(bare, page);
  assert.equal(injectChrome(once, page), once, 'a second run changed the output');
  assert.ok(!once.replace(/\r\n/g, '').includes('\n'), 'a bare LF leaked into a CRLF file');
  assert.ok(once.includes(`\r\n  ${HEADER_BEGIN}\r\n  ${HEADER_OPEN}\r\n    <nav class="nav">`));
  assert.ok(once.includes(`</header>\r\n  ${HEADER_END}\r\n  <main>`));
  assert.ok(!once.includes('>old<'));
});

test('sanity: the extractor survives a comment that quotes the header open tag', () => {
  // gallery.html quotes `<header class="site-header">` inside a comment. Naive depth
  // counting reads it as a second opening tag and extracts nothing.
  const gallery = navPages().find((p) => p.name === 'gallery.html');
  assert.ok(gallery, 'gallery.html is no longer a nav page — update this check');
  assert.ok(
    (gallery.html.match(/<!--[\s\S]*?-->/g) || []).some((c) => c.includes(HEADER_OPEN)),
    'gallery.html no longer quotes the header open tag in a comment — this check is moot',
  );
  const block = extractSiteHeader(gallery.html);
  assert.ok(block && block.endsWith('</header>'), 'extractor failed on the quoting comment');
});
