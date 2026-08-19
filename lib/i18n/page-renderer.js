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
   * The parsed public/languages/<lang>.json pack.
   * @param {string} lang
   * @returns {Record<string, any>}
   */
  function translations(lang) {
    const cached = jsonCache.get(lang);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const obj = JSON.parse(fs.readFileSync(path.join(publicDir, 'languages', `${lang}.json`), 'utf8'));
    jsonCache.set(lang, obj);
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
   * @param {import('./locales.js').Locale} locale
   * @param {import('./locales.js').LocalizedPage | { path: string, file: string }} page
   * @returns {string}
   */
  function render(locale, page) {
    const key = `${locale.prefix}:${page.file}:${page.path}`;
    const cached = renderCache.get(key);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const rendered = renderLocalizedPage({
      html: rawHtml(page.file),
      translations: translations(locale.lang),
      locale,
      path: page.path,
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
    const html = DEBUG_MODE ? rendered : stripHtmlComments(rendered);
    renderCache.set(key, html);
    return html;
  }

  return { rawHtml, translations, render };
}
