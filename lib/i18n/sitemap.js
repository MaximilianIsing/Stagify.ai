// Multilingual sitemap builder — the single source of truth for public/sitemap.xml.
//
// For every localized page we emit one <url> per language (English + 10 locales),
// each carrying the full set of <xhtml:link rel="alternate" hreflang="…"> annotations
// (all languages + x-default) so Google can pair the language variants. English-only
// content (the blog) is appended as plain <url> entries with no alternates.
//
// scripts/build-i18n-seo.js writes buildSitemap() to public/sitemap.xml; a test
// (test/i18n.test.js) asserts the committed file still matches, so the config and the
// served sitemap can't drift.

import { ALL_LOCALES, ENGLISH, LOCALIZED_PAGES, SITE_ORIGIN, localizedUrl } from './locales.js';

/**
 * @typedef {object} SitemapEntry
 * @property {string} loc
 * @property {string} lastmod
 * @property {string} changefreq
 * @property {string} priority
 */

/**
 * English-only pages that are NOT part of the localized set (the blog). Kept here
 * so the sitemap stays complete; update lastmods when an article changes.
 * @type {SitemapEntry[]}
 */
const ENGLISH_ONLY_ENTRIES = [
  { loc: `${SITE_ORIGIN}/blog/`, lastmod: '2026-07-17', changefreq: 'weekly', priority: '0.7' },
  { loc: `${SITE_ORIGIN}/blog/is-virtual-staging-allowed-on-the-mls`, lastmod: '2026-07-03', changefreq: 'monthly', priority: '0.7' },
  { loc: `${SITE_ORIGIN}/blog/masking-studio-and-ai-designer`, lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.7' },
  { loc: `${SITE_ORIGIN}/blog/does-virtual-staging-help-sell-homes`, lastmod: '2026-07-17', changefreq: 'monthly', priority: '0.7' },
  { loc: `${SITE_ORIGIN}/blog/stagify-vs-other-virtual-staging-tools`, lastmod: '2026-06-15', changefreq: 'monthly', priority: '0.7' },
];

/**
 * The <xhtml:link> alternate block for a page — identical on every language variant.
 * @param {string} path
 * @returns {string[]} indented lines
 */
function alternateLinks(path) {
  const lines = ALL_LOCALES.map(
    (loc) => `    <xhtml:link rel="alternate" hreflang="${loc.hreflang}" href="${localizedUrl(loc, path)}"/>`,
  );
  lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${localizedUrl(ENGLISH, path)}"/>`);
  return lines;
}

/**
 * @param {{loc: string, lastmod: string, changefreq: string, priority: string, alternates?: string[]}} e
 * @returns {string}
 */
function urlBlock(e) {
  const lines = [
    '  <url>',
    `    <loc>${e.loc}</loc>`,
    `    <lastmod>${e.lastmod}</lastmod>`,
    `    <changefreq>${e.changefreq}</changefreq>`,
    `    <priority>${e.priority}</priority>`,
    ...(e.alternates || []),
    '  </url>',
  ];
  return lines.join('\n');
}

/**
 * Build the full sitemap XML string.
 * @returns {string}
 */
export function buildSitemap() {
  /** @type {string[]} */
  const blocks = [];

  for (const page of LOCALIZED_PAGES) {
    const alternates = alternateLinks(page.path);
    for (const locale of ALL_LOCALES) {
      blocks.push(
        urlBlock({
          loc: localizedUrl(locale, page.path),
          lastmod: page.lastmod,
          changefreq: page.changefreq,
          priority: page.priority,
          alternates,
        }),
      );
    }
  }

  for (const e of ENGLISH_ONLY_ENTRIES) blocks.push(urlBlock(e));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    blocks.join('\n'),
    '</urlset>',
    '',
  ].join('\n');
}
