// Request-time server-side renderer for the localized pages.
//
// Takes an English source page (public/<file>.html) + a parsed languages/<lang>.json
// and returns the page rendered in that language, ready to serve at /<prefix>/… :
//   • <html lang> set to the locale, plus data-locale for the client;
//   • <base href="/"> injected so every RELATIVE asset URL — in markup AND the ones
//     scripts compute at runtime (logo images, the heic2any worker, the
//     languages/<lang>.json fetch) — resolves against the site root, not /<prefix>/;
//   • the existing [data-lang] / [data-lang-html] / [data-lang-attr] attributes and
//     the <title> / JSON-LD applied server-side (same key scheme as the client
//     language-loader.js), so crawlers that don't run JS still see localized content;
//   • a self-referential canonical + the full hreflang cluster + og:url and the
//     per-locale og:locale / og:locale:alternate block;
//   • internal <a href> nav (and bare "#…" anchors) rewritten to stay inside the
//     locale prefix — because <base href="/"> would otherwise send them to English.
//
// This is a pure string transform (no DOM library): every byte that isn't a
// translation target passes through untouched, which keeps the hand-authored
// marketing pages byte-faithful. Interactive form fields (<input>/<textarea>) are
// left for the client to localize at runtime — their data-lang sets a *placeholder*,
// not text content, so translating their inner content here would be wrong.

import {
  buildHreflangCluster, buildOgLocaleBlock, CRUMB_KEYS, localizedPath, localizedUrl,
  LOCALIZED_PATHS, SITE_ORIGIN,
} from './locales.js';

/**
 * Is this parsed JSON-LD block the page's breadcrumb trail rather than the thing the
 * page is *about*? `@type` may be a string or an array, so both are checked.
 * @param {any} data
 * @returns {boolean}
 */
function isBreadcrumbList(data) {
  const type = data?.['@type'];
  return type === 'BreadcrumbList' || (Array.isArray(type) && type.includes('BreadcrumbList'));
}

/**
 * Every `<script type="application/ld+json">` block, with its open tag, raw body and
 * parsed data (null when the JSON is malformed — the caller then leaves it alone).
 * @param {string} html
 */
function jsonLdBlocks(html) {
  return [...html.matchAll(/(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/gi)]
    .map((m) => {
      let data = null;
      try { data = JSON.parse(m[2]); } catch { /* malformed — leave exactly as authored */ }
      return { full: m[0], open: m[1], body: m[2], close: m[3], data };
    });
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} s */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve a dot-path key (e.g. "hero.catchphrase") against the translations,
 * returning the string value, or null if any segment is missing / not a string.
 * @param {Record<string, any> | null} translations
 * @param {string} key
 * @returns {string | null}
 */
function resolveKey(translations, key) {
  if (!translations) return null;
  /** @type {any} */
  let cur = translations;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return null;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * Index of the '<' of the close tag that matches an element opened at `fromIndex`,
 * counting nested same-name tags so a `<div>` wrapping inner `<div>`s resolves
 * correctly. Returns -1 if no balanced close is found (caller then leaves the
 * element untouched rather than risk corrupting the document).
 * @param {string} html
 * @param {number} fromIndex  index just past the element's opening '>'
 * @param {string} tagName
 * @returns {number}
 */
function findMatchingClose(html, fromIndex, tagName) {
  const re = new RegExp(`<(/?)${tagName}(?=[\\s/>])`, 'gi');
  re.lastIndex = fromIndex;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') {
      if (depth === 0) return m.index;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return -1;
}

/**
 * Set (or replace) an attribute on a single opening-tag string.
 * @param {string} tag  e.g. '<meta name="description" content="…">'
 * @param {string} attr
 * @param {string} value  raw (un-escaped) value
 * @returns {string}
 */
function setTagAttr(tag, attr, value) {
  const esc = escapeAttr(value);
  const attrRe = new RegExp(`(\\s${attr}=")[^"]*(")`, 'i');
  if (attrRe.test(tag)) return tag.replace(attrRe, (_m, a, b) => `${a}${esc}${b}`);
  return tag.replace(/\s*\/?>$/, (end) => ` ${attr}="${esc}"${end}`);
}

/**
 * Apply [data-lang-attr="key|attr"] — set the named attribute to the translated
 * value. Runs over opening tags only (works for void elements like <meta>).
 * @param {string} html
 * @param {Record<string, any>} translations
 * @returns {string}
 */
function applyAttrTranslations(html, translations) {
  const re = /<[a-zA-Z][\w-]*\b[^>]*\bdata-lang-attr="([^"]+)"[^>]*>/g;
  return html.replace(re, (tag, spec) => {
    const [key, attr] = String(spec).split('|');
    if (!attr) return tag;
    const value = resolveKey(translations, key);
    return value == null ? tag : setTagAttr(tag, attr, value);
  });
}

/**
 * Apply [data-lang] (text content) and [data-lang-html] (raw HTML) by replacing
 * each element's inner content with the translated value. Single left-to-right
 * pass so nested elements and repeated keys are handled without offset drift.
 *
 * <input>/<textarea> are skipped: their data-lang drives a runtime *placeholder*,
 * not inner content, so the client localizes them — writing their content here
 * would pre-fill the field with the placeholder text.
 * @param {string} html
 * @param {Record<string, any>} translations
 * @returns {string}
 */
function applyContentTranslations(html, translations) {
  const re = /<([a-zA-Z][\w-]*)\b[^>]*?\bdata-lang(-html)?="([^"]+)"[^>]*>/g;
  let out = '';
  let cursor = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tagName = m[1];
    const isHtml = Boolean(m[2]);
    const key = m[3];
    const openEnd = m.index + m[0].length;

    // Form fields carry a placeholder-bound data-lang — leave them for the client.
    if (/^(input|textarea)$/i.test(tagName)) continue;

    const value = resolveKey(translations, key);
    if (value == null) continue; // untranslated → keep the English fallback + any nested keys

    const closeIdx = findMatchingClose(html, openEnd, tagName);
    if (closeIdx === -1) continue; // unbalanced → leave untouched (safety)

    out += html.slice(cursor, openEnd);
    out += isHtml ? value : escapeHtml(value);
    cursor = closeIdx;
    re.lastIndex = closeIdx; // resume at the close tag; don't rescan replaced inner
  }
  out += html.slice(cursor);
  return out;
}

/**
 * Set <html lang="…"> and a data-locale marker the client reads to detect the
 * URL language.
 * @param {string} html
 * @param {import('./locales.js').Locale} locale
 * @returns {string}
 */
function setHtmlLang(html, locale) {
  return html.replace(/<html\b[^>]*>/i, (tag) => {
    let t = tag;
    t = /\blang="/i.test(t)
      ? t.replace(/\blang="[^"]*"/i, `lang="${locale.bcp47}"`)
      : t.replace(/^<html/i, `<html lang="${locale.bcp47}"`);
    t = /\bdata-locale="/i.test(t)
      ? t.replace(/\bdata-locale="[^"]*"/i, `data-locale="${locale.lang}"`)
      : t.replace(/^<html/i, `<html data-locale="${locale.lang}"`);
    return t;
  });
}

/**
 * Inject <base href="/"> right after the charset meta (or after <head>), so all
 * relative URLs resolve against the site root under the /<prefix>/ path.
 * @param {string} html
 * @returns {string}
 */
function injectBase(html) {
  if (/<base\b/i.test(html)) return html;
  const baseTag = '\n    <base href="/">';
  if (/<meta\s+charset=[^>]*>/i.test(html)) {
    return html.replace(/(<meta\s+charset=[^>]*>)/i, (_m, charset) => `${charset}${baseTag}`);
  }
  return html.replace(/(<head\b[^>]*>)/i, (_m, head) => `${head}${baseTag}`);
}

/**
 * Keep the JSON-LD structured data in sync with the localized name / description /
 * keywords, mirroring the client's updateStructuredData().
 *
 * WHICH block: the one marked `data-lang-jsonld`, and only that one.
 *
 * It used to be the first block in document order, which is wrong on every page that
 * leads with its breadcrumb trail — guides.html, enterprise.html and stagify-plus.html
 * all do. There the page title and description were stamped onto the *trail*, while the
 * block actually describing the page (stagify-plus.html's SoftwareApplication) stayed
 * English in all eleven languages. Position is not the answer either: skipping the
 * BreadcrumbList would hand guides.html's page title to the first of its six HowTo
 * blocks, clobbering "Your first free staging" — those describe individual guides, not
 * the page, so guides.html has no page-entity block at all and correctly gets none.
 *
 * Unmarked pages are therefore left untouched, and test/i18n/page-entity-jsonld.test.js
 * pins that every page either marks exactly one block or is a listed exemption — so a
 * new page's block cannot go silently unlocalized.
 *
 * `keywords` is opt-in per page via `data-lang-keywords` on the JSON-LD tag itself.
 * It used to be scraped off `<meta name="keywords">`, but that tag is gone — Google
 * has ignored it since 2009 and Bing reads it as a spam signal. There is deliberately
 * no `meta.keywords` fallback: pages whose block has no such property (contact.html's
 * ContactPage) must not have one invented for them, which is exactly what the old
 * fallback did — it stamped the *homepage's* keyword list onto them. A page without
 * the attribute keeps its authored JSON-LD untouched.
 *
 * @param {string} html
 * @param {Record<string, any>} translations
 * @returns {string}
 */
function applyStructuredData(html, translations) {
  const titleKey = (html.match(/<title[^>]*\bdata-lang="([^"]+)"/i) || [])[1] || 'meta.title';
  const descKey = (html.match(/<meta[^>]*name="description"[^>]*\bdata-lang-attr="([^|"]+)\|/i) || [])[1] || 'meta.description';

  const target = jsonLdBlocks(html).find((b) => b.data && /\bdata-lang-jsonld\b/i.test(b.open));
  if (!target) return html; // unmarked (guides, enterprise) or malformed — leave as authored

  const data = target.data;
  // Read off the marked tag rather than the page, so the keywords key is the one this
  // block authored — not one that happens to appear earlier in the document.
  const kwKey = (target.open.match(/\bdata-lang-keywords="([^"]+)"/i) || [])[1];
  const name = resolveKey(translations, titleKey);
  const description = resolveKey(translations, descKey);
  const keywords = kwKey ? resolveKey(translations, kwKey) : undefined;
  if (name) data.name = name;
  if (description) data.description = description;
  if (keywords) data.keywords = keywords;

  return html.replace(target.full, () => `${target.open}${JSON.stringify(data)}${target.close}`);
}

/**
 * Point every BreadcrumbList `item` URL at this locale's copy of the page, and put
 * every crumb `name` into this locale's language.
 *
 * The trails are authored as absolute English URLs (https://stagify.ai/guides.html).
 * Left alone, /es/guides.html would tell Google its breadcrumb parent chain lives in
 * the English tree — a trail that disagrees with the page's own canonical. Only paths
 * that HAVE a localized copy are rewritten; anything else (the blog, external links)
 * is correct as English and is left exactly as authored.
 *
 * The `name` rewrite exists because the VISIBLE trail is translated from the same keys
 * by applyContentTranslations(). Rewriting only the URL would ship /es/guides.html with
 * a visible "Inicio › Guías" above a BreadcrumbList naming "Home › Guides" — the exact
 * visible/structured mismatch test/server/breadcrumbs.test.js was written to catch, but
 * in the locale tree, where that test (which scans the static English files) cannot see
 * it. Both halves resolve the same LOCALIZED_PAGES `crumb` key, so they agree by
 * construction rather than by two lists being edited together.
 *
 * A crumb whose path has no `crumb` key, or whose key is missing from this pack, keeps
 * its authored English name: a trail in mixed languages still describes the right
 * hierarchy, while a dropped crumb would describe a different one.
 *
 * @param {string} html
 * @param {import('./locales.js').Locale} locale
 * @param {Record<string, any>} translations
 * @returns {string}
 */
function localizeBreadcrumbs(html, locale, translations) {
  let out = html;
  for (const block of jsonLdBlocks(html)) {
    if (!block.data || !isBreadcrumbList(block.data)) continue;
    const items = block.data.itemListElement;
    if (!Array.isArray(items)) continue;

    let changed = false;
    for (const entry of items) {
      if (typeof entry?.item !== 'string') continue;
      if (!entry.item.startsWith(`${SITE_ORIGIN}/`) && entry.item !== `${SITE_ORIGIN}`) continue;
      let path = entry.item.slice(SITE_ORIGIN.length) || '/';
      if (path === '/index.html') path = '/';
      if (!LOCALIZED_PATHS.has(path)) continue;

      const localized = localizedUrl(locale, path);
      if (localized !== entry.item) {
        entry.item = localized;
        changed = true;
      }

      const crumbKey = CRUMB_KEYS.get(path);
      const name = crumbKey ? resolveKey(translations, crumbKey) : null;
      if (name && name !== entry.name) {
        entry.name = name;
        changed = true;
      }
    }
    if (!changed) continue;
    out = out.replace(block.full, () => `${block.open}${JSON.stringify(block.data)}${block.close}`);
  }
  return out;
}

/**
 * Rewrite the SEO head: self-referential canonical, the full hreflang cluster
 * (replacing any prior alternates + the stale "single URL" comment), og:url, the
 * per-locale og:locale / og:locale:alternate block, and the localized og/twitter
 * title + description (these are hardcoded English in the source — no data-lang —
 * so they'd otherwise stay English).
 * @param {string} html
 * @param {import('./locales.js').Locale} locale
 * @param {string} path
 * @param {Record<string, any>} translations
 * @returns {string}
 */
function applySeoHead(html, locale, path, translations) {
  const canonicalUrl = localizedUrl(locale, path);
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  let out = html;

  // Drop the stale "single URL serves all languages …" comment (it references the
  // old x-default-only design) and any existing hreflang alternates — whole lines
  // plus trailing blank lines (CRLF/LF), so no orphaned blank lines are left.
  out = out.replace(/[ \t]*<!--(?:(?!-->)[\s\S])*?hreflang(?:(?!-->)[\s\S])*?-->[ \t]*\r?\n(?:[ \t]*\r?\n)*/gi, '');
  out = out.replace(/[ \t]*<link\s+rel="alternate"\s+hreflang="[^"]*"[^>]*>[ \t]*\r?\n(?:[ \t]*\r?\n)*/gi, '');

  const cluster = buildHreflangCluster(path).split('\n').join(eol);
  out = out.replace(
    /([ \t]*)<link\s+rel="canonical"[^>]*>/i,
    (_m, indent) => `${indent}<link rel="canonical" href="${canonicalUrl}">${eol}${cluster}`,
  );

  out = out.replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/i, (_m, a, b) => `${a}${canonicalUrl}${b}`);

  // og:locale + the alternate list. The static English file carries the ENGLISH block
  // (baked by scripts/build-i18n-seo.js), and unlike the hreflang cluster that block is
  // NOT reciprocal — this locale has to name itself in og:locale and drop itself from
  // the alternates. So strip whatever is there and re-emit the block for this locale,
  // anchored to the og:url line just rewritten above. Pages with no Open Graph card
  // (privacy, terms) have no anchor and no og:locale to strip: both steps no-op, which
  // matches what the English page serves.
  out = out.replace(/[ \t]*<meta\s+property="og:locale(?::alternate)?"\s+content="[^"]*"[^>]*>[ \t]*\r?\n/gi, '');
  out = out.replace(
    /([ \t]*)<meta\s+property="og:url"\s+content="[^"]*"[^>]*>/i,
    (m, indent) => `${m}${eol}${buildOgLocaleBlock(locale, indent).split('\n').join(eol)}`,
  );

  // Localize the social-card title/description to the same keys the <title> and
  // <meta name="description"> use. Only rewrite when a translation exists.
  const titleKey = (html.match(/<title[^>]*\bdata-lang="([^"]+)"/i) || [])[1] || 'meta.title';
  const descKey = (html.match(/<meta[^>]*name="description"[^>]*\bdata-lang-attr="([^|"]+)\|/i) || [])[1] || 'meta.description';
  const title = resolveKey(translations, titleKey);
  const description = resolveKey(translations, descKey);
  const setMeta = (/** @type {string} */ prop, /** @type {string} */ kind, /** @type {string | null} */ value) => {
    if (value == null) return;
    const re = new RegExp(`(<meta\\s+${kind}="${prop}"\\s+content=")[^"]*(")`, 'i');
    out = out.replace(re, (_m, a, b) => `${a}${escapeAttr(value)}${b}`);
  };
  setMeta('og:title', 'property', title);
  setMeta('twitter:title', 'name', title);
  setMeta('og:description', 'property', description);
  setMeta('twitter:description', 'name', description);

  // Point the language-pack preload at THIS locale's pack. The English sources hard-code
  // `languages/english.json`, but the browser fetches the locale's pack instead
  // (language-loader.js builds `languages/<lang>.json` from urlLanguage()). Left alone,
  // every localized URL issued a guaranteed-unused high-priority fetch of 84 KB that
  // competed with the LCP image — and then downloaded the real pack anyway (russian.json
  // is 131 KB). Rewriting the href turns pure waste into an actual preload hit.
  // `locale.lang` is the languages/<lang>.json basename, so it is already the right token;
  // English callers never reach here, so the source tag stays correct for the static pages.
  out = out.replace(
    /(<link\s+rel="preload"\s+href=")languages\/english\.json(")/i,
    (_m, a, b) => `${a}languages/${locale.lang}.json${b}`,
  );

  return out;
}

/**
 * Rewrite one <a href> value so navigation stays inside the locale prefix.
 * Links to localized pages get the prefix; bare "#frag" anchors are pinned to the
 * current localized page (else <base href="/"> would send them to the root); links
 * to non-localized targets (blog, /api, external) are left as-is (relative ones
 * resolve to English via <base>, which is correct — those pages have no localization).
 * @param {string} href
 * @param {string} prefix
 * @param {string} selfPath  the current page's localized path (e.g. '/es/guides.html')
 * @returns {string}
 */
function rewriteHref(href, prefix, selfPath) {
  const h = href.trim();
  if (!h) return href;
  if (/^(https?:)?\/\//i.test(h)) return href; // external / protocol-relative
  if (/^(mailto:|tel:|javascript:|data:|blob:)/i.test(h)) return href;
  if (h.startsWith('#')) return `${selfPath}${h}`; // bare fragment → pin to this page

  const splitAt = h.search(/[#?]/);
  const bare = splitAt === -1 ? h : h.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : h.slice(splitAt);

  let candidate = bare.startsWith('/') ? bare : `/${bare}`;
  if (candidate === '/index.html') candidate = '/';

  if (LOCALIZED_PATHS.has(candidate)) return `${localizedPath(prefix, candidate)}${suffix}`;
  return href; // not a localized page — leave it (base resolves relative → English root)
}

/**
 * Rewrite every internal <a href> on the page for the given locale prefix.
 * @param {string} html
 * @param {string} prefix
 * @param {string} path
 * @returns {string}
 */
function rewriteAnchors(html, prefix, path) {
  const selfPath = localizedPath(prefix, path);
  return html.replace(
    /(<a\b[^>]*?\shref=)(["'])([\s\S]*?)\2/gi,
    (_full, pre, quote, href) => `${pre}${quote}${rewriteHref(href, prefix, selfPath)}${quote}`,
  );
}

/**
 * Render an English source page into `locale`, ready to serve at /<prefix>/….
 * @param {object} args
 * @param {string} args.html         raw English page HTML
 * @param {Record<string, any>} args.translations  parsed languages/<lang>.json
 * @param {import('./locales.js').Locale} args.locale
 * @param {string} args.path         a LOCALIZED_PAGES path ('/' for home)
 * @returns {string}
 */
export function renderLocalizedPage({ html, translations, locale, path }) {
  let out = html;
  out = setHtmlLang(out, locale);
  out = injectBase(out);
  out = applyAttrTranslations(out, translations);
  out = applyContentTranslations(out, translations);
  out = applyStructuredData(out, translations);
  if (locale.prefix) out = localizeBreadcrumbs(out, locale, translations);
  out = applySeoHead(out, locale, path, translations);
  if (locale.prefix) out = rewriteAnchors(out, locale.prefix, path);
  return out;
}
