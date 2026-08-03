// Tier: drift guard (static analysis of public/styles/styles.css) — the sticky
// header's frosted glass.
//
// WHAT THIS COVERS
// `.site-header` is `position:sticky` and hosts two dropdowns that hang well outside
// it: the Staging panel (135px tall, 134px of it below the header) and
// #profile-menu-dropdown. An element with `backdrop-filter` becomes a backdrop root,
// and WebKit rasterizes that subtree into a layer bounded by the element's own box —
// so a descendant hanging outside the box is clipped away. On an iPhone the Staging
// panel came up visibly sliced and then vanished once the compositor rasterized the
// blur layer.
//
// The fix keeps the design and moves the filter onto a CHILDLESS pseudo-element, so
// the header stops being a backdrop root. This guard pins both halves of that: the
// header must not take the filter back, and the pseudo-element must keep it (or the
// frosted look is silently lost and the "fix" reads as a deletion).
//
// WHY A STATIC GUARD AND NOT A BROWSER TEST
// Nothing available here can reproduce the bug: Chromium does not have it, and
// Playwright's WebKit build has no iOS tile compositor. 6 pages x 4 widths x 2 engines
// of emulation all render the panel perfectly, so a green e2e run proves nothing about
// this. The CSS shape is the only thing that can be checked, so it is what is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHEET = path.join(ROOT, 'public', 'styles', 'styles.css');

/**
 * Declaration blocks for an exact selector, comment-stripped.
 *
 * Stripping is not optional here: the fix's own comment explains the rule using the
 * words `backdrop-filter` and `.site-header`, so a scan of the raw text passes with
 * the declaration DELETED — the guard would be measuring its own prose. Mutation
 * 3 below is that exact case.
 *
 * @param {string} selector
 * @returns {string[]}
 */
function blocksFor(selector) {
  const src = fs.readFileSync(SHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  // Innermost rules only, which is what this matches: a selector run cannot cross a
  // brace, so `@media (...) { .x { … } }` yields the `.x` rule rather than the wrapper.
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

const hasBackdrop = (block) => /(^|[;\s])(-webkit-)?backdrop-filter\s*:/.test(block);

test('.site-header itself never carries backdrop-filter', () => {
  const blocks = blocksFor('.site-header');
  assert.ok(blocks.length > 0, 'no `.site-header` rule found — this guard has gone blind');

  const offenders = blocks.filter(hasBackdrop);
  assert.deepEqual(
    offenders,
    [],
    'backdrop-filter is back on .site-header. It makes the header a backdrop root, which '
      + 'clips the Staging panel and the profile dropdown — both hang outside it. On iPhone '
      + 'the panel renders sliced and then disappears. Put it on .site-header::before instead.',
  );
});

test('.site-header::before still carries it, so the frosted glass survives', () => {
  const blocks = blocksFor('.site-header::before');
  assert.equal(blocks.length, 1, 'expected exactly one `.site-header::before` rule');
  assert.ok(
    hasBackdrop(blocks[0]),
    'the header lost its blur entirely. The guard above is satisfied by DELETING the '
      + 'frosted background, so this half exists to make that fail too.',
  );
  // Unprefixed alone does not reach older iOS, which is the platform this whole fix is
  // about, so both spellings are required.
  assert.ok(/-webkit-backdrop-filter\s*:/.test(blocks[0]), 'missing the -webkit- prefix');
  assert.ok(/[^-]backdrop-filter\s*:/.test(blocks[0]), 'missing the unprefixed property');
  // It must stay childless-and-behind, or it stops being a safe place to put the filter.
  assert.ok(/z-index\s*:\s*-1/.test(blocks[0]), 'the pseudo must sit behind the nav content');
});
