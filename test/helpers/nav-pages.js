// Discovery + extraction for the hand-copied site header, shared by the markup drift
// guards (test/frontend/staging-menu.test.js, test/frontend/site-header-parity.test.js).
//
// It lives here rather than in each spec because the two guards must agree on WHICH
// pages carry the nav. If one of them drifted to a narrower list, it would keep passing
// while quietly checking fewer files — the exact failure mode these guards exist to
// prevent, reintroduced in the guards themselves.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/** The opening tag every nav-bearing page starts its header with. */
export const HEADER_OPEN = '<header class="site-header">';

/**
 * Blank out HTML comment BODIES while preserving their length, so offsets computed
 * against the masked copy still index the original exactly.
 *
 * This is not a nicety. `public/gallery.html` carries a comment that QUOTES the string
 * `<header class="site-header">` verbatim (explaining why its id sits on the <nav>
 * instead). Depth-counting `<header>` over the raw source reads that quotation as a
 * second opening tag, never returns to depth 0, and silently extracts nothing — the
 * page then drops out of the comparison and the guard passes over nine files while
 * reporting ten.
 * @param {string} html
 * @returns {string}
 */
export function maskComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

/**
 * The full `<header class="site-header">…</header>` block, matched by tag depth.
 *
 * Depth counting rather than a lazy `[\s\S]*?</header>` regex, because guides.html,
 * enterprise.html and stagify-plus.html all contain LATER nested <header> elements
 * (`guides-trouble-card__head`, `ent-hero`, `sp-hero`) — a lazy match stops at the
 * first close it sees and a greedy one runs past into the page body.
 * @param {string} html
 * @returns {string | null} null when the page has no site header.
 */
export function extractSiteHeader(html) {
  const masked = maskComments(html);
  const start = masked.indexOf(HEADER_OPEN);
  if (start === -1) return null;
  const tag = /<header\b|<\/header>/g;
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(masked))) {
    depth += m[0] === '</header>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null; // unbalanced — caller asserts on this rather than comparing a truncation
}

/**
 * Every `public/*.html` that actually carries nav links, with CRLF normalized so a
 * checkout's line endings can never be mistaken for markup drift.
 * @returns {{ name: string, html: string }[]}
 */
export function navPages() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .map((name) => ({ name, html: fs.readFileSync(path.join(PUBLIC, name), 'utf8').replace(/\r\n/g, '\n') }))
    .filter((p) => p.html.includes(HEADER_OPEN) && p.html.includes('class="nav-link'));
}
