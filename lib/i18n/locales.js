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
 * @property {string} label     native language name (shown in the switcher)
 * @property {string} flag      flag asset under public/media-webp/flags/
 */

/** English — the default, served at the root with no prefix. @type {Locale} */
export const ENGLISH = { prefix: '', lang: 'english', hreflang: 'en', bcp47: 'en', ogLocale: 'en_US', label: 'English', flag: 'US.svg' };

/**
 * The ten non-English locales, each served under its own URL prefix. `lang` must
 * match a languages/<lang>.json file AND the corresponding <option value> in the
 * language switcher; `prefix` becomes the URL subdirectory.
 * @type {Locale[]}
 */
export const LOCALES = [
  { prefix: 'es', lang: 'spanish',    hreflang: 'es',      bcp47: 'es',      ogLocale: 'es_ES', label: 'Español',    flag: 'Spain.svg' },
  { prefix: 'fr', lang: 'french',     hreflang: 'fr',      bcp47: 'fr',      ogLocale: 'fr_FR', label: 'Français',   flag: 'France.svg' },
  { prefix: 'de', lang: 'german',     hreflang: 'de',      bcp47: 'de',      ogLocale: 'de_DE', label: 'Deutsch',    flag: 'Germany.svg' },
  { prefix: 'zh', lang: 'chinese',    hreflang: 'zh-Hans', bcp47: 'zh-Hans', ogLocale: 'zh_CN', label: '中文',        flag: 'China.svg' },
  { prefix: 'ko', lang: 'korean',     hreflang: 'ko',      bcp47: 'ko',      ogLocale: 'ko_KR', label: '한국어',       flag: 'Korea.svg' },
  { prefix: 'pt', lang: 'portuguese', hreflang: 'pt-BR',   bcp47: 'pt-BR',   ogLocale: 'pt_BR', label: 'Português',  flag: 'Brazil.svg' },
  { prefix: 'ru', lang: 'russian',    hreflang: 'ru',      bcp47: 'ru',      ogLocale: 'ru_RU', label: 'Русский',    flag: 'Russia.svg' },
  { prefix: 'it', lang: 'italian',    hreflang: 'it',      bcp47: 'it',      ogLocale: 'it_IT', label: 'Italiano',   flag: 'Italy.svg' },
  { prefix: 'ja', lang: 'japanese',   hreflang: 'ja',      bcp47: 'ja',      ogLocale: 'ja_JP', label: '日本語',       flag: 'Japan.svg' },
  { prefix: 'nl', lang: 'dutch',      hreflang: 'nl',      bcp47: 'nl',      ogLocale: 'nl_NL', label: 'Nederlands', flag: 'Netherlands.svg' },
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
 * @property {string} crumb      translation key for this page's name in a breadcrumb trail
 */

/**
 * The indexable pages that get a localized URL per language. Mirrors the marketing
 * set already in the sitemap. Deliberately EXCLUDES:
 *   - the blog — articles aren't in the translation JSON (English-only content project);
 *   - faq.html — it canonicalizes to /index.html#faq, so it's not an independent URL;
 *   - all auth / app pages (admin, pro, getpro, reset-password, plus-welcome) — noindex;
 *   - terms.html and privacy.html — the legal pages carry NO data-lang attributes, so
 *     render-page.js had nothing to translate and /de/terms.html served English under a
 *     German hreflang. They are deliberately English-only rather than translated: the
 *     ToS is governed by New York law and authoritative in English, and a machine-
 *     translated liability cap or refund term is an argument that the translation
 *     governs — worse exposure than serving one language. They stay in the sitemap as
 *     single English URLs via ENGLISH_ONLY_ENTRIES in sitemap.js, and routes/i18n.js
 *     301s the retired /<prefix>/terms.html URLs back to the English page.
 *
 * `crumb` is the translation key for the page's name in a breadcrumb trail. It is
 * deliberately an EXISTING key rather than a new breadcrumbs.* section: the trail's
 * label for a page and the nav's label for that same page are the same words, and two
 * keys holding one string is how they end up disagreeing in nine of eleven languages.
 * Every page carries one whether or not it renders a trail today, so adding a trail is
 * a markup change with no translation work. `crumb` must resolve in ALL packs —
 * test/i18n/breadcrumb-keys.test.js fails the build otherwise.
 * @type {LocalizedPage[]}
 */
export const LOCALIZED_PAGES = [
  { path: '/',                    file: 'index.html',          lastmod: '2026-08-11', changefreq: 'weekly',  priority: '1.0',  crumb: 'navigation.home' },
  { path: '/ai-designer.html',    file: 'ai-designer.html',    lastmod: '2026-08-10', changefreq: 'weekly',  priority: '0.9',  crumb: 'navigation.pdfTo3d' },
  { path: '/masking-studio.html', file: 'masking-studio.html', lastmod: '2026-08-11', changefreq: 'weekly',  priority: '0.9',  crumb: 'navigation.maskingStudio' },
  { path: '/basic-mask.html',     file: 'basic-mask.html',     lastmod: '2026-08-16', changefreq: 'weekly',  priority: '0.85', crumb: 'navigation.basicMask' },
  { path: '/exterior-studio.html', file: 'exterior-studio.html', lastmod: '2026-08-11', changefreq: 'weekly', priority: '0.9', crumb: 'navigation.exteriorStudio' },
  { path: '/stagify-plus.html',   file: 'stagify-plus.html',   lastmod: '2026-08-10', changefreq: 'monthly', priority: '0.85', crumb: 'navigation.plusBadge' },
  { path: '/enterprise.html',     file: 'enterprise.html',     lastmod: '2026-08-10', changefreq: 'monthly', priority: '0.85', crumb: 'enterprise.hero.title' },
  { path: '/guides.html',         file: 'guides.html',         lastmod: '2026-08-11', changefreq: 'monthly', priority: '0.8',  crumb: 'navigation.guides' },
  { path: '/contact.html',        file: 'contact.html',        lastmod: '2026-08-10', changefreq: 'monthly', priority: '0.6',  crumb: 'navigation.contactUs' },
  { path: '/developers.html',     file: 'developers.html',     lastmod: '2026-08-19', changefreq: 'monthly', priority: '0.6',  crumb: 'developers.crumb' },
  { path: '/status',              file: 'status.html',         lastmod: '2026-08-10', changefreq: 'monthly', priority: '0.3',  crumb: 'status.heading' },
];

/** Breadcrumb label key by page path, for the JSON-LD name rewrite. @type {Map<string, string>} */
export const CRUMB_KEYS = new Map(LOCALIZED_PAGES.map((p) => [p.path, p.crumb]));

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

/**
 * The Open Graph locale block for one locale: its own og:locale, then every OTHER
 * locale as og:locale:alternate. Facebook reads this to learn which locale variants
 * of a URL exist; Google ignores it entirely (hreflang above is what it reads), so
 * this is a social-card concern, not a ranking one.
 *
 * Unlike the hreflang cluster this is NOT reciprocal — it differs per variant, since
 * a locale must name itself in og:locale and must NOT repeat itself in the alternates.
 * That is exactly why it can't be authored once by hand and left alone: the English
 * block baked into the static pages has to be re-emitted per locale at render time.
 * @param {Locale} locale
 * @param {string} [indent]
 * @returns {string}
 */
export function buildOgLocaleBlock(locale, indent = '    ') {
  const lines = [`${indent}<meta property="og:locale" content="${locale.ogLocale}">`];
  for (const loc of ALL_LOCALES) {
    if (loc.ogLocale === locale.ogLocale) continue;
    lines.push(`${indent}<meta property="og:locale:alternate" content="${loc.ogLocale}">`);
  }
  return lines.join('\n');
}
