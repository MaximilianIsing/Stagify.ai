// Localized-page routes: serve each indexable page under its language prefix
// (/es, /es/ai-designer.html, /fr/guides.html, …) with server-rendered translations.
//
// The English pages stay plain static files at the root; only the non-English
// locales are rendered here (English needs no translation pass). Rendering is a pure
// string transform (lib/i18n/render-page.js), memoized per (prefix, page) by
// lib/i18n/page-renderer.js — see that file for the caching contract.

import path from 'path';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { LOCALES, LOCALIZED_PAGES } from '../lib/i18n/locales.js';
import { createPageRenderer } from '../lib/i18n/page-renderer.js';

/**
 * English paths that were once in LOCALIZED_PAGES and have since been de-localized.
 * Each still has live /<prefix>/… URLs out in Google's index, so every locale gets a
 * 301 back to the English page rather than a 404. Entries stay here permanently —
 * removing one resurrects the dead URLs, it doesn't clean anything up.
 * @type {string[]}
 */
const RETIRED_LOCALIZED_PATHS = ['/terms.html', '/privacy.html'];

/**
 * @param {{ __dirname: string, DEBUG_MODE: boolean }} deps
 * @returns {import('express').Router}
 */
export default function createI18nRouter({ __dirname, DEBUG_MODE }) {
  const router = createAsyncRouter();
  const renderer = createPageRenderer({ publicDir: path.join(__dirname, 'public'), DEBUG_MODE });

  /**
   * @param {import('express').Response} res
   * @param {import('../lib/i18n/locales.js').Locale} locale
   * @param {import('../lib/i18n/locales.js').LocalizedPage} page
   */
  function serve(res, locale, page) {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderer.render(locale, page));
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

    // Pages that USED to be localized and no longer are (see RETIRED_LOCALIZED_PATHS).
    // Without this they'd fall through to Express's default 404, because there is no
    // custom 404 handler — and these URLs were in the sitemap for long enough to be
    // indexed. 301 preserves the link equity against the surviving English page.
    for (const retired of RETIRED_LOCALIZED_PATHS) {
      router.get(`/${locale.prefix}${retired}`, (req, res) => res.redirect(301, retired));
    }
  }

  return router;
}
