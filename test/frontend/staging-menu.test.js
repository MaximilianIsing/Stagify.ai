// Tier: frontend island logic (DOM-stubbed) + a markup drift guard —
// public/scripts/staging-menu.js and the nav block it drives.
//
// The top nav's "Staging" dropdown replaced two bare links (AI Designer, Masking
// Studio) that auth.js revealed by stripping `.hidden`. Two things about that
// change need holding down:
//
//  1. THE LOCK. The three Stagify+ rows are now VISIBLE to free users rather than
//     hidden, so "locked" has to actually mean something: the one class the
//     stylesheet dims and reveals the "Stagify+" chip with. A regression here is
//     silent — the rows still render, they just stop looking locked, and the only
//     thing standing between a free user and the studios is each studio's own
//     head-gate.
//
//  2. THE DUPLICATION. The site-header is hand-copied into nine HTML files with no
//     partial and, until this suite, no test. That is how the nav drifted into
//     eight near-identical variants in the first place. The block is byte-identical
//     on every page by construction, so assert exactly that — the guard is the
//     deliverable here, not the one-time edit.
//
// The browser-level proof is e2e/staging-nav.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

// ---- Minimal fake DOM ------------------------------------------------------

function makeItem({ pro, locked = pro } = {}) {
  const classes = new Set(['staging-menu__item']);
  if (locked) classes.add('is-locked');
  /** @type {Record<string, string>} */
  const attrs = {};
  return {
    pro,
    attrs,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    get locked() { return classes.has('is-locked'); },
  };
}

/** Install a document exposing `proItems` for `[data-staging-pro]`, plus a plan. */
function mountMenu({ plan, proItems = [makeItem({ pro: true }), makeItem({ pro: true }), makeItem({ pro: true })] } = {}) {
  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: (sel) => (sel === '[data-staging-pro]' ? proItems : []),
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: plan === undefined ? undefined : { isProUser: () => plan === 'pro', user: { plan } },
  });
  return proItems;
}

// The module self-initialises on import (it wires the dropdown), so a document
// has to exist before the import — not after.
mountMenu({ plan: undefined, proItems: [] });
const { stagingItemLocked, syncStagingMenu } = await import('../../public/scripts/staging-menu.js');

// ---- The pure rule ---------------------------------------------------------

test('stagingItemLocked locks Stagify+ rows for everyone who is not Pro', () => {
  assert.equal(stagingItemLocked(true, true), false, 'a Pro user gets the studios');
  assert.equal(stagingItemLocked(false, true), true, 'a free user does not');
});

test('stagingItemLocked never locks a non-Pro row', () => {
  // "Image Staging" is the whole point of the dropdown existing for free users.
  // An anonymous visitor gets the sign-in prompt from the staging screen itself,
  // so the row must stay live for them too.
  assert.equal(stagingItemLocked(false, false), false);
  assert.equal(stagingItemLocked(true, false), false);
});

// ---- The DOM writer --------------------------------------------------------

test('syncStagingMenu unlocks every Pro row for a Pro user', () => {
  const items = mountMenu({ plan: 'pro' });
  assert.equal(syncStagingMenu(), true);
  for (const it of items) assert.equal(it.locked, false);
});

test('syncStagingMenu locks every Pro row for a free account', () => {
  const items = mountMenu({ plan: 'free', proItems: [makeItem({ pro: true, locked: false }), makeItem({ pro: true, locked: false })] });
  assert.equal(syncStagingMenu(), false);
  for (const it of items) assert.equal(it.locked, true);
});

test('syncStagingMenu treats a signed-out visitor as not Pro', () => {
  // The markup ships locked, so this is really asserting the writer does not
  // UNLOCK on the way past when there is no user yet.
  const items = mountMenu({ plan: undefined });
  assert.equal(syncStagingMenu(), false);
  assert.equal(items[0].locked, true);
});

test('syncStagingMenu falls back to user.plan when isProUser is missing', () => {
  const items = [makeItem({ pro: true })];
  globalThis.document = /** @type {any} */ ({
    readyState: 'complete', addEventListener() {}, removeEventListener() {},
    querySelectorAll: (sel) => (sel === '[data-staging-pro]' ? items : []),
  });
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { user: { plan: 'pro' } } });
  assert.equal(syncStagingMenu(), true);
  assert.equal(items[0].locked, false);
});

test('syncStagingMenu is idempotent and reversible', () => {
  // applyUserToUI() calls this from eight sites, and sign-out has to re-lock.
  const items = mountMenu({ plan: 'pro' });
  syncStagingMenu();
  syncStagingMenu();
  assert.equal(items[0].locked, false);

  globalThis.window.StagifyAuth = { isProUser: () => false, user: { plan: 'free' } };
  assert.equal(syncStagingMenu(), false);
  assert.equal(items[0].locked, true, 'signing out must put the lock back');
});

test('syncStagingMenu no-ops on pages with no menu', () => {
  // admin.html has an empty .nav-center, and auth.js calls this unconditionally.
  mountMenu({ plan: 'pro', proItems: [] });
  assert.doesNotThrow(() => syncStagingMenu());
  assert.equal(syncStagingMenu(), false);
});

// ---- The nav markup drift guard -------------------------------------------

// The wrapper, matched in full (with the closing quote): `<div class="staging-menu`
// alone also matches the inner `staging-menu__panel`, which made the "exactly one
// menu" check below fire on every page.
//
// It carried `desktop-only` until 2026-08-01. That hid the ENTIRE dropdown below
// 768px — and since the dropdown is the only nav entry to Image Staging, Basic Mask,
// the AI Designer and the Masking Studio, a phone had no nav path to any staging tool
// at all, including the two features Stagify+ is sold on. The reason was real
// (.nav-center is overflow-x:clip, so a trigger-anchored 224px panel got cut near
// either edge); the fix was to anchor the panel to .nav-center itself so it is exactly
// as wide as the clipping box. See the mobile block in styles.css.
const MENU_OPEN = '<div class="staging-menu"';

/**
 * Extract the staging-menu block by matching <div> depth, rather than by a
 * regex for its closing tags — the block nests, and a lazy `[\s\S]*?</div>`
 * would stop at the first inner close and "pass" on a truncated block.
 */
function extractBlock(html) {
  const start = html.indexOf(MENU_OPEN);
  if (start === -1) return null;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null;
}

/** Every public/*.html that actually carries nav links. */
function navPages() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .map((name) => ({ name, html: fs.readFileSync(path.join(PUBLIC, name), 'utf8').replace(/\r\n/g, '\n') }))
    .filter((p) => p.html.includes('<header class="site-header">') && p.html.includes('class="nav-link'));
}

test('every nav-bearing page carries the staging menu, byte-identical', () => {
  const pages = navPages();
  // Sweep guard: if the discovery breaks, the assertions below pass vacuously.
  assert.ok(pages.length >= 8, `expected the nav on at least 8 pages, found ${pages.length}`);

  /** @type {Map<string, string[]>} */
  const shapes = new Map();
  const missing = [];
  for (const { name, html } of pages) {
    const block = extractBlock(html);
    if (!block) { missing.push(name); continue; }
    assert.equal(html.indexOf(MENU_OPEN), html.lastIndexOf(MENU_OPEN), `${name} has more than one staging menu`);
    if (!shapes.has(block)) shapes.set(block, []);
    shapes.get(block).push(name);
  }

  assert.deepEqual(missing, [], `page(s) with a nav but no Staging menu: ${missing.join(', ')}`);
  assert.equal(
    shapes.size,
    1,
    'the staging menu has drifted between pages — it is copied by hand into every ' +
      `nav-bearing file and must stay identical:\n${[...shapes.values()].map((g) => '  ' + g.join(', ')).join('\n')}`,
  );
});

test('the staging menu lists the four tools in order, with the right three locked', () => {
  const [{ html }] = navPages();
  const block = extractBlock(html);

  const hrefs = [...block.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    ['index.html#stage', 'index.html#basic-mask', 'ai-designer.html', 'masking-studio.html'],
    'order is product-visible: Image Staging, Basic Mask, AI Designer, Masking Studio',
  );

  // Relative and un-prefixed, so the locale rewriters (lib/i18n/render-page.js's
  // rewriteHref and scripts/i18n-routing.js's localizeLinks) can re-point them at
  // /es, /fr, … — a leading slash would strand non-English visitors in English.
  for (const href of hrefs) assert.ok(!href.startsWith('/'), `${href} must stay relative`);

  const rows = [...block.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(rows.filter((r) => r.includes('data-staging-pro')).length, 3);
  assert.ok(!rows[0].includes('data-staging-pro'), 'Image Staging is free');

  // Ships locked: free/anonymous is the no-JS default, so a Pro user is unlocked
  // after /api/auth/me rather than a free user being locked after it — the other
  // direction would flash an unlocked menu at everyone.
  for (const row of rows.slice(1)) assert.ok(row.includes('is-locked'), 'Pro rows must ship locked');

  // NOT aria-disabled. A locked row is a working link to the Stagify+ page, so
  // announcing it as disabled would be false AND would stop assistive tech from
  // following it. The visible "Stagify+" chip carries the state instead.
  assert.ok(!block.includes('aria-disabled'), 'a locked row is still an operable link');
});

test('the old pro nav links are gone everywhere', () => {
  // They were toggled by a selector in auth.js that no longer exists; a leftover
  // copy would be a permanently invisible link.
  const stale = navPages().filter(
    (p) => p.html.includes('nav-ai-designer-pro') || p.html.includes('nav-masking-studio-pro'),
  );
  assert.deepEqual(stale.map((p) => p.name), []);
});

test('the menu labels resolve to keys that exist in every language pack', () => {
  const [{ html }] = navPages();
  const block = extractBlock(html);
  // data-lang-attr is included, and its `key|attribute` payload split: the
  // Stagify+ mark is an <img> whose alt is translated that way, and the alt is
  // the ONLY thing announcing the locked state (these rows carry no
  // aria-disabled on purpose). A key-shaped regex alone would have quietly
  // stopped covering it the moment the worded chip became a logo.
  const keys = [...block.matchAll(/data-lang(?:-html|-attr)?="([^"]+)"/g)].map((m) => m[1].split('|')[0]);
  assert.ok(keys.length >= 6, `expected the trigger, four labels and the Stagify+ alt, found ${keys.length}`);
  assert.ok(keys.includes('navigation.plusBadge'), 'the Stagify+ mark must keep a translated alt');

  const dir = path.join(PUBLIC, 'languages');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of keys) {
      const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), pack);
      assert.equal(typeof value, 'string', `${file} is missing ${key}`);
      assert.ok(value.trim(), `${file} has an empty ${key}`);
    }
  }
});

// The Gallery tab has exactly the same drift problem as the Staging menu above: the site
// header is copied onto every nav-bearing page rather than templated, so a link added by
// hand lands on eight of nine and nobody notices which one was missed. `navPages()` finds
// the pages by their markup, so a NEW page with a nav is covered the day it is added.
test('every nav-bearing page carries the Gallery tab, between Staging and Guides', () => {
  const pages = navPages();
  assert.ok(pages.length >= 9, `expected the nav on at least 9 pages, found ${pages.length}`);

  const missing = [];
  const misplaced = [];
  for (const { name, html } of pages) {
    const gallery = html.indexOf('href="gallery.html" class="nav-link"');
    if (gallery === -1) { missing.push(name); continue; }
    assert.equal(
      html.indexOf('href="gallery.html" class="nav-link"'),
      html.lastIndexOf('href="gallery.html" class="nav-link"'),
      `${name} has more than one Gallery tab`,
    );
    // Order is the requirement, not just presence: after the Staging menu closes, before
    // Guides. Compared by position rather than by a regex over the whole nav, so a
    // reflow of the surrounding markup does not make this pass by accident.
    const staging = html.indexOf('data-staging-menu');
    const guides = html.indexOf('href="guides.html" class="nav-link"');
    if (!(staging < gallery && gallery < guides)) misplaced.push(name);
  }

  assert.deepEqual(missing, [], `page(s) with a nav but no Gallery tab: ${missing.join(', ')}`);
  assert.deepEqual(misplaced, [], `Gallery tab not between Staging and Guides on: ${misplaced.join(', ')}`);
});

test('the Gallery tab is translated everywhere it claims to be', () => {
  // plus-welcome.html is the one page that omits data-lang on its nav links, because it
  // is not in LOCALIZED_PAGES. That is convention, not drift — so the assertion is
  // "every page that DOES localize its Guides link also localizes Gallery", which stays
  // true if plus-welcome is ever added to the localized set.
  for (const { name, html } of navPages()) {
    const guidesLocalized = html.includes('href="guides.html" class="nav-link" data-lang="navigation.guides"');
    const galleryLocalized = html.includes('href="gallery.html" class="nav-link" data-lang="navigation.gallery"');
    assert.equal(galleryLocalized, guidesLocalized, `${name}: Gallery and Guides disagree about being localized`);
  }

  const dir = path.join(PUBLIC, 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(packs.length, 11, 'sanity: eleven packs');
  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(pack.navigation?.gallery?.trim(), `${file} is missing navigation.gallery`);
  }
});
