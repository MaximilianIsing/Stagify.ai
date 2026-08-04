// Tier: drift guard (static analysis of public/*.html + public/styles/styles.css) —
// the phone backdrop.
//
// WHAT THIS COVERS
// background.mp4 is 1.25 MB, so every page gates it behind
// `media="(min-width: 769px)"`. A <source> whose media query does not match is never
// selected: networkState settles at NETWORK_NO_SOURCE and the element can never play.
// Both WebKit and Blink draw a centred play glyph over a <video> in that state, and it
// landed right in the middle of the phone homepage.
//
// That glyph is NOT part of the media-controls shadow tree, so the pile of
// ::-webkit-media-controls-* `display:none` rules in styles.css does not reach it — a
// fact worth pinning, because those rules look like they already handle this and invite
// the next person to "fix" it by adding one more pseudo-element. The only reliable
// removal is to stop rendering a <video> under 769px and paint the poster in CSS
// instead, which is what this guard holds in place, both halves:
//   1. the element is hidden on phones (or the glyph returns), and
//   2. a fixed backdrop replaces it (or the page goes flat #b2c4f6 and the "fix" reads
//      as a deletion of the background).
//
// WHY A STATIC GUARD AND NOT A BROWSER TEST
// The glyph is drawn by the UA's own media placeholder. Chromium headless does not
// paint it, and Playwright's WebKit build does not paint iOS's, so a green e2e proves
// nothing — same reason site-header-backdrop.test.js is static. The CSS shape is the
// only checkable thing, so it is what is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SHEET = path.join(PUBLIC, 'styles', 'styles.css');

/** @returns {string} styles.css with every comment removed. */
function sheetSource() {
  return fs.readFileSync(SHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Body of the no-playable-source block, comment-stripped.
 *
 * The query is `not all and (min-width:769px)`, the exact logical complement of the
 * <source> gate, deliberately NOT `max-width:768px`: the two must agree at every width,
 * including the fractional 768–769px band a zoomed desktop window can land in, where a
 * max-width:768px rule would leave the video rendered with no source to play.
 *
 * Comment-stripping is not optional. The fix's own comment spells out
 * `#background-video`, `display:none` and `background-poster.webp` in prose, so a scan
 * of the raw text passes with every declaration DELETED — the guard would be reading its
 * own explanation. Brace-counted rather than regexed so nested rules cannot end it early.
 *
 * @returns {string}
 */
function mobileBlock() {
  const src = sheetSource();
  const start = src.search(/@media\s+not\s+all\s+and\s*\(\s*min-width\s*:\s*769px\s*\)\s*\{/);
  assert.notEqual(
    start,
    -1,
    'no `@media not all and (min-width:769px)` block. It must stay the exact negation of '
      + 'the <source> media gate, so the video is never rendered at a width where it has '
      + 'nothing to play — that mismatch is what paints the UA play glyph.',
  );
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in styles.css');
}

/**
 * Declaration blocks for an exact selector within some CSS source.
 *
 * @param {string} src
 * @param {string} selector
 * @returns {string[]}
 */
function blocksFor(src, selector) {
  const out = [];
  // A selector run cannot cross a brace, so this yields innermost rules only.
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

/** @returns {string[]} public/*.html filenames carrying #background-video. */
function pagesWithVideo() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').includes('id="background-video"'));
}

test('every background video keeps its 769px source gate', () => {
  const pages = pagesWithVideo();
  assert.ok(pages.length >= 10, `expected the video on 10+ pages, found ${pages.length}`);

  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const tag = html.slice(html.indexOf('<video id="background-video"'));
    const source = tag.slice(0, tag.indexOf('</video>'));
    assert.match(
      source,
      /<source[^>]*\bmedia\s*=\s*"\(min-width:\s*769px\)"/,
      `${page}: the <source> lost its media gate, so phones fetch 1.25 MB of decorative `
        + 'video again — ~6s of the mobile LCP budget at PageSpeed\'s 200 KB/s.',
    );
  }
});

test('#background-video is not rendered on phones', () => {
  const blocks = blocksFor(mobileBlock(), '#background-video');
  assert.equal(blocks.length, 1, 'expected exactly one phone `#background-video` rule');
  assert.match(
    blocks[0],
    /(^|[;\s])display\s*:\s*none/,
    'the phone <video> is being rendered again. It can never play there (its only '
      + '<source> is gated at 769px), and the UA paints a centred play glyph over a video '
      + 'it cannot start — that glyph is what this rule exists to remove. Note the '
      + '::-webkit-media-controls-* rules do NOT cover it; the placeholder is outside the '
      + 'controls shadow tree.',
  );
});

test('the phone backdrop replaces it, so the page is not left flat', () => {
  const blocks = blocksFor(mobileBlock(), 'body:has(#background-video)::before');
  assert.equal(
    blocks.length,
    1,
    'the replacement backdrop is gone. The guard above is satisfied by simply DELETING '
      + 'the background, so this half exists to make that fail too.',
  );
  const rule = blocks[0];

  // Stylesheet-relative, which is the point: the SSR locale pages render at /es/... and
  // a page-relative URL would resolve against the wrong directory there.
  assert.match(
    rule,
    /url\(\s*"\.\.\/media-webp\/background-poster\.webp"\s*\)/,
    'the backdrop lost the poster image',
  );
  assert.ok(
    fs.existsSync(path.join(PUBLIC, 'media-webp', 'background-poster.webp')),
    'the poster file the backdrop points at does not exist',
  );

  // Reproduces the desktop layer exactly; drift in any of these is a visible change.
  assert.match(rule, /position\s*:\s*fixed/, 'backdrop must be fixed, like the video it replaces');
  assert.match(rule, /z-index\s*:\s*-1/, 'backdrop must sit behind page content');
  assert.match(rule, /opacity\s*:\s*\.?0?\.?8/, 'backdrop must keep the video layer\'s .8 opacity');
  assert.match(rule, /cover/, 'backdrop must cover, matching the video\'s object-fit:cover');
});

test('the scoping page really is the only styles.css page without the video', () => {
  // body:has(#background-video) is narrower than body on purpose. If another page ever
  // drops the <video> while keeping styles.css, that page silently loses its background
  // — this pins the assumption rather than leaving it implicit in a comment.
  const bare = fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => {
      const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
      return html.includes('styles/styles.css') && !html.includes('id="background-video"');
    });
  assert.deepEqual(
    bare,
    ['reset-password.html'],
    'the set of styles.css pages without a background video changed. Each new one gets '
      + 'no backdrop at all on phones — confirm that is intended, then update this list.',
  );
});
