// Which blog articles exist in which languages — the availability layer that makes the
// blog's localization per-article rather than all-or-nothing.
//
// A marketing page is translated in all eleven languages or it is not localized at all,
// because its strings live in the shared public/languages/<lang>.json packs that
// test/server/static.test.js holds at full key parity. An article's prose lives in its own
// pack at public/blog/i18n/<slug>/<lang>.json, so the matrix is sparse: an article can
// exist in six languages while another exists in two.
//
// Everything downstream — the baked hreflang clusters, the sitemap, the routes, the hub's
// card grid, the per-article alternates nav — must agree on exactly that sparse set, so it
// is recorded ONCE in the generated lib/i18n/blog-i18n-manifest.js and read from there.
//
// Generated-and-committed rather than scanned at import time, matching the
// public/scripts/locale-data.js idiom, because:
//   - buildSitemap() must stay a pure function: test/i18n/i18n.test.js byte-compares the
//     committed public/sitemap.xml against a fresh call, which a filesystem scan would
//     make dependent on the machine it runs on;
//   - routes/i18n.js registers its routes at mount time and must not do I/O to do it;
//   - the drift test then gives the same "you forgot to rerun the build" failure the repo
//     already trains people to expect from locale-data.js and sitemap.xml.
//
// Regenerate with `node scripts/build-i18n-seo.js`.

import fs from 'fs';
import path from 'path';
import { ENGLISH, LOCALES, LOCALIZED_ARTICLES, localeByLang } from './locales.js';
import { BLOG_PACK_LOCALES } from './blog-i18n-manifest.js';

/** Where an article's translation packs live, relative to public/. */
export const PACK_ROOT = 'blog/i18n';

/**
 * The pack directory for one article, in the form page-renderer.js wants (relative to public/).
 * @param {string} slug
 * @returns {string}
 */
export function packDirFor(slug) {
  return `${PACK_ROOT}/${slug}`;
}

/**
 * Scan public/blog/i18n/ and report which URL prefixes each article has a pack for.
 *
 * A file only counts if its language is one this site serves — a stray `notes.json`, or a
 * pack for a language later removed from LOCALES, must not become a route, a sitemap row
 * or an hreflang. Prefixes come back in LOCALES order rather than directory order so the
 * generated module is stable across filesystems.
 *
 * @param {string} publicDir
 * @returns {Record<string, string[]>} slug → URL prefixes, e.g. { 'home-staging-cost': ['es','fr'] }
 */
export function scanBlogPacks(publicDir) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const article of LOCALIZED_ARTICLES) {
    const dir = path.join(publicDir, ...PACK_ROOT.split('/'), article.slug);
    /** @type {string[]} */
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // no packs for this article yet — the normal state during rollout
    }
    const prefixes = new Set();
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const locale = localeByLang(file.slice(0, -'.json'.length));
      if (!locale || !locale.prefix) continue; // unknown language, or english.json (never a variant)
      prefixes.add(locale.prefix);
    }
    if (prefixes.size === 0) continue;
    out[article.slug] = LOCALES.filter((l) => prefixes.has(l.prefix)).map((l) => l.prefix);
  }
  return out;
}

/**
 * The source of lib/i18n/blog-i18n-manifest.js for the packs currently on disk.
 * @param {string} publicDir
 * @returns {string}
 */
export function buildBlogManifestModule(publicDir) {
  const packs = scanBlogPacks(publicDir);
  const rows = Object.keys(packs)
    .sort()
    .map((slug) => `  '${slug}': [${packs[slug].map((p) => `'${p}'`).join(', ')}],`);
  return [
    '// GENERATED FILE — do not edit by hand.',
    '// Regenerate with `node scripts/build-i18n-seo.js` after adding or removing a',
    '// translation pack under public/blog/i18n/. test/i18n/blog-manifest.test.js fails the',
    '// build if this file and the packs on disk disagree.',
    '//',
    '// See lib/i18n/blog-packs.js for why this is committed rather than scanned at import.',
    '',
    '/**',
    ' * Blog slug → the URL prefixes that have a translation pack, in LOCALES order.',
    ' * An article absent from this map exists in English only.',
    ' * @type {Record<string, string[]>}',
    ' */',
    'export const BLOG_PACK_LOCALES = {',
    ...rows,
    '};',
    '',
  ].join('\n');
}

/**
 * The locales the hub is published in: English, plus any locale that has at least one
 * translated article. A hub with no cards would advertise an empty blog, so a locale earns
 * its hub by having something to put on it.
 * @returns {import('./locales.js').Locale[]}
 */
export function localesForHub() {
  const live = new Set();
  for (const prefixes of Object.values(BLOG_PACK_LOCALES)) {
    for (const prefix of prefixes) live.add(prefix);
  }
  return [ENGLISH, ...LOCALES.filter((l) => live.has(l.prefix))];
}

/**
 * The locales an article is published in: English first, then every locale with a pack.
 *
 * This is the set a hreflang cluster, a sitemap row and an alternates nav must all be built
 * from. English is always present — it is the source — so the return is never empty, and a
 * single-element return means "English only", which still gets a valid self-referential
 * cluster plus x-default.
 *
 * @param {string | null} slug  null for the hub
 * @returns {import('./locales.js').Locale[]}
 */
export function articleLocales(slug) {
  if (slug === null) return localesForHub();
  const prefixes = BLOG_PACK_LOCALES[slug];
  if (!prefixes || prefixes.length === 0) return [ENGLISH];
  return [ENGLISH, ...LOCALES.filter((l) => prefixes.includes(l.prefix))];
}

/**
 * The articles available in one locale, in LOCALIZED_ARTICLES order.
 * @param {string} prefix  '' for English → every article
 * @returns {import('./locales.js').LocalizedArticle[]}
 */
export function articlesForLocale(prefix) {
  if (!prefix) return [...LOCALIZED_ARTICLES];
  return LOCALIZED_ARTICLES.filter((a) => (BLOG_PACK_LOCALES[a.slug] || []).includes(prefix));
}

/**
 * Slugs available in one locale — the set lib/i18n/blog-hub.js prunes the card grid against.
 * @param {string} prefix
 * @returns {Set<string>}
 */
export function slugsForLocale(prefix) {
  return new Set(articlesForLocale(prefix).map((a) => a.slug));
}

/**
 * Every (locale, article) pair that has a rendered page — what routes/i18n.js registers and
 * what buildSitemap() lists, so a URL exists in exactly one place's opinion. English is
 * excluded: those are static files, not rendered routes.
 * @returns {Array<{ locale: import('./locales.js').Locale, article: import('./locales.js').LocalizedArticle }>}
 */
export function publishedArticlePages() {
  const out = [];
  for (const article of LOCALIZED_ARTICLES) {
    for (const locale of articleLocales(article.slug)) {
      if (!locale.prefix) continue;
      out.push({ locale, article });
    }
  }
  return out;
}
