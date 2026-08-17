// Tier: frontend island logic (DOM-stubbed) + a markup drift guard —
// public/scripts/staging-menu.js and the nav block it drives.
//
// The top nav's "Staging" dropdown replaced two bare links (AI Designer, Masking
// Studio) that auth.js revealed by stripping `.hidden`. Two things about that
// change need holding down:
//
//  1. THE LOCK. The three Stagify+ rows are now VISIBLE to free users rather than
//     hidden, so "locked" has to actually mean something: the one class the
//     stylesheet dims the row and reveals the lock with. A regression here is
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
// Shared with site-header-parity.test.js so the two markup guards can never disagree
// about WHICH pages carry the nav — a narrower list in one of them would keep passing
// while checking fewer files.
import { navPages } from '../helpers/nav-pages.js';

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

// navPages() now comes from ../helpers/nav-pages.js (imported above).

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

test('the staging menu lists the five tools in order, with the right four locked', () => {
  const [{ html }] = navPages();
  const block = extractBlock(html);

  const hrefs = [...block.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    ['index.html#stage', 'index.html#basic-mask', 'ai-designer.html', 'masking-studio.html', 'exterior-studio.html'],
    'order is product-visible: Image Staging, Basic Mask, AI Designer, Masking Studio, Exterior Studio',
  );

  // Relative and un-prefixed, so the locale rewriters (lib/i18n/render-page.js's
  // rewriteHref and scripts/i18n-routing.js's localizeLinks) can re-point them at
  // /es, /fr, … — a leading slash would strand non-English visitors in English.
  for (const href of hrefs) assert.ok(!href.startsWith('/'), `${href} must stay relative`);

  const rows = [...block.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(rows.filter((r) => r.includes('data-staging-pro')).length, 4);
  assert.ok(!rows[0].includes('data-staging-pro'), 'Image Staging is free');

  // Ships locked: free/anonymous is the no-JS default, so a Pro user is unlocked
  // after /api/auth/me rather than a free user being locked after it — the other
  // direction would flash an unlocked menu at everyone.
  for (const row of rows.slice(1)) assert.ok(row.includes('is-locked'), 'Pro rows must ship locked');

  // NOT aria-disabled. A locked row is a working link to the Stagify+ page, so
  // announcing it as disabled would be false AND would stop assistive tech from
  // following it. The lock glyph carries the state instead — see the test below.
  assert.ok(!block.includes('aria-disabled'), 'a locked row is still an operable link');
});

test('the lock is the only Stagify+ mark, and it is what announces the state', () => {
  const [{ html }] = navPages();
  const block = extractBlock(html);
  const rows = block.split('<a class="staging-menu__item').slice(1);
  assert.equal(rows.length, 5, 'sanity: five rows');

  // Until 2026-08-03 a locked row carried an 18px Stagify+ logo NEXT TO the lock,
  // which said the same thing twice on a 14px row. Dropping it is only safe because
  // the lock took over the half of the job the logo's alt was doing: these rows carry
  // no aria-disabled on purpose, so with an aria-hidden lock and no logo a locked row
  // and an unlocked one would be announced identically.
  assert.ok(!block.includes('staging-menu__badge'), 'the redundant Stagify+ logo is gone');

  const locks = rows.map((row) => /<svg class="staging-menu__lock"[^>]*>/.exec(row)?.[0] || null);
  assert.deepEqual(
    locks.map(Boolean),
    [false, true, true, true, true],
    'the four Stagify+ rows, and only those, carry a lock',
  );

  for (const lock of locks.slice(1)) {
    // role="img" is what makes the label count: an <svg> with no role contributes
    // nothing to the link's name-from-content, aria-label or not.
    assert.match(lock, /\brole="img"/, 'the lock must expose itself as an image');
    assert.match(
      lock,
      /\bdata-lang-attr="navigation\.plusBadge\|aria-label"/,
      'the lock label must be translated, not hard-coded English',
    );
    assert.match(lock, /\baria-label="[^"]+"/, 'and it must not be empty');
    assert.ok(
      !/\baria-hidden/.test(lock),
      'the lock is no longer decoration — it is the only mark of the locked state',
    );
  }
});

test('the AI Designer row — and only it — is hidden on phones', () => {
  // The AI Designer is a PC-only tool. Offering it in the nav on a phone is a dead
  // end: public/scripts/ai-designer-gate.js bounces a phone-sized viewport straight
  // back to the home page, so the row would advertise a tool that answers a tap by
  // undoing it. The other three rows must stay — a phone had NO nav path to any
  // staging tool until 2026-08-01 (see the header above), and that is not being
  // re-introduced one row at a time.
  //
  // One page is enough: the byte-identical guard above proves all nine agree.
  const [{ html }] = navPages();
  const block = extractBlock(html);
  const rows = [...block.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

  const hidden = rows.filter((r) => /\bdesktop-only\b/.test(r));
  assert.equal(hidden.length, 1, 'exactly one row is desktop-only');
  assert.match(hidden[0], /href="ai-designer\.html"/, 'and it is the AI Designer row');
  // Added to the class list, not swapped in for it: the row is still a Stagify+ row
  // on the desktop widths where it does show.
  assert.match(hidden[0], /\bis-locked\b/, 'the AI Designer row must stay locked for free users');

  // The class only means something because styles.css acts on it. The exact
  // breakpoint is tied to the page gate's in
  // test/frontend/ai-designer/ai-designer-gate-mobile.test.js; this asserts the
  // rule exists at all, so deleting it cannot leave the row silently visible.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'styles.css'), 'utf8').replace(/\s+/g, '');
  assert.match(
    css,
    /@media\(max-width:\d+px\)\{\.desktop-only\{display:none!important\}/,
    'styles.css must still hide .desktop-only below the mobile breakpoint',
  );
});

test('a `data-staging-preview` row is locked, has a page, and that page has NO redirect gate', () => {
  // The attribute means "my own page handles non-Pro visitors", so the click handler
  // sends them to the page instead of the pricing table. That is only true — and only
  // safe — if three things hold together, and none of them fails loudly alone:
  //
  //   1. the row still LOOKS locked (the tool really does need Stagify+; only the
  //      destination differs);
  //   2. the page actually exists;
  //   3. the page's head gate, if it has one, NEVER NAVIGATES. Every other Stagify+ page
  //      loads a render-blocking *-gate.js that `location.replace`s a visitor with no
  //      token; one of those here and the click handler hands the visitor to a page that
  //      instantly bounces them — the same dead end the attribute exists to avoid, plus
  //      Googlebot never sees the public view the page was made indexable for.
  //
  //      A render-blocking gate that only RESHAPES the page is fine, and the preview page
  //      has one (preview-gate.js pre-applies the Pro layout from a cached plan so the
  //      pitch is not flashed at a subscriber). So this asserts the property that
  //      actually matters — no navigation — rather than the absence of a filename, which
  //      is what it used to do and which a rename would have satisfied without fixing
  //      anything.
  const [{ html }] = navPages();
  const block = extractBlock(html);
  const rows = [...block.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

  const preview = rows.filter((r) => r.includes('data-staging-preview'));
  // Every preview row is checked, not just the first. The count is asserted as a FLOOR
  // rather than pinned to a number: it was `=== 1` while the Exterior Studio was the only
  // one, which meant the second preview page failed this guard for being a second preview
  // page. A floor still catches the case that matters — the attribute disappearing
  // entirely, which would silently send every non-Pro visitor back to the pricing table.
  assert.ok(preview.length >= 1, 'no preview rows at all — the pattern has been removed');

  for (const row of preview) {
    assert.match(row, /\bis-locked\b/, 'a preview row is still a Stagify+ row');
    assert.match(row, /\bdata-staging-pro\b/, 'and still locks for non-Pro visitors');

    // Where a LOCKED click on this row actually lands, which is not always the row's href.
    // Three preview rows point straight at their own preview page; Basic Mask's href opens
    // a panel in the staging flow on the home page, so it names its pitch separately with
    // `data-staging-preview-page` and staging-menu.js prefers that when the row is locked.
    // Following the href here instead would have asserted against a URL no non-Pro visitor
    // is ever sent to — a guard that reads correct and checks nothing.
    const href = /data-staging-preview-page="([^"]+)"/.exec(row)?.[1]
      ?? /href="([^"]+)"/.exec(row)[1];
    const pagePath = path.join(PUBLIC, href);
    assert.ok(fs.existsSync(pagePath), `${href} must be a real page`);

    const head = fs.readFileSync(pagePath, 'utf8').split('</head>')[0];
    const gates = [...head.matchAll(/<script(?![^>]*\b(?:defer|async|type="module")\b)[^>]*\bsrc="([^"]*gate\.js)"/g)]
      .map((m) => m[1]);

    for (const src of gates) {
      const gatePath = path.join(PUBLIC, src.replace(/^\//, ''));
      assert.ok(fs.existsSync(gatePath), `${href} loads ${src}, which must be a real file`);
      assert.deepEqual(
        runGateSignedOut(gatePath),
        [],
        `${src} bounced a signed-out DESKTOP visitor — the preview row hands them to a page `
          + 'that instantly redirects, which is the dead end data-staging-preview exists to avoid',
      );
    }
  }
});

/**
 * Run a page's head gate as a signed-out visitor on a desktop viewport, and report every
 * URL it tried to navigate to.
 *
 * BEHAVIOURAL, not textual, and that is the whole point of this helper. The check here used
 * to be "the source contains no `location.replace`", which was right while every preview
 * gate was a pure reshaper — and wrong the moment the AI Designer became a preview, because
 * its gate legitimately redirects on the VIEWPORT (the studio is desktop-only) while no
 * longer redirecting on the VISITOR. A source scan cannot tell those two apart; running the
 * thing can. The fixture is the case the promise is about: a desktop-width browser with no
 * token, which is exactly the visitor the nav row is sending here.
 *
 * @param {string} gatePath - Absolute path to the gate source.
 * @returns {string[]} URLs the gate navigated to; empty is the passing case.
 */
function runGateSignedOut(gatePath) {
  const src = fs.readFileSync(gatePath, 'utf8');
  /** @type {string[]} */
  const navigated = [];
  let className = '';
  const html = {
    get className() { return className; },
    set className(v) { className = v; },
    classList: { contains: () => false, remove: () => {} },
  };
  const win = {
    location: {
      pathname: '/',
      replace: (t) => navigated.push(String(t)),
      assign: (t) => navigated.push(String(t)),
    },
    // A desktop viewport: every media query a gate asks about is false, which for the
    // `(max-width: 768px)` check means "not a phone".
    matchMedia: () => ({ matches: false }),
  };
  const run = new Function('window', 'document', 'location', 'localStorage', 'setTimeout', src);
  run(
    win,
    { documentElement: html, currentScript: { getAttribute: () => 'x-pro-pending' } },
    win.location,
    { getItem: () => null },
    // Fire timers immediately: a gate that redirects from a stall would otherwise pass by
    // simply never being given the chance to.
    (fn) => { fn(); return 1; },
  );
  return navigated;
}

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
  // data-lang-attr is included, and its `key|attribute` payload split: the locked
  // state is announced by the lock's aria-label, translated that way, and it is the
  // ONLY thing announcing it (these rows carry no aria-disabled on purpose). A
  // key-shaped regex alone would have quietly stopped covering it each time that
  // mark changed shape — worded chip, then logo alt, now the lock's own label.
  const keys = [...block.matchAll(/data-lang(?:-html|-attr)?="([^"]+)"/g)].map((m) => m[1].split('|')[0]);
  assert.ok(keys.length >= 7, `expected the trigger, five labels and the lock's label, found ${keys.length}`);
  assert.ok(keys.includes('navigation.plusBadge'), 'the lock must keep a translated label');

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
// The tab opens with the class attribute up to but not including its closing quote, so
// this matches whatever else joins `nav-link` in it (`desktop-only` does, below) while
// still being anchored to the Gallery link specifically.
const GALLERY_TAB = 'href="gallery.html" class="nav-link';

test('every nav-bearing page carries the Gallery tab, between Staging and Guides', () => {
  const pages = navPages();
  assert.ok(pages.length >= 9, `expected the nav on at least 9 pages, found ${pages.length}`);

  const missing = [];
  const misplaced = [];
  const shown = [];
  for (const { name, html } of pages) {
    const gallery = html.indexOf(GALLERY_TAB);
    if (gallery === -1) { missing.push(name); continue; }
    // Hidden twice over, and both are load-bearing:
    //   `desktop-only` — PC-only, like the AI Designer row above it;
    //   `hidden`       — signed-out visitors, stripped by scripts/gallery-tab.js once
    //                    /api/auth/me answers. It must SHIP hidden, or every visitor
    //                    sees the tab for a moment and then has it taken away.
    // gallery-gate.js turns both of those visitors away from the URL as well, so a
    // tab that showed for either would advertise a page that answers a click by
    // undoing it. `data-nav-gallery` is the hook the writer selects on — without it
    // the tab is hidden for everyone, forever, and nothing else notices.
    //
    // Collected across all pages rather than asserted per page: "eight of nine got
    // it" is the failure mode this whole test exists for.
    if (!html.startsWith(`${GALLERY_TAB} desktop-only hidden" data-nav-gallery`, gallery)) shown.push(name);
    assert.equal(
      html.indexOf(GALLERY_TAB),
      html.lastIndexOf(GALLERY_TAB),
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
  assert.deepEqual(
    shown,
    [],
    'Gallery tab must ship `class="nav-link desktop-only hidden" data-nav-gallery` — ' +
      `wrong on: ${shown.join(', ')}`,
  );
});

test('the Gallery tab is translated everywhere it claims to be', () => {
  // plus-welcome.html is the one page that omits data-lang on its nav links, because it
  // is not in LOCALIZED_PAGES. That is convention, not drift — so the assertion is
  // "every page that DOES localize its Guides link also localizes Gallery", which stays
  // true if plus-welcome is ever added to the localized set.
  for (const { name, html } of navPages()) {
    const guidesLocalized = html.includes('href="guides.html" class="nav-link" data-lang="navigation.guides"');
    const galleryLocalized = html.includes(`${GALLERY_TAB} desktop-only hidden" data-nav-gallery data-lang="navigation.gallery"`);
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

// ---- The per-row info tips -------------------------------------------------
//
// The four rows are four different tools, and the labels alone do not separate them —
// "Basic Mask" and "Masking Studio" read as the same feature twice. Each row therefore
// carries an info icon and a hover tip saying what the tool is and when to reach for it.
//
// Both are aria-hidden decoration INSIDE the <a>, which is the only placement that does
// not disturb the widget: the panel is role="menu" and the rows are role="menuitem", so
// a sibling <button> would need a non-menuitem wrapper, and a focusable control inside a
// row would add a tab stop to a menu driven by arrow keys. Assistive tech gets the same
// sentence from aria-describedby instead — hence the pairing asserted below.

test('every Staging row carries an info icon and a tip wired to its own aria-describedby', () => {
  const [{ html }] = navPages();
  const rows = extractBlock(html).split('<a class="staging-menu__item').slice(1);
  assert.equal(rows.length, 5, 'sanity: five rows');

  const ids = [];
  for (const row of rows) {
    const label = /data-lang(?:-html)?="(navigation\.[a-zA-Z0-9]+)"/.exec(row)?.[1];
    assert.ok(label, 'sanity: every row still has a label key');

    assert.equal(
      (row.match(/class="staging-menu__info"/g) || []).length,
      1,
      `${label} must carry exactly one info icon`,
    );

    // The description and the reference that points at it, matched as a pair. Split into
    // two lookups on purpose: a tip whose id nobody references is invisible to a screen
    // reader while looking perfectly fine on screen, which is precisely the regression a
    // "does the markup contain a tip" check would wave through.
    const described = /aria-describedby="([^"]+)"/.exec(row)?.[1];
    const tip = new RegExp(`<span class="staging-menu__tip" id="([^"]+)"([^>]*)>`).exec(row);
    assert.ok(tip, `${label} must carry a tip`);
    assert.equal(described, tip[1], `${label}: aria-describedby must name its own tip`);
    ids.push(tip[1]);

    // Load-bearing, not decoration-for-decoration's-sake: name-from-content SKIPS an
    // aria-hidden descendant while aria-describedby still reads a directly-referenced
    // hidden node. Drop the attribute and the link stops being announced as "Basic Mask,
    // Stagify+" and starts being announced as the whole paragraph.
    assert.match(tip[2], /\baria-hidden="true"/, `${label}: the tip must stay aria-hidden`);
    assert.match(
      row,
      /<span class="staging-menu__info" aria-hidden="true">/,
      `${label}: the info icon must stay aria-hidden`,
    );

    // Localized like every other string in this block. The "keys exist in every pack"
    // test above sweeps whatever data-lang keys it finds, so naming the namespace here
    // is what stops a tip from shipping as hard-coded English.
    assert.match(
      tip[2],
      /data-lang="navigation\.tips\.[a-zA-Z0-9]+"/,
      `${label}: the tip must resolve from navigation.tips.*`,
    );
  }

  assert.equal(new Set(ids).size, 5, `each row needs its own tip id, got: ${ids.join(', ')}`);
});

test('the stylesheet still reveals a tip on icon-hover and on row-focus', () => {
  // The markup is inert without these two rules, and inert markup fails silently: the
  // icon renders, the hover does nothing, and no other test notices. Focus is the half
  // that gets dropped — it is the ONLY way a keyboard reaches the tip, since the icon
  // is not focusable and arrowing down the menu lands on the row.
  // Comments stripped BEFORE the match, not just whitespace. The block these
  // selectors live in explains itself at length and names its own declarations in
  // prose — scanning the raw file would let every assertion below pass against the
  // commentary describing a rule that had been deleted.
  const css = fs
    .readFileSync(path.join(PUBLIC, 'styles', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');

  // Matched as a rule that DOES something, not as selector text that exists. The
  // desktop placement below re-states the tip selector to flip which way it slides
  // in from, so a bare "does this selector appear anywhere" grep is satisfied by that
  // copy even with the rule that actually reveals anything deleted.
  const reveal = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].find(
    ([, selectors, body]) =>
      selectors.includes('.staging-menu__info:hover~.staging-menu__tip') &&
      selectors.includes('.staging-menu__item:focus-visible.staging-menu__tip') &&
      body.includes('opacity:1'),
  );
  assert.ok(
    reveal,
    'one rule must reveal the tip from BOTH entry points: hovering the icon (mouse) ' +
      'and focusing the row (keyboard — the icon is not focusable)',
  );
  // opacity alone leaves an invisible box over the page, still swallowing nothing but
  // still there; visibility is what takes it out of the a11y tree and hit-testing.
  assert.match(reveal[2], /visibility:visible/, 'the tip must become visible, not just opaque');

  // Scoped to the tip's own declaration block, not searched for loose in the file:
  // `position:absolute` and `pointer-events:none` are two of the commonest strings in
  // this stylesheet, and a file-wide match would be satisfied by any other rule.
  const tipRule = /\.staging-menu__tip\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(tipRule, 'the tip needs a rule of its own');
  // Out of flow, or a shown tip shoves the rows below it down the panel.
  assert.match(tipRule, /position:absolute/, 'the tip must not take part in layout');
  // It overlays the rows beneath it; without this it would eat their hover and clicks.
  assert.match(tipRule, /pointer-events:none/, 'the tip must not intercept the pointer');
});
