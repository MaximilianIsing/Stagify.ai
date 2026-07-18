// Single source of truth for the site's localized-URL SEO layer: which languages
// get their own URL subdirectory, which pages are localized, and the helpers that
// derive canonical / hreflang URLs from that config.
//
// English is the default, served at the site root with no prefix. Each other
// language is served under /<prefix>/… with server-rendered translations so search
// engines index a distinct, crawlable URL per language (fixing the previous
// client-side-only i18n that left 10 of 11 languages invisible to search).
//
// Consumers: the request-time renderer (lib/i18n/render-page.js), the localized
// router (routes/i18n.js), the sitemap builder (lib/i18n/sitemap.js), and the
// build script that bakes the hreflang cluster into the English pages
// (scripts/build-i18n-seo.js). Change the language or page set HERE and everything
// downstream follows.

export const SITE_ORIGIN = 'https://stagify.ai';

/**
 * @typedef {object} Locale
 * @property {string} prefix    URL subdirectory ('' = English root, else 'es', 'fr', …)
 * @property {string} lang      languages/<lang>.json basename (also the switcher value)
 * @property {string} hreflang  BCP-47 tag for <link rel="alternate" hreflang="…">
 * @property {string} bcp47     value for the <html lang="…"> attribute
 * @property {string} ogLocale  Open Graph locale (og:locale)
 * @property {string} label     native language name (reference / UI)
 */

/** English — the default, served at the root with no prefix. @type {Locale} */
export const ENGLISH = { prefix: '', lang: 'english', hreflang: 'en', bcp47: 'en', ogLocale: 'en_US', label: 'English' };

/**
 * The ten non-English locales, each served under its own URL prefix. `lang` must
 * match a languages/<lang>.json file AND the corresponding <option value> in the
 * language switcher; `prefix` becomes the URL subdirectory.
 * @type {Locale[]}
 */
export const LOCALES = [
  { prefix: 'es', lang: 'spanish',    hreflang: 'es',      bcp47: 'es',      ogLocale: 'es_ES', label: 'Español' },
  { prefix: 'fr', lang: 'french',     hreflang: 'fr',      bcp47: 'fr',      ogLocale: 'fr_FR', label: 'Français' },
  { prefix: 'de', lang: 'german',     hreflang: 'de',      bcp47: 'de',      ogLocale: 'de_DE', label: 'Deutsch' },
  { prefix: 'zh', lang: 'chinese',    hreflang: 'zh-Hans', bcp47: 'zh-Hans', ogLocale: 'zh_CN', label: '中文' },
  { prefix: 'ko', lang: 'korean',     hreflang: 'ko',      bcp47: 'ko',      ogLocale: 'ko_KR', label: '한국어' },
  { prefix: 'pt', lang: 'portuguese', hreflang: 'pt-BR',   bcp47: 'pt-BR',   ogLocale: 'pt_BR', label: 'Português' },
  { prefix: 'ru', lang: 'russian',    hreflang: 'ru',      bcp47: 'ru',      ogLocale: 'ru_RU', label: 'Русский' },
  { prefix: 'it', lang: 'italian',    hreflang: 'it',      bcp47: 'it',      ogLocale: 'it_IT', label: 'Italiano' },
  { prefix: 'ja', lang: 'japanese',   hreflang: 'ja',      bcp47: 'ja',      ogLocale: 'ja_JP', label: '日本語' },
  { prefix: 'nl', lang: 'dutch',      hreflang: 'nl',      bcp47: 'nl',      ogLocale: 'nl_NL', label: 'Nederlands' },
];

/** English first, then every localized locale — hreflang emission order. @type {Locale[]} */
export const ALL_LOCALES = [ENGLISH, ...LOCALES];

/** Just the non-English URL prefixes (['es','fr',…]). @type {string[]} */
export const LOCALE_PREFIXES = LOCALES.map((l) => l.prefix);

/**
 * @typedef {object} LocalizedPage
 * @property {string} path       root-relative English path ('/' = home)
 * @property {string} file       HTML file under public/ to render
 * @property {string} lastmod    sitemap <lastmod>
 * @property {string} changefreq sitemap <changefreq>
 * @property {string} priority   sitemap <priority>
 */

/**
 * The indexable pages that get a localized URL per language. Mirrors the marketing /
 * legal set already in the sitemap. Deliberately EXCLUDES:
 *   - the blog — articles aren't in the translation JSON (English-only content project);
 *   - faq.html — it canonicalizes to /index.html#faq, so it's not an independent URL;
 *   - all auth / app pages (admin, pro, getpro, reset-password, plus-welcome) — noindex.
 * @type {LocalizedPage[]}
 */
export const LOCALIZED_PAGES = [
  { path: '/',                    file: 'index.html',          lastmod: '2026-07-17', changefreq: 'weekly',  priority: '1.0'  },
  { path: '/ai-designer.html',    file: 'ai-designer.html',    lastmod: '2026-07-17', changefreq: 'weekly',  priority: '0.9'  },
  { path: '/masking-studio.html', file: 'masking-studio.html', lastmod: '2026-07-10', changefreq: 'weekly',  priority: '0.9'  },
  { path: '/stagify-plus.html',   file: 'stagify-plus.html',   lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.85' },
  { path: '/enterprise.html',     file: 'enterprise.html',     lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.85' },
  { path: '/guides.html',         file: 'guides.html',         lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.8'  },
  { path: '/contact.html',        file: 'contact.html',        lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.6'  },
  { path: '/status',              file: 'status.html',         lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.3'  },
  { path: '/privacy.html',        file: 'privacy.html',        lastmod: '2026-07-10', changefreq: 'yearly',  priority: '0.3'  },
  { path: '/terms.html',          file: 'terms.html',          lastmod: '2026-07-10', changefreq: 'yearly',  priority: '0.3'  },
];

/** Set of localized page paths, for quick membership tests in link rewriting. @type {Set<string>} */
export const LOCALIZED_PATHS = new Set(LOCALIZED_PAGES.map((p) => p.path));

/**
 * Resolve a URL prefix to its locale ('' → English).
 * @param {string} prefix
 * @returns {Locale | undefined}
 */
export function localeByPrefix(prefix) {
  if (!prefix) return ENGLISH;
  return LOCALES.find((l) => l.prefix === prefix);
}

/**
 * Resolve a language name (json basename / switcher value) to its locale.
 * @param {string} lang
 * @returns {Locale | undefined}
 */
export function localeByLang(lang) {
  return ALL_LOCALES.find((l) => l.lang === lang);
}

/**
 * The absolute canonical URL of `path` in `locale`.
 * @param {Locale} locale
 * @param {string} path  a LOCALIZED_PAGES path ('/' for home)
 * @returns {string}
 */
export function localizedUrl(locale, path) {
  if (!locale.prefix) return `${SITE_ORIGIN}${path}`;
  return `${SITE_ORIGIN}/${locale.prefix}${path === '/' ? '' : path}`;
}

/**
 * The root-relative localized path (no origin) — for in-page links and routing.
 * @param {string} prefix  '' for English
 * @param {string} path    a LOCALIZED_PAGES path ('/' for home)
 * @returns {string}
 */
export function localizedPath(prefix, path) {
  if (!prefix) return path;
  return path === '/' ? `/${prefix}` : `/${prefix}${path}`;
}

/**
 * The full hreflang <link> cluster for a page — identical on every language variant
 * of that page (reciprocal), plus x-default → English. Returned as HTML <link> tags,
 * one per line, each prefixed with `indent`.
 * @param {string} path
 * @param {string} [indent]
 * @returns {string}
 */
export function buildHreflangCluster(path, indent = '    ') {
  const lines = ALL_LOCALES.map(
    (loc) => `${indent}<link rel="alternate" hreflang="${loc.hreflang}" href="${localizedUrl(loc, path)}">`,
  );
  lines.push(`${indent}<link rel="alternate" hreflang="x-default" href="${localizedUrl(ENGLISH, path)}">`);
  return lines.join('\n');
}
