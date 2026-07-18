// Localized-page routes: serve each indexable page under its language prefix
// (/es, /es/ai-designer.html, /fr/guides.html, …) with server-rendered translations.
//
// The English pages stay plain static files at the root; only the non-English
// locales are rendered here (English needs no translation pass). Rendering is a pure
// string transform (lib/i18n/render-page.js) and is memoized per (prefix, page) —
// the source HTML and language JSON are static, so first hit renders and every
// subsequent hit is an in-memory string send. Caches are process-lifetime; a deploy
// restarts the process, so a content/translation change is picked up on redeploy.
// DEBUG_MODE bypasses the caches for local dev (edit + refresh with no restart).

import path from 'path';
import fs from 'fs';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { LOCALES, LOCALIZED_PAGES } from '../lib/i18n/locales.js';
import { renderLocalizedPage } from '../lib/i18n/render-page.js';

/**
 * @param {{ __dirname: string, DEBUG_MODE: boolean }} deps
 * @returns {import('express').Router}
 */
export default function createI18nRouter({ __dirname, DEBUG_MODE }) {
  const router = createAsyncRouter();
  const publicDir = path.join(__dirname, 'public');

  /** @type {Map<string, string>} */
  const rawCache = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const jsonCache = new Map();
  /** @type {Map<string, string>} */
  const renderCache = new Map();

  /** @param {string} file */
  function rawHtml(file) {
    const cached = rawCache.get(file);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    rawCache.set(file, html);
    return html;
  }

  /** @param {string} lang */
  function translationsFor(lang) {
    const cached = jsonCache.get(lang);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const obj = JSON.parse(fs.readFileSync(path.join(publicDir, 'languages', `${lang}.json`), 'utf8'));
    jsonCache.set(lang, obj);
    return obj;
  }

  /**
   * @param {import('../lib/i18n/locales.js').Locale} locale
   * @param {import('../lib/i18n/locales.js').LocalizedPage} page
   */
  function render(locale, page) {
    const key = `${locale.prefix}:${page.path}`;
    const cached = renderCache.get(key);
    if (cached !== undefined && !DEBUG_MODE) return cached;
    const html = renderLocalizedPage({
      html: rawHtml(page.file),
      translations: translationsFor(locale.lang),
      locale,
      path: page.path,
    });
    renderCache.set(key, html);
    return html;
  }

  /**
   * @param {import('express').Response} res
   * @param {import('../lib/i18n/locales.js').Locale} locale
   * @param {import('../lib/i18n/locales.js').LocalizedPage} page
   */
  function serve(res, locale, page) {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(render(locale, page));
  }

  for (const locale of LOCALES) {
    for (const page of LOCALIZED_PAGES) {
      const url = page.path === '/' ? `/${locale.prefix}` : `/${locale.prefix}${page.path}`;
      router.get(url, (req, res) => serve(res, locale, page));
    }
    // /<prefix>/index.html isn't a canonical URL (nothing links to it) — 301 it to
    // /<prefix>. The trailing-slash form /<prefix>/ needs no redirect: Express's
    // non-strict routing already serves it from the /<prefix> route above, and the
    // page's self-referential canonical points search engines at /<prefix>.
    router.get(`/${locale.prefix}/index.html`, (req, res) => res.redirect(301, `/${locale.prefix}`));
  }

  return router;
}
