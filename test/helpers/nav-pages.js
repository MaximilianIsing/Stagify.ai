// Discovery + extraction for the baked site chrome — the header (shared by
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
import { HEADER_OPEN, elementEnd, maskComments } from '../../lib/site/chrome.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

// The comment masking and depth matching live in lib/site/chrome.js, which bakes this
// chrome into the pages; the guards reuse them so there is one copy of the parsing.
export { HEADER_OPEN, maskComments };

/**
 * @param {string} html
 * @param {string} masked
 * @param {number} start
 * @param {string} tagName
 * @returns {string | null}
 */
function extractByDepth(html, masked, start, tagName) {
  const end = elementEnd(masked, start, tagName);
  return end === null ? null : html.slice(start, end);
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
 * Identified by CONTENT, not by class, so a page that copied the footer by hand under
 * some other class is still found and fails the bake guard. Pages whose
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
 * Every `.html` under `public/`, recursively, CRLF normalized — the top-level pages plus the
 * ones in subfolders (`blog/`, `legal/`) whose footers are their own shapes.
 *
 * `publicPages()` stops at the top level on purpose (the header/footer parity guards
 * compare the shared chrome, which only exists there). Use this one for checks that must
 * cover every served page, since a copied-from blog article is a likely drift source.
 * @returns {{ name: string, html: string }[]}
 */
export function allHtmlPages() {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith('.html') ? [p] : [];
    });
  return walk(PUBLIC).map((file) => ({
    name: path.relative(PUBLIC, file).replace(/\\/g, '/'),
    html: fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
  }));
}

/**
 * Every `public/*.html` that actually carries nav links.
 * @returns {{ name: string, html: string }[]}
 */
export function navPages() {
  return publicPages().filter((p) => p.html.includes(HEADER_OPEN) && p.html.includes('class="nav-link'));
}
