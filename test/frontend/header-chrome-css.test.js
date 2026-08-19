// Tier: drift guard (static analysis of public/*.html + public/styles/).
//
// THE INVARIANT
// A selector needed to paint always-visible header chrome must be defined in a sheet the
// page loads render-blocking — never in one it lazy-loads.
//
// WHAT THIS COVERS
// Thirteen of the fifteen nav-bearing pages ship their non-critical CSS as
// `<link rel="stylesheet" href="styles/auth.css" media="print" data-lazy-css>` and let
// scripts/lazy-css.js promote it to media="all" once it arrives. That is right for the
// things auth.css mostly holds — the sign-in modal, the account dropdown — because none
// of them generate a box until someone clicks.
//
// The account BUTTON was in there too, and it is painted in the very first frame on every
// one of those pages. No render-blocking sheet carries a `button {}` reset, so it had not
// merely the wrong geometry but NO authored CSS at all: it rendered as a bare UA button
// (grey ButtonFace, 2px outset border, square corners, ~26px) with a BLACK icon — the
// inline SVG is stroke="currentColor", which inherits ButtonText — and then snapped to a
// 42px gradient circle with a white icon when the sheet swapped in, reflowing the nav.
// 404.html and plus-welcome.html load auth.css eagerly and never flashed, which is what
// confirmed the diagnosis. The rules now live in styles.css beside .nav-actions; this is
// the part that keeps them there.
//
// It is the fourth instance of one mistake. `body.page-home .hero`, `.nav .nav-center`
// and `.nav .nav-trailing` were each moved out of auth.css for the same reason, and
// auth.css even ends a comment with "Do not add hero or nav geometry to this file" — a
// note that could not enforce itself.
//
// DELIBERATELY NOT GUARDED
// `.profile-menu-dropdown` and its children stay lazy on purpose. `.hidden` is
// `display:none!important` in styles.css (render-blocking), so the panel generates no box
// until the button is clicked and there is nothing to flash. Deferring it is the entire
// point of the split — a guard that demanded the whole dropdown be render-blocking would
// undo commit 66a9cc2 ("Stop making every page pay for work it never uses").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allHtmlPages, maskComments } from '../helpers/nav-pages.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLES = path.join(ROOT, 'public', 'styles');

/** The markup that means "this page paints the account button". */
const BUTTON_MARKER = 'id="profile-menu-btn"';

/**
 * Selectors that must resolve from a render-blocking sheet, each with the reason —
 * `head-scripts.test.js`'s BLOCKING_ALLOWED shape, for the same purpose: the next person
 * to touch this needs to know what breaks, not just that something does.
 *
 * Small and hand-curated on purpose. A heuristic ("everything inside <header>") would
 * sweep in the dropdown and the auth modal, which are correctly lazy.
 */
const FIRST_PAINT = {
  '.nav-trailing': "the header grid's third cell — its box exists in the first frame",
  '.profile-menu-wrap': "the account button's box, and the dropdown's positioning anchor",
  '.profile-menu-btn':
    'always visible, never hidden, no avatar swap. Without it the control paints as a bare UA button — grey ButtonFace, 2px outset border, square, ~26px, black icon — then snaps to a 42px gradient circle and shifts the nav row ~16px',
  '.profile-menu-btn__icon': 'sizes the inline person SVG; a lazy copy resizes the icon a beat after the button',
  'a.brand':
    'the wordmark is an <a>, and this is the ONLY text-decoration:none that reaches it — there is no global a{} rule in styles.css — so a lazy copy paints the logo UNDERLINED and then un-underlines it',
};

/**
 * Blank out CSS comment bodies, preserving length.
 *
 * Not optional: the sheets explain themselves at length and both auth.css and styles.css
 * now NAME `.profile-menu-btn` in prose describing this very move. A raw substring scan
 * reads those sentences as rule definitions and the guard passes on the strength of its
 * own documentation. (test/helpers/strip-js-comments.js is the wrong tool here — it also
 * strips `//`, which eats the rest of any line containing a protocol-relative url().)
 * @param {string} css
 * @returns {string}
 */
function maskCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

/**
 * Every selector a sheet defines, whitespace-normalized.
 *
 * A substring scan is not good enough, and the mutation run proved it: `.hidden` was
 * satisfied by `.modal.hidden` in the `display:none` group rule, so renaming the real
 * `.hidden` left the dropdown assertion green. Compound and descendant selectors have to
 * be told apart from the thing they contain, which needs the selector LIST, not the text.
 *
 * `[^{}]+` cannot cross a brace, so an inner rule inside `@media (…) { … }` yields just
 * its own selector — which is what this wants: both halves of a media-split rule must be
 * eager, and neither is allowed to stand in for the other.
 * @param {string} css comment-masked source
 * @returns {Set<string>}
 */
function definedSelectors(css) {
  const out = new Set();
  for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const raw of rule[1].split(',')) {
      const sel = raw.trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      out.add(sel);
      // Also index the selector with its pseudo-classes removed, so `.profile-menu-btn`
      // is credited by `.profile-menu-btn:hover` — a rule ON the element — while
      // `.nav .nav-trailing` still never counts as defining `.nav-trailing`.
      const bare = sel.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').trim();
      if (bare) out.add(bare);
    }
  }
  return out;
}

/** Sheet filename -> the selectors it defines. Read and parsed once. */
const sheetSelectors = new Map(
  fs
    .readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .map((f) => [f, definedSelectors(maskCssComments(fs.readFileSync(path.join(STYLES, f), 'utf8')))]),
);

/**
 * The stylesheets a page links, split by whether they block the first paint.
 *
 * The <noscript> block is dropped BEFORE anything else. Every page duplicates its lazy
 * sheets in there as plain eager <link>s (that fallback is the only thing that loads them
 * with JS off), so counting them would make this guard pass on exactly the pages it
 * exists to catch — the single most likely way to write this test wrong.
 * @param {string} html
 * @returns {{ eager: string[], lazy: string[] }}
 */
function sheetsOf(html) {
  const head = maskComments(html).replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const eager = [];
  const lazy = [];
  for (const m of head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)) {
    const tag = m[0];
    const href = tag.match(/href="[^"]*?styles\/([a-z0-9-]+\.css)"/);
    if (!href) continue;
    (/\bdata-lazy-css\b/.test(tag) || /media="print"/.test(tag) ? lazy : eager).push(href[1]);
  }
  return { eager, lazy };
}

const buttonPages = allHtmlPages().filter((p) => p.html.includes(BUTTON_MARKER));

test('the page sweep found the account button (guard against a vacuous pass)', () => {
  assert.ok(
    buttonPages.length >= 14,
    `expected the nav-bearing pages to carry ${BUTTON_MARKER}, found ${buttonPages.length}`,
  );
});

test('the eager/lazy split is real, so this guard is able to fail', () => {
  // Without this, the whole file would keep passing if someone "fixed" a future flash by
  // making every sheet render-blocking — which is a perf regression, not a fix. The point
  // is that auth.css stays lazy AND the button no longer depends on it.
  const index = buttonPages.find((p) => p.name === 'index.html');
  assert.ok(index, 'index.html carries the account button');
  const { eager, lazy } = sheetsOf(index.html);
  assert.ok(lazy.includes('auth.css'), `index.html should still lazy-load auth.css, got lazy=[${lazy}]`);
  assert.ok(eager.includes('styles.css'), `index.html should load styles.css render-blocking, got eager=[${eager}]`);
});

test('every sheet a page links actually exists', () => {
  // A typo'd href would otherwise read as "that selector is not in any eager sheet" and
  // send the next person looking in the wrong file.
  const missing = [];
  for (const { name, html } of buttonPages) {
    const { eager, lazy } = sheetsOf(html);
    for (const sheet of [...eager, ...lazy]) {
      if (!sheetSelectors.has(sheet)) missing.push(`${name} -> styles/${sheet}`);
    }
  }
  assert.deepEqual(missing, [], `linked stylesheet not found on disk:\n${missing.join('\n')}`);
});

test('always-visible header chrome is styled by a render-blocking sheet on every page', () => {
  const offenders = [];
  for (const { name, html } of buttonPages) {
    const { eager } = sheetsOf(html);
    for (const [selector, why] of Object.entries(FIRST_PAINT)) {
      if (eager.some((s) => sheetSelectors.get(s)?.has(selector))) continue;
      offenders.push(`${name}: ${selector} is in no render-blocking sheet — ${why}`);
    }
  }
  assert.deepEqual(offenders, [], `header chrome that flashes on first paint:\n${offenders.join('\n')}`);
});

test('none of it is ALSO left behind in a lazy sheet', () => {
  // This is the half that encodes "move, not copy". styles.css loads before auth.css on
  // every page, so a leftover duplicate wins the cascade the moment the sheet swaps in:
  // the flash comes back while the test above still passes, and the two copies then drift
  // apart silently because nothing compares them.
  const offenders = [];
  for (const { name, html } of buttonPages) {
    const { lazy } = sheetsOf(html);
    for (const selector of Object.keys(FIRST_PAINT)) {
      for (const sheet of lazy) {
        if (sheetSelectors.get(sheet)?.has(selector)) {
          offenders.push(`${name}: ${selector} is still defined in ${sheet}, which this page lazy-loads`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `duplicate left in a lazy sheet — it wins the cascade:\n${offenders.join('\n')}`);
});

test("the dropdown's exemption is proved, not assumed", () => {
  // .profile-menu-dropdown is allowed to stay lazy for exactly one reason: it ships with
  // the `hidden` class and `.hidden` is display:none in a render-blocking sheet, so it
  // generates no box before auth.css lands. Both halves are load-bearing, and there is a
  // DUPLICATE `.hidden` in auth.css — so if someone ever "de-duplicates" by keeping the
  // auth.css copy, the dropdown starts flashing open on load and this is the only test
  // that would notice.
  const problems = [];
  for (const { name, html } of buttonPages) {
    const tag = maskComments(html).match(/<div\b[^>]*id="profile-menu-dropdown"[^>]*>/);
    if (!tag) {
      problems.push(`${name}: no #profile-menu-dropdown element found`);
      continue;
    }
    if (!/class="[^"]*\bhidden\b[^"]*"/.test(tag[0])) {
      problems.push(`${name}: #profile-menu-dropdown no longer ships with the \`hidden\` class`);
    }
    const { eager } = sheetsOf(html);
    if (!eager.some((s) => sheetSelectors.get(s)?.has('.hidden'))) {
      problems.push(`${name}: .hidden is not defined in a render-blocking sheet`);
    }
  }
  assert.deepEqual(problems, [], `the dropdown can now paint before its sheet lands:\n${problems.join('\n')}`);
});
