// Client-side helper for the localized-URL scheme. The server serves each language
// under its own prefix (/es, /fr/guides.html, …) with <base href="/"> injected;
// this module lets the language scripts detect the URL's language and lets the
// switcher (and the few in-app JS redirects) build the right localized URL.
//
// Keep PREFIX_TO_LANG / LOCALIZED_PATHS in sync with lib/i18n/locales.js (server).

/** URL prefix → switcher language value (the languages/<lang>.json basename). */
export const PREFIX_TO_LANG = {
  es: 'spanish',
  fr: 'french',
  de: 'german',
  zh: 'chinese',
  ko: 'korean',
  pt: 'portuguese',
  ru: 'russian',
  it: 'italian',
  ja: 'japanese',
  nl: 'dutch',
};

/** Language value → URL prefix ('' for English). */
export const LANG_TO_PREFIX = {
  english: '',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  chinese: 'zh',
  korean: 'ko',
  portuguese: 'pt',
  russian: 'ru',
  italian: 'it',
  japanese: 'ja',
  dutch: 'nl',
};

/** Paths that have a localized variant (mirror LOCALIZED_PAGES in lib/i18n/locales.js). */
const LOCALIZED_PATHS = new Set([
  '/',
  '/ai-designer.html',
  '/masking-studio.html',
  '/stagify-plus.html',
  '/enterprise.html',
  '/guides.html',
  '/contact.html',
  '/status',
  '/privacy.html',
  '/terms.html',
]);

/**
 * Split a pathname into its locale prefix and the English-equivalent base path.
 * '/es/guides.html' → { prefix: 'es', basePath: '/guides.html' };
 * '/es' → { prefix: 'es', basePath: '/' };  '/contact.html' → { prefix: '', basePath: '/contact.html' }.
 * @param {string} pathname
 * @returns {{ prefix: string, basePath: string }}
 */
export function splitLocale(pathname) {
  const m = pathname.match(/^\/([a-z]{2})(\/|$)/);
  if (m && Object.prototype.hasOwnProperty.call(PREFIX_TO_LANG, m[1])) {
    const prefix = m[1];
    let basePath = pathname.slice(prefix.length + 1) || '/';
    if (basePath === '/index.html') basePath = '/';
    return { prefix, basePath };
  }
  let basePath = pathname || '/';
  if (basePath === '/index.html') basePath = '/';
  return { prefix: '', basePath };
}

/**
 * The language value for the current URL, or null if the URL is the English root.
 * Prefers the server-set data-locale marker on <html>; falls back to the path.
 * @returns {string | null}
 */
export function urlLanguage() {
  try {
    const marked = document.documentElement.getAttribute('data-locale');
    if (marked && marked !== 'english') return marked;
  } catch (e) { /* no DOM access — fall through to path parsing */ }
  const { prefix } = splitLocale(location.pathname);
  return prefix ? PREFIX_TO_LANG[prefix] : null;
}

/**
 * The URL to navigate to when the user picks `langValue` on the current page.
 * Keeps the same logical page (prefixed for a locale, un-prefixed for English);
 * if the current page has no localized variant, a non-English pick lands on that
 * language's home.
 * @param {string} langValue
 * @returns {string}
 */
export function hrefForLanguage(langValue) {
  const { basePath } = splitLocale(location.pathname);
  const prefix = Object.prototype.hasOwnProperty.call(LANG_TO_PREFIX, langValue)
    ? LANG_TO_PREFIX[langValue]
    : '';
  if (!prefix) return basePath + location.hash; // English → root path
  if (!LOCALIZED_PATHS.has(basePath)) return `/${prefix}${location.hash}`; // no variant → localized home
  const target = basePath === '/' ? `/${prefix}` : `/${prefix}${basePath}`;
  return target + location.hash;
}

/**
 * Rewrite one href to stay inside `prefix`, idempotently. Mirrors the server's
 * rewriteHref (lib/i18n/render-page.js) so client-applied translations that carry
 * un-prefixed links (bare "#…" anchors, "terms.html", …) get re-localized.
 * @param {string} raw
 * @param {string} prefix
 * @param {string} selfPath  current page's localized path (e.g. '/de/guides.html')
 * @returns {string}
 */
function localizeHref(raw, prefix, selfPath) {
  const h = raw.trim();
  if (!h) return raw;
  if (/^(https?:)?\/\//i.test(h)) return raw;
  if (/^(mailto:|tel:|javascript:|data:|blob:)/i.test(h)) return raw;
  if (h.startsWith('#')) return selfPath + h; // bare fragment → pin to this page
  // Already under this prefix — leave it (keeps the pass idempotent).
  if (h === `/${prefix}` || h.startsWith(`/${prefix}/`) || h.startsWith(`/${prefix}#`) || h.startsWith(`/${prefix}?`)) {
    return raw;
  }
  const splitAt = h.search(/[#?]/);
  const bare = splitAt === -1 ? h : h.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : h.slice(splitAt);
  let candidate = bare.startsWith('/') ? bare : `/${bare}`;
  if (candidate === '/index.html') candidate = '/';
  if (LOCALIZED_PATHS.has(candidate)) {
    return (candidate === '/' ? `/${prefix}` : `/${prefix}${candidate}`) + suffix;
  }
  return raw; // non-localized target (blog, /api, …) — leave it
}

/**
 * Re-localize every internal <a href> under `root` to the current URL's locale
 * prefix. No-op on the English root. Called after the language loader (re)applies
 * translations, since applying [data-lang-html] resets links to their raw JSON form.
 * @param {ParentNode} [root]
 */
export function localizeLinks(root) {
  const scope = root || document;
  const { prefix, basePath } = splitLocale(location.pathname);
  if (!prefix) return;
  const selfPath = basePath === '/' ? `/${prefix}` : `/${prefix}${basePath}`;
  scope.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    if (raw == null) return;
    const next = localizeHref(raw, prefix, selfPath);
    if (next !== raw) a.setAttribute('href', next);
  });
}

/**
 * Resolve an in-app relative redirect target (e.g. 'stagify-plus.html',
 * 'index.html#ai-designer-demo') to an absolute path under the CURRENT locale
 * prefix, so <base href="/"> doesn't drop the user to the English root. On the
 * English root it returns the original target unchanged.
 * @param {string} rel
 * @returns {string}
 */
export function localizedTarget(rel) {
  const { prefix } = splitLocale(location.pathname);
  if (!prefix) return rel;
  const splitAt = rel.search(/[#?]/);
  const bare = (splitAt === -1 ? rel : rel.slice(0, splitAt)).replace(/^\//, '');
  const suffix = splitAt === -1 ? '' : rel.slice(splitAt);
  let path = bare ? `/${bare}` : '/';
  if (path === '/index.html') path = '/';
  const out = path === '/' ? `/${prefix}` : `/${prefix}${path}`;
  return out + suffix;
}
