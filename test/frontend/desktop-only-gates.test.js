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

/** Every `<a … class="… desktop-only …" href="X">` in the shared site header, by href. */
function hiddenNavTargets() {
  /** @type {Set<string>} */
  const targets = new Set();
  for (const name of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    if (!html.includes('<header class="site-header">')) continue;
    for (const tag of html.match(/<a\b[^>]*\bdesktop-only\b[^>]*>/g) || []) {
      const href = /\bhref="([^"]+)"/.exec(tag);
      if (href) targets.add(href[1].split('#')[0]);
    }
  }
  return targets;
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
