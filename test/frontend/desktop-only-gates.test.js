// Tier: cross-file drift guard — the PC-only features, and the two halves that make
// one work.
//
// Two features are deliberately desktop-only: the AI Designer (2026-08-02) and the
// gallery (2026-08-02). Each is enforced TWICE, in files that know nothing about each
// other:
//
//   1. the nav entry carries `desktop-only`, which styles.css hides below a breakpoint;
//   2. the page itself loads a render-blocking gate that redirects a phone-sized
//      viewport to the home page, so the URL is not a way around (1).
//
// Either half alone is a bug rather than half a feature. Only (1) and the tab is gone
// while a bookmark still opens a layout the screen cannot use. Only (2) and the nav
// advertises a page that answers a tap by undoing it. And if the two disagree about the
// WIDTH, there is a band of viewports that gets exactly one of those.
//
// The per-gate behaviour (does the redirect actually fire, where does it send people,
// does it beat the plan check) is tested next to each gate:
//   test/frontend/ai-designer/ai-designer-gate-mobile.test.js
//   test/frontend/gallery/gallery-gate-mobile.test.js
// This file owns only what they share, so a third PC-only feature is covered by it the
// day it is written instead of needing a third copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALIZED_PAGES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SCRIPTS = path.join(PUBLIC, 'scripts');

/** The breakpoint styles.css hides `.desktop-only` at, as a number. */
function cssBreakpoint() {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'styles.css'), 'utf8').replace(/\s+/g, '');
  const m = /@media\(max-width:(\d+)px\)\{\.desktop-only\{display:none!important\}/.exec(css);
  assert.ok(m, 'styles.css no longer hides .desktop-only below a breakpoint — the class is inert');
  return Number(m[1]);
}

/**
 * Every link the site hides below the mobile breakpoint, by href.
 *
 * TWO shapes, because the site uses both and only one of them is obvious:
 *   1. the class ON the anchor — `<a class="nav-link desktop-only" href="gallery.html">`;
 *   2. the class on a WRAPPER — the footer's Developers link is
 *      `<span class="desktop-only"> · <a href="developers.html">…</a></span>`, wrapped
 *      that way so hiding the link takes its separator with it and the footer does not
 *      show an orphan "·". The home page's API footnote is the same shape on a `<p>`:
 *      there the sentence AROUND the link has to go too, not just the link.
 *
 * Shape 2 was invisible to this sweep for a while, which meant a footer link could be
 * hidden on phones while its page happily loaded on one — exactly the hole the whole
 * file exists to close, in the one place nobody thought to look.
 */
function hiddenNavTargets() {
  /** @type {Set<string>} */
  const targets = new Set();
  const add = (href) => { if (href) targets.add(href.split('#')[0]); };

  for (const name of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    if (!html.includes('<header class="site-header">')) continue;

    for (const tag of html.match(/<a\b[^>]*\bdesktop-only\b[^>]*>/g) || []) {
      const href = /\bhref="([^"]+)"/.exec(tag);
      if (href) add(href[1]);
    }
    // Non-greedy to the first matching close tag, which is enough: these wrappers hold a
    // separator or a sentence and a single anchor, never a nested wrapper of the same tag.
    // <p> is here for the home page's API footnote; keep the alternation narrow so a
    // sprawling <div class="desktop-only"> section cannot silently claim every link in it.
    for (const m of html.matchAll(/<(span|p)\b[^>]*\bdesktop-only\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      for (const a of m[2].matchAll(/\bhref="([^"]+)"/g)) add(a[1]);
    }
  }

  for (const [href] of jsBuiltHiddenRows()) add(href);
  return targets;
}

/**
 * Shape 3: the entry that is BUILT IN JAVASCRIPT and so has no tag to find.
 *
 * The account menu's dropdown has no static markup — profile-menu.js assembles it on
 * open — so the "API keys & credits" row exists only as a string literal in
 * scripts/profile-menu/api-keys-row.js. It is the entrance to the API dashboard, which
 * is PC-only, and without this branch the pairing below would pass vacuously for the
 * one hidden entry that is not a tag in an HTML file.
 * @returns {[string, string][]} `[href, source file]` for every hidden JS-built row.
 */
function jsBuiltHiddenRows() {
  /** @type {[string, string][]} */
  const rows = [];
  /** @param {string} dir @returns {void} */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // One string literal per row, which is how every JS-built anchor on this site is
      // written. A row split across concatenated fragments would be missed — the
      // sanity test below is what would catch that, by going red.
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/<a href="([^"#]+)[^"]*"[^>]*\bdesktop-only\b/g)) {
        rows.push([m[1], path.relative(PUBLIC, full)]);
      }
    }
  };
  walk(SCRIPTS);
  return rows;
}

/** The gate script a page loads in <head>, or null. */
function gateOf(page) {
  const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const m = /<script\s+src="scripts\/([a-z0-9-]+-gate\.js)"/i.exec(head ? head[1] : '');
  return m ? m[1] : null;
}

test('sanity: the sweep finds the PC-only nav entries it is meant to guard', () => {
  // Without this the two assertions below pass vacuously the moment the markup moves.
  const targets = hiddenNavTargets();
  assert.ok(targets.has('ai-designer.html'), 'the AI Designer row must be desktop-only');
  assert.ok(targets.has('gallery.html'), 'the Gallery tab must be desktop-only');
  // The wrapper shape. Without this the span branch above could stop matching and every
  // assertion below would still pass, having quietly dropped a page from the sweep.
  assert.ok(targets.has('developers.html'), 'the footer Developers link must be desktop-only');
  // The JS-built shape, same reasoning: the account menu's API row is a string literal,
  // and if it stops carrying `desktop-only` the dashboard is advertised on a phone that
  // its own gate then bounces.
  assert.ok(
    targets.has('api-keys.html'),
    'the account menu’s "API keys & credits" row must be desktop-only — see api-keys-row.js',
  );
});

test('the home page’s API footnote is hidden on phones', () => {
  // Pinned on its own rather than via hiddenNavTargets(), which cannot see this: the
  // footer's Developers link already puts developers.html in that set, so the footnote
  // could lose `desktop-only` without changing it by one element. developers-gate.js
  // redirects a phone straight back to the home page, so unhidden this line answers a
  // tap by returning the reader to where they already were.
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const note = /<p\b[^>]*\bclass="([^"]*\bplus-api\b[^"]*)"[^>]*>/.exec(html);
  assert.ok(note, 'index.html no longer has a <p class="plus-api"> — delist this test if the note is gone');
  assert.match(
    note[1],
    /\bdesktop-only\b/,
    'the home page API footnote must carry desktop-only — developers.html bounces phones back to this page',
  );
});

test('every nav entry hidden on phones points at a page that turns phones away', () => {
  const missing = [];
  for (const href of hiddenNavTargets()) {
    // Only same-page targets can carry a gate; a fragment into another page is that
    // page's problem, and there are none today.
    if (!fs.existsSync(path.join(PUBLIC, href))) { missing.push(`${href} (no such page)`); continue; }
    const gate = gateOf(href);
    if (!gate) { missing.push(`${href} (loads no gate in <head>)`); continue; }

    const src = fs.readFileSync(path.join(SCRIPTS, gate), 'utf8');
    if (!/matchMedia/.test(src) || !/location\.replace/.test(src)) {
      missing.push(`${href} → ${gate} (does not redirect on a viewport check)`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a nav entry is hidden below the mobile breakpoint but its page still loads on a phone. ' +
      'Hiding the link is not a gate — the URL, a bookmark and a restored tab all bypass it:\n' +
      missing.join('\n'),
  );
});

test('DRIFT GUARD: every gate redirects at exactly the width the nav hides links at', () => {
  const breakpoint = cssBreakpoint();

  const wrong = [];
  for (const file of fs.readdirSync(SCRIPTS).filter((f) => /-gate\.js$/.test(f))) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    // Not every gate is a viewport gate — masking-studio-gate.js is a plan gate and
    // asks no media query at all. Only the ones that do are held to the number.
    const m = /\(max-width:\s*(\d+)px\)/.exec(src);
    if (!m) continue;
    if (Number(m[1]) !== breakpoint) wrong.push(`${file} redirects at ${m[1]}px`);
  }

  assert.deepEqual(
    wrong,
    [],
    `styles.css hides .desktop-only at ${breakpoint}px, so every viewport gate must use the ` +
      'same number. Otherwise there is a band of widths where the link is hidden but the page ' +
      'loads, or the reverse:\n' + wrong.join('\n'),
  );
});

test('DRIFT GUARD: the pre-paint Gallery reveal re-hides at that same width', () => {
  // The third copy of the number, and the least obvious. `.hidden` is
  // `display:none!important`, so showing the tab before paint (session-class.js) needs an
  // !important rule with more specificity — which then also outranks `.desktop-only` and
  // would put the tab back on phones for every signed-in visitor. The stylesheet therefore
  // re-hides it inside its own media query, and if that number drifts from the one above
  // there is a band of widths where a phone is offered a tab whose page redirects it away.
  const breakpoint = cssBreakpoint();
  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'styles.css'), 'utf8').replace(/\s+/g, '');

  const m = /@media\(max-width:(\d+)px\)\{html\.has-session[^{]*\[data-nav-gallery\]\{display:none!important\}/.exec(css);
  assert.ok(
    m,
    'the pre-paint Gallery reveal no longer re-hides itself below a breakpoint. Either the ' +
      'reveal rule is gone (fine — delete this guard) or a signed-in phone visitor now sees ' +
      'a tab that gallery-gate.js answers by redirecting them home.',
  );
  assert.equal(
    Number(m[1]),
    breakpoint,
    `styles.css hides .desktop-only at ${breakpoint}px, so the pre-paint reveal must give the tab back at the same width`,
  );
});

test('a gate for a LOCALIZED page keeps the visitor in their language', () => {
  // ai-designer.html is in LOCALIZED_PAGES, so its gate carries the inlined
  // localeTarget() copy (behaviourally tested in test/i18n/locale-data.test.js).
  // gallery.html is not — it is behind auth and noindex — so its gate deliberately
  // does NOT, and saying so here is what stops that omission from being read as a
  // bug and "fixed" with a third copy of the prefix list.
  //
  // The failure this catches is the other direction: adding a page to LOCALIZED_PAGES
  // without upgrading its gate, which silently drops a French visitor on the English
  // root every time the gate fires.
  const localized = new Set(LOCALIZED_PAGES.map((p) => p.file));
  assert.ok(localized.has('ai-designer.html'), 'sanity: the AI Designer is a localized page');
  assert.ok(!localized.has('gallery.html'), 'sanity: the gallery is not');

  const wrong = [];
  for (const href of hiddenNavTargets()) {
    const gate = gateOf(href);
    if (!gate) continue;
    const hasLocaleTarget = /function localeTarget/.test(fs.readFileSync(path.join(SCRIPTS, gate), 'utf8'));
    if (localized.has(href) !== hasLocaleTarget) {
      wrong.push(
        localized.has(href)
          ? `${href} is a localized page but ${gate} has no localeTarget() — it will bounce non-English visitors to the English root`
          : `${href} is not localized, so ${gate} does not need localeTarget()`,
      );
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});
