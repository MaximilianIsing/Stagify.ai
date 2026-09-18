// Localized-page routes: serve each indexable page under its language prefix
// (/es, /es/ai-designer.html, /fr/guides.html, …) with server-rendered translations.
//
// The English pages stay plain static files at the root; only the non-English
// locales are rendered here (English needs no translation pass). Rendering is a pure
// string transform (lib/i18n/render-page.js), memoized per (prefix, page) by
// lib/i18n/page-renderer.js — see that file for the caching contract.

import path from 'path';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { BLOG_HUB, LOCALES, LOCALIZED_PAGES, LOCALIZED_PATHS } from '../lib/i18n/locales.js';
import { createPageRenderer } from '../lib/i18n/page-renderer.js';
import {
  articleLocales,
  articlesForLocale,
  HUB_PACK_DIR,
  localesForHub,
  packDirFor,
  slugsForLocale,
} from '../lib/i18n/blog-packs.js';
import { pruneHubForLocale, withCardReadTimes } from '../lib/i18n/blog-hub.js';
import { markCurrentLang } from '../lib/i18n/blog-langs.js';
import { logger } from '../lib/logger.js';

/**
 * English paths that were once in LOCALIZED_PAGES and have since been de-localized.
 * Each still has live /<prefix>/… URLs out in Google's index, so every locale gets a
 * 301 back to the English page rather than a 404. Entries stay here permanently —
 * removing one resurrects the dead URLs, it doesn't clean anything up.
 * @type {string[]}
 */
const RETIRED_LOCALIZED_PATHS = ['/terms.html', '/privacy.html'];

/**
 * @param {{ __dirname: string, DEBUG_MODE: boolean, blogViews?: any }} deps
 *   `blogViews` is optional and may throw: it is a counter, and a reader must never lose
 *   their article to it. Same contract routes/public.js keeps for the English copies.
 * @returns {import('express').Router}
 */
export default function createI18nRouter({ __dirname, DEBUG_MODE, blogViews = null }) {
  const router = createAsyncRouter();
  const renderer = createPageRenderer({ publicDir: path.join(__dirname, 'public'), DEBUG_MODE });

  /**
   * @param {import('express').Response} res
   * @param {import('../lib/i18n/locales.js').Locale} locale
   * @param {import('../lib/i18n/locales.js').LocalizedPage | Parameters<
   *   ReturnType<typeof createPageRenderer>['render']>[1]} page
   */
  function serve(res, locale, page) {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderer.render(locale, page));
  }

  /**
   * Count one localized article open, under the SAME slug as its English original.
   *
   * Never throws, and never costs the reader their article — routes/public.js keeps the
   * same contract for the English copies, and test/routes/public-pages-route.test.js
   * documents it.
   *
   * @param {import('express').Request} req
   * @param {string} slug
   * @param {import('../lib/i18n/locales.js').Locale} locale
   */
  function countRead(req, slug, locale) {
    if (!blogViews || typeof blogViews.recordView !== 'function') return;
    try {
      blogViews.recordView({
        slug,
        locale: locale.lang,
        referer: req.get('referer'),
        userAgent: req.get('user-agent'),
      });
    } catch (err) {
      logger.error('[i18n] could not count a view of', `${locale.prefix}/${slug}`, '-', err && err.message ? err.message : err);
    }
  }

  for (const locale of LOCALES) {
    // Which paths this locale can link to: the marketing set, plus its blog hub and only
    // the articles it actually has a pack for. Computed before the marketing pages are
    // registered because THEY need it too — a footer "Blog" link on /es that resolves to
    // the English /blog/ drops the reader out of their language mid-session, and leaves
    // the localized blog reachable only from the sitemap. An article this language lacks
    // stays an English link, which is correct: the alternative is a 404.
    const available = slugsForLocale(locale.prefix);
    const localizedPaths = new Set([
      ...LOCALIZED_PATHS,
      ...(available.size ? [BLOG_HUB.path, ...articlesForLocale(locale.prefix).map((a) => a.path)] : []),
    ]);

    for (const page of LOCALIZED_PAGES) {
      const url = page.path === '/' ? `/${locale.prefix}` : `/${locale.prefix}${page.path}`;
      // Spread rather than mutate: LOCALIZED_PAGES is shared config, and the renderer
      // memoises per (prefix, file, path) so the wrapper costs one object per route.
      const localized = { ...page, localizedPaths };
      // The home page's blog teaser shows six of the hub's cards, so it reads the HUB pack
      // rather than carrying its own copy of six titles in all eleven site packs. Those
      // strings are already translated, and duplicating them is how they drift apart.
      if (page.path === '/' && available.size) {
        Object.assign(localized, {
          packDir: HUB_PACK_DIR,
          packKey: 'hub',
          packTransform: withCardReadTimes,
        });
      }
      router.get(url, (req, res) => serve(res, locale, localized));
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

    // The blog. Unlike the pages above, an article is localized per LANGUAGE rather than
    // all-or-nothing, so this registers exactly the (locale, article) pairs that have a
    // translation pack on disk — see lib/i18n/blog-packs.js. Everything else falls through
    // to the 404 handler, which renders in the right locale by itself, so a URL exists if
    // and only if the translation behind it does. A /:prefix/blog/:slug param route would
    // instead answer for every slug and need its own 404 branch.
    if (available.size === 0) continue;

    for (const article of articlesForLocale(locale.prefix)) {
      const page = {
        path: article.path,
        file: article.file,
        packDir: packDirFor(article.slug),
        localizedPaths,
        // The article's own crumb is its title, which lives in its pack — it has no key
        // in the eleven shared packs the way every LOCALIZED_PAGES crumb must.
        crumbKeys: new Map([[BLOG_HUB.path, 'navigation.blog'], [article.path, 'post.crumb']]),
        locales: articleLocales(article.slug),
        // The language nav is baked into the English file with English marked current; a
        // localized render is the same nav with the marker moved. See lib/i18n/blog-langs.js.
        postProcess: (html) => markCurrentLang(html, locale.hreflang),
      };
      router.get(`/${locale.prefix}${article.path}`, (req, res) => {
        countRead(req, article.slug, locale);
        serve(res, locale, page);
      });
    }

    const hubPage = {
      path: BLOG_HUB.path,
      file: BLOG_HUB.file,
      packDir: HUB_PACK_DIR,
      packKey: 'hub',
      localizedPaths,
      crumbKeys: new Map([[BLOG_HUB.path, 'navigation.blog']]),
      locales: localesForHub(),
      // The grid is one file shared by every locale, so the cards for articles this
      // language has no pack for have to come out — following one would 404, because the
      // route behind it is never registered. See lib/i18n/blog-hub.js.
      postProcess: (html) => markCurrentLang(pruneHubForLocale(html, available, locale.prefix), locale.hreflang),
    };
    // Registered without the trailing slash: Express's non-strict routing answers both
    // /es/blog and /es/blog/, and the page's self-referential canonical names the
    // trailing-slash form, which is what the sitemap lists.
    router.get(`/${locale.prefix}/blog`, (req, res) => serve(res, locale, hubPage));
    router.get(`/${locale.prefix}/blog/index.html`, (req, res) =>
      res.redirect(301, `/${locale.prefix}/blog/`));
  }

  return router;
}
