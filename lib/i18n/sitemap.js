// Multilingual sitemap builder — the single source of truth for public/sitemap.xml.
//
// For every localized page we emit one <url> per language (English + 10 locales),
// each carrying the full set of <xhtml:link rel="alternate" hreflang="…"> annotations
// (all languages + x-default) so Google can pair the language variants. Blog articles
// follow, each over the subset of languages it actually has a translation pack for. The
// legal pages, which are deliberately English-only, are plain <url> entries with no
// alternates.
//
// scripts/build-i18n-seo.js writes buildSitemap() to public/sitemap.xml; a test
// (test/i18n/i18n.test.js) asserts the committed file still matches, so the config and the
// served sitemap can't drift.

import { ALL_LOCALES, BLOG_HUB, ENGLISH, LOCALIZED_ARTICLES, LOCALIZED_PAGES, SITE_ORIGIN, localizedUrl } from './locales.js';
import { articleLocales } from './blog-packs.js';

/**
 * @typedef {object} SitemapEntry
 * @property {string} loc
 * @property {string} lastmod
 * @property {string} changefreq
 * @property {string} priority
 */

/**
 * English-only pages that are NOT part of the localized set: the blog, and the
 * legal pages (see the LOCALIZED_PAGES comment in locales.js for why those are
 * deliberately not translated). Kept here so the sitemap stays complete — without an
 * entry a de-localized page would drop out of the sitemap entirely rather than fall
 * back to one English URL. Update lastmods when an article or a policy changes.
 *
 * The Enterprise MSA is deliberately absent: it is a contract template, served
 * noindex and disallowed in robots.txt. The subprocessor list is the opposite — it
 * is here precisely so that it can be found and linked.
 * @type {SitemapEntry[]}
 */
const ENGLISH_ONLY_ENTRIES = [
  { loc: `${SITE_ORIGIN}/terms.html`, lastmod: '2026-09-17', changefreq: 'yearly', priority: '0.3' },
  { loc: `${SITE_ORIGIN}/privacy.html`, lastmod: '2026-09-17', changefreq: 'yearly', priority: '0.3' },
  { loc: `${SITE_ORIGIN}/legal/subprocessors.html`, lastmod: '2026-09-17', changefreq: 'yearly', priority: '0.2' },
];

/**
 * The <xhtml:link> alternate block for a page — identical on every language variant.
 * @param {string} path
 * @param {import('./locales.js').Locale[]} [locales]  the variants that EXIST; defaults to
 *   all eleven. Blog articles pass the subset their translation packs cover, so the sitemap
 *   never annotates a page with an alternate that 404s.
 * @returns {string[]} indented lines
 */
function alternateLinks(path, locales = ALL_LOCALES) {
  const lines = locales.map(
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

  // The blog. Unlike the pages above, an article is localized per LANGUAGE rather than
  // all-or-nothing (lib/i18n/blog-packs.js), so each one emits a row per locale it has a
  // pack for and annotates them with only those alternates. An article with no packs
  // emits the single English row it had when this list lived in ENGLISH_ONLY_ENTRIES,
  // with no <xhtml:link> block — a lone page has no alternates to declare.
  for (const article of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const locales = articleLocales(article.slug);
    const alternates = locales.length > 1 ? alternateLinks(article.path, locales) : [];
    for (const locale of locales) {
      blocks.push(
        urlBlock({
          loc: localizedUrl(locale, article.path),
          lastmod: article.lastmod,
          changefreq: article.changefreq,
          priority: article.priority,
          alternates,
        }),
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    blocks.join('\n'),
    '</urlset>',
    '',
  ].join('\n');
}
