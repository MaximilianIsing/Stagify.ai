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
  { path: '/about.html',          file: 'about.html',          lastmod: '2026-09-17', changefreq: 'monthly', priority: '0.6',  crumb: 'navigation.about' },
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
 * @param {Locale[]} [locales]  the variants that actually EXIST for this path; defaults to all
 *   eleven. A blog article passes the subset its translation packs cover — naming a
 *   locale here that has no page is an hreflang pointing at a 404.
 * @returns {string}
 */
export function buildHreflangCluster(path, indent = '    ', locales = ALL_LOCALES) {
  const lines = locales.map(
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
 * @param {Locale[]} [locales]  the variants that actually EXIST for this path; defaults to all
 *   eleven. A blog article passes the subset its translation packs cover — naming a
 *   locale here that has no page is an hreflang pointing at a 404.
 * @returns {string}
 */
export function buildOgLocaleBlock(locale, indent = '    ', locales = ALL_LOCALES) {
  const lines = [`${indent}<meta property="og:locale" content="${locale.ogLocale}">`];
  for (const loc of locales) {
    if (loc.ogLocale === locale.ogLocale) continue;
    lines.push(`${indent}<meta property="og:locale:alternate" content="${loc.ogLocale}">`);
  }
  return lines.join('\n');
}

/**
 * @typedef {object} LocalizedArticle
 * @property {string} slug         blog slug, e.g. 'home-staging-cost'
 * @property {string} path         root-relative English path ('/blog/<slug>', or '/blog/')
 * @property {string} file         HTML file under public/ to render
 * @property {string} lastmod      sitemap <lastmod>; MUST equal the article's JSON-LD dateModified
 * @property {string} changefreq   sitemap <changefreq>
 * @property {string} priority     sitemap <priority>
 */

/**
 * The blog articles, which get a localized URL per language they have a TRANSLATION PACK
 * for — not per language the site supports. That is the difference between this array and
 * LOCALIZED_PAGES above, and the reason it is a separate export rather than more rows there:
 *
 *   - a marketing page is translated in all 11 languages or it is not in the set at all,
 *     because its strings live in the shared public/languages/<lang>.json packs, which
 *     test/server/static.test.js holds at full key parity. An article's prose lives in its
 *     OWN pack (public/blog/i18n/<slug>/<lang>.json), so it can exist in six languages and
 *     not the other four. Which ones exist is recorded in the generated
 *     lib/i18n/blog-i18n-manifest.js and read through lib/i18n/blog-packs.js.
 *   - an article's breadcrumb label is its own title, so it has no `crumb` key that could
 *     resolve in all 11 site packs the way LOCALIZED_PAGES entries must.
 *   - consequently an article carries a hreflang cluster over a SUBSET of the locales,
 *     where every LOCALIZED_PAGES entry carries the full eleven.
 *
 * Emitting an hreflang for a language whose pack does not exist would point Google at a
 * 404, which is the one failure mode in this whole layer that actively costs rankings —
 * hence the manifest, and hence test/i18n/blog-i18n.test.js checking the baked clusters
 * against it.
 *
 * `lastmod` values moved here verbatim from ENGLISH_ONLY_ENTRIES in sitemap.js;
 * test/seo/blog-dates.test.js reads them out of THIS array and holds each equal to the
 * article's JSON-LD dateModified.
 * @type {LocalizedArticle[]}
 */
export const LOCALIZED_ARTICLES = [
  { slug: 'is-virtual-staging-allowed-on-the-mls', path: '/blog/is-virtual-staging-allowed-on-the-mls', file: 'blog/is-virtual-staging-allowed-on-the-mls.html', lastmod: '2026-08-11', changefreq: 'monthly', priority: '0.7' },
  { slug: 'masking-studio-and-ai-designer', path: '/blog/masking-studio-and-ai-designer', file: 'blog/masking-studio-and-ai-designer.html', lastmod: '2026-07-10', changefreq: 'monthly', priority: '0.7' },
  { slug: 'does-virtual-staging-help-sell-homes', path: '/blog/does-virtual-staging-help-sell-homes', file: 'blog/does-virtual-staging-help-sell-homes.html', lastmod: '2026-07-17', changefreq: 'monthly', priority: '0.7' },
  { slug: 'stagify-vs-other-virtual-staging-tools', path: '/blog/stagify-vs-other-virtual-staging-tools', file: 'blog/stagify-vs-other-virtual-staging-tools.html', lastmod: '2026-06-15', changefreq: 'monthly', priority: '0.7' },
  { slug: 'top-10-ai-virtual-staging-sites-2026', path: '/blog/top-10-ai-virtual-staging-sites-2026', file: 'blog/top-10-ai-virtual-staging-sites-2026.html', lastmod: '2026-07-22', changefreq: 'monthly', priority: '0.7' },
  { slug: 'dorm-room-design-ai-college-freshmen', path: '/blog/dorm-room-design-ai-college-freshmen', file: 'blog/dorm-room-design-ai-college-freshmen.html', lastmod: '2026-07-27', changefreq: 'monthly', priority: '0.7' },
  { slug: 'prepare-your-listing-for-the-fall-market', path: '/blog/prepare-your-listing-for-the-fall-market', file: 'blog/prepare-your-listing-for-the-fall-market.html', lastmod: '2026-08-03', changefreq: 'monthly', priority: '0.7' },
  { slug: 'curb-appeal-real-estate-photos', path: '/blog/curb-appeal-real-estate-photos', file: 'blog/curb-appeal-real-estate-photos.html', lastmod: '2026-08-07', changefreq: 'monthly', priority: '0.7' },
  { slug: 'free-virtual-staging', path: '/blog/free-virtual-staging', file: 'blog/free-virtual-staging.html', lastmod: '2026-08-11', changefreq: 'monthly', priority: '0.7' },
  { slug: 'virtual-staging-disclosure-laws-by-state', path: '/blog/virtual-staging-disclosure-laws-by-state', file: 'blog/virtual-staging-disclosure-laws-by-state.html', lastmod: '2026-08-11', changefreq: 'monthly', priority: '0.7' },
  { slug: 'fsbo-listing-photos', path: '/blog/fsbo-listing-photos', file: 'blog/fsbo-listing-photos.html', lastmod: '2026-08-14', changefreq: 'monthly', priority: '0.7' },
  { slug: 'new-construction-listing-photos', path: '/blog/new-construction-listing-photos', file: 'blog/new-construction-listing-photos.html', lastmod: '2026-08-16', changefreq: 'monthly', priority: '0.7' },
  { slug: 'virtual-staging-api', path: '/blog/virtual-staging-api', file: 'blog/virtual-staging-api.html', lastmod: '2026-09-02', changefreq: 'monthly', priority: '0.7' },
  { slug: 'home-staging-cost', path: '/blog/home-staging-cost', file: 'blog/home-staging-cost.html', lastmod: '2026-09-09', changefreq: 'monthly', priority: '0.7' },
  { slug: 'remove-furniture-from-listing-photos', path: '/blog/remove-furniture-from-listing-photos', file: 'blog/remove-furniture-from-listing-photos.html', lastmod: '2026-09-16', changefreq: 'monthly', priority: '0.7' },
];

/**
 * The blog hub. Article-shaped but slug-less: it is localized whenever ANY article is
 * localized in that language, and its card grid is pruned to the articles that exist
 * (lib/i18n/blog-hub.js). Its path carries a trailing slash, unlike every LOCALIZED_PAGES
 * path — localizedUrl() handles that fine, it is only '/' that gets special-cased.
 * @type {Omit<LocalizedArticle, 'slug'> & { slug: null }}
 */
export const BLOG_HUB = { slug: null, path: '/blog/', file: 'blog/index.html', lastmod: '2026-09-16', changefreq: 'weekly', priority: '0.7' };

/**
 * Every blog path that COULD be localized, hub included. This is the candidate set, not
 * the available set: whether a given article exists in a given language is the manifest's
 * business. Used by the renderer to decide which blog links are even worth considering
 * for prefixing.
 *
 * Deliberately NOT merged into LOCALIZED_PATHS: test/i18n/locale-data.test.js pins the
 * browser's generated copy of that set, and the browser's hrefForLanguage() would then
 * claim every article exists in every language regardless of which packs are on disk.
 * @type {Set<string>}
 */
export const LOCALIZED_BLOG_PATHS = new Set([BLOG_HUB.path, ...LOCALIZED_ARTICLES.map((a) => a.path)]);

/** Article descriptor by slug, for route and sitemap lookups. @type {Map<string, LocalizedArticle>} */
export const ARTICLES_BY_SLUG = new Map(LOCALIZED_ARTICLES.map((a) => [a.slug, a]));
