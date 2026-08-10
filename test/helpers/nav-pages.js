// Discovery + extraction for the hand-copied site chrome — the header (shared by
// test/frontend/staging-menu.test.js and test/frontend/site-header-parity.test.js) and
// the footer (test/frontend/site-footer-parity.test.js).
//
// It lives here rather than in each spec because the guards must agree on WHICH pages
// carry each block. If one of them drifted to a narrower list, it would keep passing
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
 * The full element beginning at `start`, matched by tag depth over a comment-masked copy.
 *
 * Depth counting rather than a lazy `[\s\S]*?</tag>` regex, because guides.html,
 * enterprise.html and stagify-plus.html all contain LATER nested <header> elements
 * (`guides-trouble-card__head`, `ent-hero`, `sp-hero`) — a lazy match stops at the
 * first close it sees and a greedy one runs past into the page body.
 * @param {string} html raw source; the returned slice indexes THIS string
 * @param {string} masked comment-masked copy of `html`, same length
 * @param {number} start offset of the opening tag
 * @param {string} tagName e.g. 'header'
 * @returns {string | null} null when the element never closes
 */
function extractByDepth(html, masked, start, tagName) {
  const tag = new RegExp(`<${tagName}\\b|</${tagName}>`, 'g');
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(masked))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null; // unbalanced — caller asserts on this rather than comparing a truncation
}

/**
 * The full `<header class="site-header">…</header>` block, matched by tag depth.
 * @param {string} html
 * @returns {string | null} null when the page has no site header.
 */
export function extractSiteHeader(html) {
  const masked = maskComments(html);
  const start = masked.indexOf(HEADER_OPEN);
  if (start === -1) return null;
  return extractByDepth(html, masked, start, 'header');
}

/**
 * The page's *site* footer — the shared marketing block linking Privacy / Terms / Status.
 *
 * Identified by CONTENT, not by class: the same block ships as an inline-styled
 * `<footer style="…">` on five pages and as `<footer class="ent-site-footer">` on
 * enterprise.html, and matching on either would silently miss the other. Pages whose
 * footer is a different thing entirely (listing-share's `.sh-footer`, the legal pages,
 * the blog's `.blog-footer`) contain no such link pair and return null.
 * @param {string} html
 * @returns {string | null}
 */
export function extractSiteFooter(html) {
  const masked = maskComments(html);
  const open = /<footer\b/g;
  let m;
  while ((m = open.exec(masked))) {
    const block = extractByDepth(html, masked, m.index, 'footer');
    if (block === null) continue;
    if (block.includes('href="privacy.html"') && block.includes('href="/status"')) return block;
  }
  return null;
}

/**
 * Every `public/*.html` carrying the shared site footer, CRLF normalized.
 * @returns {{ name: string, html: string }[]}
 */
export function footerPages() {
  return publicPages().filter((p) => extractSiteFooter(p.html) !== null);
}

/**
 * Every top-level `public/*.html`, with CRLF normalized so a checkout's line endings
 * can never be mistaken for markup drift.
 * @returns {{ name: string, html: string }[]}
 */
export function publicPages() {
  return fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .map((name) => ({ name, html: fs.readFileSync(path.join(PUBLIC, name), 'utf8').replace(/\r\n/g, '\n') }));
}

/**
 * Every `public/*.html` that actually carries nav links.
 * @returns {{ name: string, html: string }[]}
 */
export function navPages() {
  return publicPages().filter((p) => p.html.includes(HEADER_OPEN) && p.html.includes('class="nav-link'));
}
