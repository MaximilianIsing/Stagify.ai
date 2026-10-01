// Single source of truth for the SITE CHROME: the `<header class="site-header">` nav and
// the shared footer (Legal · About · Status · API · ©) that the marketing and tool pages
// carry.
//
// WHY BAKED, NOT INCLUDED
// lib/i18n/render-page.js is a pure string transform over the static English HTML: it
// translates data-lang attributes and locale-prefixes relative hrefs in the literal
// markup. A header or footer injected by client-side JS would never pass through it, so
// /es, /fr/guides.html … would ship English chrome to crawlers and no-JS clients. The
// markup therefore has to sit literally in every page. Instead of being hand-copied, it
// is written into each page by scripts/build-i18n-seo.js between generated markers.
//
// EDIT THE CHROME in lib/site/partials/site-header.html and site-footer.html, then rerun
// `node scripts/build-i18n-seo.js`. test/frontend/site-header-parity.test.js and
// site-footer-parity.test.js fail the build when a page's baked copy is stale.
//
// The partials are plain HTML on purpose, so they stay readable and diffable. The
// per-page variants are applied here, in code, rather than with placeholders in them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARTIALS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'partials');

export const HEADER_BEGIN = '<!-- BEGIN SITE HEADER (generated: edit lib/site/partials/site-header.html, then run node scripts/build-i18n-seo.js) -->';
export const HEADER_END = '<!-- END SITE HEADER -->';
export const FOOTER_BEGIN = '<!-- BEGIN SITE FOOTER (generated: edit lib/site/partials/site-footer.html, then run node scripts/build-i18n-seo.js) -->';
export const FOOTER_END = '<!-- END SITE FOOTER -->';

/** The opening tag every nav-bearing page starts its header with. Other guards match it literally. */
export const HEADER_OPEN = '<header class="site-header">';

/** The canonical nav opening tag, the hook for the `navId` variant. */
const NAV_OPEN = '<nav class="nav">';

/**
 * @typedef {object} HeaderOptions
 * @property {string} [navId] id for the <nav>. gallery-app.js marks `#gal-nav` inert while
 *   its detail panel is open. On the <nav>, never on the <header>: other guards match
 *   HEADER_OPEN byte for byte.
 * @property {boolean} [trailing] false empties `.nav-trailing`. The marketing pages with
 *   their own hero headline directly below the nav drop the mobile mini-headline, which
 *   would duplicate it on the viewport where space is tightest.
 */

/**
 * @typedef {object} ChromePage
 * @property {string} file path under public/
 * @property {HeaderOptions} [header] present when the page carries the site header
 * @property {boolean} [footer] true when the page carries the site footer
 */

/**
 * Every page carrying the chrome, and its variants. A new page that copies the header or
 * footer without being listed here fails site-header-parity / site-footer-parity.
 * @type {readonly ChromePage[]}
 */
export const CHROME_PAGES = Object.freeze([
  { file: '404.html', header: {}, footer: true },
  { file: 'about.html', header: {}, footer: true },
  { file: 'ai-designer.html', header: {} },
  { file: 'api-keys.html', header: {}, footer: true },
  { file: 'basic-mask.html', header: {} },
  { file: 'contact.html', header: {}, footer: true },
  { file: 'developers.html', header: {}, footer: true },
  { file: 'enterprise.html', header: { trailing: false }, footer: true },
  { file: 'exterior-studio.html', header: {} },
  { file: 'gallery.html', header: { navId: 'gal-nav' } },
  { file: 'guides.html', header: {}, footer: true },
  { file: 'index.html', header: {}, footer: true },
  { file: 'masking-studio.html', header: {} },
  { file: 'plus-welcome.html', header: { trailing: false }, footer: true },
  { file: 'stagify-plus.html', header: { trailing: false }, footer: true },
  { file: 'status.html', header: {}, footer: true },
]);

/** @param {string} name @returns {string} the partial, LF-normalized, no trailing newline */
function readPartial(name) {
  return fs.readFileSync(path.join(PARTIALS, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/**
 * Blank out HTML comment BODIES while preserving their length, so offsets computed
 * against the masked copy still index the original exactly. gallery.html carries a
 * comment that quotes HEADER_OPEN verbatim, which naive depth counting reads as a
 * second opening tag.
 * @param {string} html
 * @returns {string}
 */
export function maskComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

/**
 * Offsets of the full element beginning at `start`, matched by tag depth over a
 * comment-masked copy. Depth counting rather than a lazy regex, because several pages
 * nest LATER <header> elements (guides, enterprise, stagify-plus heroes).
 * @param {string} masked comment-masked html
 * @param {number} start offset of the opening tag
 * @param {string} tagName e.g. 'header'
 * @returns {number | null} offset just past the closing tag, or null when it never closes
 */
export function elementEnd(masked, start, tagName) {
  const tag = new RegExp(`<${tagName}\\b|</${tagName}>`, 'g');
  tag.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tag.exec(masked))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return null;
}

/**
 * Indent every non-empty line of an LF block.
 * @param {string} block
 * @param {string} indent
 * @returns {string}
 */
function indentBlock(block, indent) {
  return block
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n');
}

/**
 * The site header markup, unindented and LF, with the page's variants applied.
 * @param {HeaderOptions} [opts]
 * @returns {string}
 */
export function renderSiteHeader(opts = {}) {
  let html = readPartial('site-header.html');
  if (!html.startsWith(HEADER_OPEN) || !html.includes(NAV_OPEN)) {
    throw new Error(`site-header.html must start with ${HEADER_OPEN} and contain ${NAV_OPEN}`);
  }
  if (opts.navId) html = html.replace(NAV_OPEN, `<nav class="nav" id="${opts.navId}">`);
  if (opts.trailing === false) {
    const masked = maskComments(html);
    const start = masked.indexOf('<div class="nav-trailing">');
    const end = start === -1 ? null : elementEnd(masked, start, 'div');
    if (end === null) throw new Error('site-header.html has no balanced .nav-trailing block');
    html = `${html.slice(0, start)}<div class="nav-trailing"></div>${html.slice(end)}`;
  }
  return html;
}

/**
 * The site footer markup, unindented and LF.
 * @returns {string}
 */
export function renderSiteFooter() {
  return readPartial('site-footer.html');
}

/**
 * A marker-wrapped block at `indent`, in LF.
 * @param {string} begin
 * @param {string} body
 * @param {string} end
 * @param {string} indent
 * @returns {string}
 */
function wrap(begin, body, end, indent) {
  return `${indent}${begin}\n${indentBlock(body, indent)}\n${indent}${end}`;
}

/**
 * Locate the region to replace: the existing marker block if there is one, else (first
 * run) the bare element found by depth over a comment-masked copy.
 * @param {string} html
 * @param {string} begin
 * @param {string} end
 * @param {(html: string, masked: string) => number} findOpen offset of the bare element's opening tag, or -1
 * @param {string} tagName
 * @param {string} label for errors
 * @returns {{ from: number, to: number, indent: string }} `from` is the start of the line
 */
function locate(html, begin, end, findOpen, tagName, label) {
  let from;
  let to;
  const b = html.indexOf(begin);
  if (b !== -1) {
    const e = html.indexOf(end, b);
    if (e === -1) throw new Error(`${label}: BEGIN marker without END marker`);
    from = b;
    to = e + end.length;
  } else {
    const masked = maskComments(html);
    from = findOpen(html, masked);
    if (from === -1) throw new Error(`${label}: no element to replace`);
    const close = elementEnd(masked, from, tagName);
    if (close === null) throw new Error(`${label}: unbalanced <${tagName}>`);
    to = close;
  }
  const lineStart = html.lastIndexOf('\n', from - 1) + 1;
  const indent = html.slice(lineStart, from);
  if (!/^[ \t]*$/.test(indent)) throw new Error(`${label}: block must start on its own line`);
  return { from: lineStart, to, indent };
}

/**
 * The site footer's opening offset in an unmarked page: the <footer> whose content links
 * Privacy and Status. Identified by content, because before the first bake it was an
 * inline-styled <footer style> on most pages and a classed one on enterprise.html.
 * @param {string} html
 * @param {string} masked
 * @returns {number}
 */
function findBareFooter(html, masked) {
  const open = /<footer\b/g;
  let m;
  while ((m = open.exec(masked))) {
    const close = elementEnd(masked, m.index, 'footer');
    if (close === null) continue;
    const block = html.slice(m.index, close);
    if (block.includes('href="privacy.html"') && block.includes('href="/status"')) return m.index;
  }
  return -1;
}

/**
 * Inject (or refresh) the site header and footer in one page. Idempotent, keeps the
 * block's existing indentation and the file's line endings.
 * @param {string} html
 * @param {ChromePage} page
 * @returns {string}
 */
export function injectChrome(html, page) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let out = html.replace(/\r\n/g, '\n');

  if (page.header) {
    const at = locate(out, HEADER_BEGIN, HEADER_END, (_h, masked) => masked.indexOf(HEADER_OPEN), 'header', `${page.file} header`);
    out = out.slice(0, at.from) + wrap(HEADER_BEGIN, renderSiteHeader(page.header), HEADER_END, at.indent) + out.slice(at.to);
  }
  if (page.footer) {
    const at = locate(out, FOOTER_BEGIN, FOOTER_END, findBareFooter, 'footer', `${page.file} footer`);
    out = out.slice(0, at.from) + wrap(FOOTER_BEGIN, renderSiteFooter(), FOOTER_END, at.indent) + out.slice(at.to);
  }

  return eol === '\n' ? out : out.split('\n').join(eol);
}

/**
 * The baked region between a page's markers (markers included), LF, or null.
 * @param {string} html
 * @param {'header' | 'footer'} which
 * @returns {string | null}
 */
export function bakedRegion(html, which) {
  const [begin, end] = which === 'header' ? [HEADER_BEGIN, HEADER_END] : [FOOTER_BEGIN, FOOTER_END];
  const lf = html.replace(/\r\n/g, '\n');
  const b = lf.indexOf(begin);
  if (b === -1) return null;
  const e = lf.indexOf(end, b);
  if (e === -1) return null;
  const lineStart = lf.lastIndexOf('\n', b - 1) + 1;
  return lf.slice(lineStart, e + end.length);
}

/**
 * What a page's baked region should be, for the staleness guards.
 * @param {string} html the page, used only for the indentation of its BEGIN marker
 * @param {ChromePage} page
 * @param {'header' | 'footer'} which
 * @returns {string | null}
 */
export function expectedRegion(html, page, which) {
  const region = bakedRegion(html, which);
  if (region === null) return null;
  const indent = /^[ \t]*/.exec(region)?.[0] ?? '';
  return which === 'header'
    ? wrap(HEADER_BEGIN, renderSiteHeader(page.header), HEADER_END, indent)
    : wrap(FOOTER_BEGIN, renderSiteFooter(), FOOTER_END, indent);
}
