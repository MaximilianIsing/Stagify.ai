// Shared cache layer in front of renderLocalizedPage.
//
// Rendering a localized page is a pure string transform over two static inputs (the
// English HTML file and the language JSON), so every step is memoizable: the raw file,
// the parsed pack, and the finished per-locale string. Caches are process-lifetime — a
// deploy restarts the process, so a content or translation change is picked up on
// redeploy. DEBUG_MODE bypasses all three for local dev (edit + refresh, no restart).
//
// This lived inline in routes/i18n.js until the 404 handler (lib/http/not-found.js)
// needed exactly the same three caches. It is a factory rather than a module-level
// singleton so each caller owns its own maps and the two never share eviction fate.

import path from 'path';
import fs from 'fs';
import { renderLocalizedPage } from './render-page.js';
import { stripHtmlComments } from '../http/text-assets.js';
import { localizeCoverUrls } from './blog-covers.js';

/**
 * @param {{ publicDir: string, DEBUG_MODE: boolean }} opts
 */
export function createPageRenderer({ publicDir, DEBUG_MODE }) {
  /** @type {Map<string, string>} */
  const rawCache = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const jsonCache = new Map();
  /** @type {Map<string, string>} */
  const renderCache = new Map();

  /**
   * The raw English source of a file under public/.
   * @param {string} file
   * @returns {string}
   */
  function rawHtml(file) {
    const cached = rawCache.get(file);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    rawCache.set(file, html);
    return html;
  }

  /**
   * A parsed translation pack.
   *
   * With no `packDir` this is the site-wide public/languages/<lang>.json — 1,688 UI
   * strings shared by every page. With one, it is a single article's own pack
   * (public/blog/i18n/<slug>/<lang>.json), which exists precisely so article prose does
   * NOT go in the shared file: those packs are ~116 KB and the browser fetches one whole
   * on every page load, so putting the catalog's prose there would roughly triple the
   * cost of every page on the site to serve content only the blog needs.
   *
   * A missing article pack is `{}`, not an error: that is how a locale opts OUT of an
   * article. Every `post.*` key then resolves null and the renderer leaves the English
   * text exactly as authored, which is what the untranslated fallback should look like.
   * A missing SITE pack is still a hard failure — that one is a deployment fault.
   *
   * @param {string} lang
   * @param {string} [packDir]  relative to public/, e.g. 'blog/i18n/home-staging-cost'
   * @returns {Record<string, any>}
   */
  function translations(lang, packDir) {
    const key = packDir ? `${packDir}:${lang}` : lang;
    const cached = jsonCache.get(key);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const file = packDir
      ? path.join(publicDir, ...packDir.split('/'), `${lang}.json`)
      : path.join(publicDir, 'languages', `${lang}.json`);
    /** @type {Record<string, any>} */
    let obj;
    if (packDir && !fs.existsSync(file)) obj = {};
    else obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(key, obj);
    return obj;
  }

  /**
   * A page rendered into a locale, ready to send.
   *
   * The memo key carries the source FILE as well as the path. Path alone was enough
   * when routes/i18n.js was the only caller (LOCALIZED_PAGES paths are unique), but a
   * second caller rendering its own page descriptor could otherwise collide with an
   * i18n page that happens to share a path.
   *
   * A page may additionally carry the per-render options the blog needs. They travel on
   * the page descriptor rather than as extra arguments so that the memo key — which is
   * derived from the descriptor — still covers everything that affects the output.
   *
   * @param {import('./locales.js').Locale} locale
   * @param {import('./locales.js').LocalizedPage | {
   *   path: string, file: string, packDir?: string, packKey?: string,
   *   localizedPaths?: Set<string>,
   *   crumbKeys?: Map<string, string>, locales?: import('./locales.js').Locale[],
   *   postProcess?: (html: string, locale: import('./locales.js').Locale) => string,
   * }} page
   * @returns {string}
   */
  function render(locale, page) {
    const key = `${locale.prefix}:${page.file}:${page.path}`;
    const cached = renderCache.get(key);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const opts = /** @type {any} */ (page);
    // The page's own pack is mounted under a namespace (`post` for an article, `hub` for
    // the blog index), BESIDE the shared chrome rather than replacing it: the article's
    // <title> and body come from its own pack, while its breadcrumbs, topbar CTA and
    // footer keep resolving the site keys every other page uses. English never merges —
    // it IS the source, and the static file already says what it says.
    // `packTransform` derives keys the pack does not store, and must return a NEW object:
    // translations() hands back its cached copy, so mutating it would poison every later
    // render of that language. The home page uses it — see withCardReadTimes in blog-hub.js.
    const own = opts.packDir && locale.prefix ? translations(locale.lang, opts.packDir) : null;
    const packs = own
      ? { ...translations(locale.lang), [opts.packKey || 'post']: opts.packTransform ? opts.packTransform(own) : own }
      : translations(locale.lang);
    const rendered = renderLocalizedPage({
      html: rawHtml(page.file),
      translations: packs,
      locale,
      path: page.path,
      localizedPaths: opts.localizedPaths,
      crumbKeys: opts.crumbKeys,
      locales: opts.locales,
    });
    // Stripped AFTER rendering, never before: renderLocalizedPage's regexes were written
    // against the English source as authored, and some of them anchor on markup that sits
    // next to a comment. Stripping first would be a silent change to what they match.
    //
    // This is the locale pages' share of the saving lib/http/text-assets.js gives the
    // English ones — ~27 KB of prose per page, on ten homepages plus every localized
    // page behind them, which would otherwise be the one part of the site still paying
    // for it. Memoised here, so it costs one pass per (locale, page) for the process
    // lifetime. DEBUG_MODE keeps the comments, matching the static path.
    const stripped = DEBUG_MODE ? rendered : stripHtmlComments(rendered);
    // A last pure transform on the finished string, for work that is not a translation:
    // the blog hub uses it to drop the cards of articles this locale has no pack for.
    // Inside the memo, so it costs one pass per (locale, page) like everything else.
    // Cover images last, after every other rewrite: this only swaps image FILENAMES, and
    // doing it here means an article, the hub and anything else that grows a cover are all
    // covered by one rule instead of each remembering to ask. A no-op for English and for
    // covers with no localized variant (lib/i18n/blog-covers.js).
    const covered = localizeCoverUrls(stripped, locale.prefix ? locale.lang : '');
    const html = opts.postProcess ? opts.postProcess(covered, locale) : covered;
    renderCache.set(key, html);
    return html;
  }

  return { rawHtml, translations, render };
}
