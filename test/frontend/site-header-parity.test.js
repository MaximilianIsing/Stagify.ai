// Tier: markup drift guard — the whole `<header class="site-header">` block, across
// every page that carries it.
//
// WHY THIS EXISTS
// The site header is hand-copied into ten public/*.html files. There is no partial and
// there cannot be one: lib/i18n/render-page.js is a PURE STRING TRANSFORM over the
// static English HTML, so a header injected by client-side JS would never be
// server-side translated — /es, /fr/guides.html … would ship an English header to
// crawlers and no-JS clients. The markup has to stay literal in all ten files, which
// means the only thing standing between it and drift is a test.
//
// staging-menu.test.js already makes this argument and already holds one SUB-BLOCK (the
// Staging dropdown) byte-identical. Everything around that sub-block — the brand, the
// nav links, the profile menu, .nav-trailing — was unguarded, and that is exactly where
// the drift collected. What it cost, before this guard:
//
//   • `data-lang-attr="auth.accountMenu|aria-label"` on #profile-menu-btn existed on
//     index.html ALONE. The other nine pages shipped a hardcoded English "Account menu"
//     — so on the eight of them that are in LOCALIZED_PAGES, a screen-reader user
//     browsing in any of the eleven languages hit an English control. That is the class
//     of bug this file is for: invisible on the page, invisible in review, and only
//     reachable with a screen reader in a non-English locale.
//   • ai-designer.html and masking-studio.html (both localized) lost the brand
//     wordmark's data-lang, so "Stagify.ai" stayed English on every localized render.
//   • ai-designer/masking-studio/status lost `data-hover-glow` on .mobile-test-text.
//
// WHAT IS COMPARED
// Whitespace is collapsed before comparing, so indentation and line breaks are NOT
// policed — every attribute, element, key and text node is. That is deliberate: failing
// CI over a re-indent trains people to weaken the guard, and no formatting difference
// has ever shipped a bug here. All three drifts above are caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navPages, extractSiteHeader } from '../helpers/nav-pages.js';

/**
 * The one documented per-page difference in the header's opening tags: gallery.html
 * carries `id="gal-nav"` on its <nav> (gallery-app.js marks that node inert while the
 * detail panel is open). Its own comment records why the id is on the <nav> and not on
 * <header class="site-header"> — other guards match that opening tag literally.
 */
const PER_PAGE_ATTRS = / id="gal-nav"/g;

/** Collapse to the semantic content: comments out, allowlisted attrs out, whitespace flat. */
function normalize(block) {
  return block
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(PER_PAGE_ATTRS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The `<div class="nav-trailing">…</div>` block, by <div> depth (it nests).
 * @param {string} block
 * @returns {string | null}
 */
function extractNavTrailing(block) {
  const start = block.indexOf('<div class="nav-trailing">');
  if (start === -1) return null;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(block))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return block.slice(start, m.index + m[0].length);
  }
  return null;
}

/**
 * The three marketing pages whose .nav-trailing is deliberately EMPTY: each has its own
 * <header class="ent-hero"> / .sp-hero headline immediately below the nav, so the mobile
 * mini-headline that the other pages carry would duplicate it on the one viewport where
 * space is tightest.
 */
const EMPTY_TRAILING = new Set(['enterprise.html', 'stagify-plus.html', 'plus-welcome.html']);

/** Every page's header must be extractable — a truncation must fail loudly, not compare. */
function headersByPage() {
  const pages = navPages();
  assert.ok(pages.length >= 10, `expected the nav on at least 10 pages, found ${pages.length}`);
  return pages.map(({ name, html }) => {
    const block = extractSiteHeader(html);
    assert.ok(block, `${name}: could not extract a balanced <header class="site-header"> block`);
    return { name, block };
  });
}

test('the site header is identical on every page that carries it', () => {
  /** @type {Map<string, string[]>} */
  const shapes = new Map();
  for (const { name, block } of headersByPage()) {
    // .nav-trailing has two sanctioned shapes (asserted in the next test); hold it
    // aside here so this assertion is about the other 95% of the header.
    const trailing = extractNavTrailing(block);
    const body = normalize(trailing ? block.replace(trailing, '<div class="nav-trailing">§</div>') : block);
    if (!shapes.has(body)) shapes.set(body, []);
    shapes.get(body).push(name);
  }

  assert.equal(
    shapes.size,
    1,
    'the site header has drifted between pages — it is copied by hand into every ' +
      'nav-bearing file and must stay identical. Groups that disagree:\n' +
      [...shapes.values()].map((g) => '  ' + g.join(', ')).join('\n'),
  );
});

test('.nav-trailing is one of exactly two sanctioned shapes, on the expected pages', () => {
  /** @type {Map<string, string[]>} */
  const shapes = new Map();
  for (const { name, block } of headersByPage()) {
    const trailing = extractNavTrailing(block);
    assert.ok(trailing, `${name}: no .nav-trailing block`);
    const key = normalize(trailing);
    if (!shapes.has(key)) shapes.set(key, []);
    shapes.get(key).push(name);
  }

  // Exactly two — so a page that loses `data-hover-glow`, or a data-lang inside the
  // mobile headline, becomes a THIRD shape and fails here rather than passing as
  // "well, that group is allowed to differ".
  assert.equal(
    shapes.size,
    2,
    '.nav-trailing should have exactly two shapes (the mobile headline, and empty on the ' +
      'three marketing pages). Groups found:\n' +
      [...shapes.values()].map((g) => '  ' + g.join(', ')).join('\n'),
  );

  const empty = [...shapes.entries()].find(([k]) => k === '<div class="nav-trailing"></div>');
  assert.ok(empty, 'neither .nav-trailing shape is the empty one');
  assert.deepEqual(
    [...empty[1]].sort(),
    [...EMPTY_TRAILING].sort(),
    'the set of pages with an empty .nav-trailing changed — if that is deliberate, update ' +
      'EMPTY_TRAILING and say why in its comment',
  );
});

test('every page localizes the account menu, the brand, and the nav links', () => {
  // Belt-and-braces over the parity check above: parity alone would be satisfied by all
  // ten pages being identically WRONG. These are the keys whose absence actually shipped.
  const required = [
    'data-lang-attr="auth.accountMenu|aria-label"',
    'data-lang-attr="navigation.logoAlt|alt"',
    'data-lang="navigation.brand"',
    'data-lang="navigation.brandSuffix"',
    'data-lang="navigation.home"',
    'data-lang="navigation.gallery"',
    'data-lang="navigation.guides"',
    'data-lang="navigation.contactUs"',
  ];
  const missing = [];
  for (const { name, block } of headersByPage()) {
    for (const attr of required) if (!block.includes(attr)) missing.push(`${name}: ${attr}`);
  }
  assert.deepEqual(missing, [], `header i18n hooks missing:\n  ${missing.join('\n  ')}`);
});

// ---- sanity: the guard would actually notice ------------------------------------
// A normalizer that flattens too much passes forever for the wrong reason.

test('sanity: normalize() does not hide a dropped attribute', () => {
  const [{ block }] = headersByPage();
  const mutated = block.replace(' data-lang-attr="auth.accountMenu|aria-label"', '');
  assert.notEqual(mutated, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(mutated), normalize(block));
});

test('sanity: normalize() does not hide a dropped nav link or a changed key', () => {
  const [{ block }] = headersByPage();
  const dropped = block.replace(/<a href="guides\.html"[^>]*>Guides<\/a>/, '');
  assert.notEqual(dropped, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(dropped), normalize(block));

  const rekeyed = block.replace('data-lang="navigation.guides"', 'data-lang="navigation.guide"');
  assert.notEqual(rekeyed, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(rekeyed), normalize(block));
});

test('sanity: the extractor survives a comment that quotes the header open tag', () => {
  // gallery.html contains `<header class="site-header">` inside a comment. Naive depth
  // counting reads it as a second opening tag and extracts nothing.
  const gallery = navPages().find((p) => p.name === 'gallery.html');
  assert.ok(gallery, 'gallery.html is no longer a nav page — update this check');
  assert.ok(
    gallery.html.includes('<!--') &&
      gallery.html.slice(gallery.html.indexOf('<!--')).includes('<header class="site-header">'),
    'gallery.html no longer quotes the header open tag in a comment — this check is moot',
  );
  const block = extractSiteHeader(gallery.html);
  assert.ok(block && block.endsWith('</header>'), 'extractor failed on the quoting comment');
});
