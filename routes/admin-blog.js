// The admin console's blog-readership endpoint: how often each article under
// /blog/ is opened, and which ones are working.
//
// WHY IT IS A SEPARATE ROUTER FROM routes/admin.js. That file sits at its 650-line
// lint cap; the repo's answer to a full file is a sibling, not a raised ceiling —
// the same reason routes/admin-renders.js and routes/admin-api-usage.js exist, and
// it is mounted the same way.
//
// The two halves come from different places on purpose. The ARTICLE LIST is scanned
// out of public/blog/ by lib/content/blog-posts.js, so a newly published post shows
// up with no extra step; the COUNTS come from lib/data/blog-views.js, which the
// public router writes to as it serves each article. Joining them here means a post
// with no reads is still a row (the actionable one), and reads for a post that has
// since been deleted are still reported rather than silently dropped.

import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { listBlogPosts } from '../lib/content/blog-posts.js';

/** Window bounds the console may ask for. The reader buckets by day inside this. */
const MIN_DAYS = 7;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

/**
 * Build the admin blog-readership router.
 *
 * @param {{
 *   blogViews: { summary: (opts?: object) => object } | null,
 *   protectLogs: import('express').RequestHandler,
 *   __dirname: string,
 * }} deps - `blogViews` is OPTIONAL: absent, the route answers the article catalog
 *   with zeroed counts and `configured: false` rather than 503, so the tab says the
 *   counter is off instead of showing an error. Same contract as
 *   GET /api/admin/api-usage.
 * @returns {import('express').Router}
 */
export function createAdminBlogRouter(deps) {
  const { blogViews, protectLogs, __dirname } = deps;
  const router = createAsyncRouter();

  router.get('/api/admin/blog-views', protectLogs, (req, res) => {
    // Clamped, never rejected: a bad `days` is an operator typo in a URL, and the
    // useful response is the default window, not a 400. Same treatment as
    // GET /api/admin/referrals.
    const asked = Number(req.query.days);
    const days = Number.isFinite(asked)
      ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(asked)))
      : DEFAULT_DAYS;

    try {
      const posts = listBlogPosts(__dirname);
      if (!blogViews || typeof blogViews.summary !== 'function') {
        return res.json({
          configured: false,
          days,
          generatedAt: Date.now(),
          totals: { posts: posts.length, views: 0, botHits: 0, windowViews: 0, unread: posts.length, series: [] },
          posts: [],
        });
      }
      return res.json({ configured: true, ...blogViews.summary({ posts, days }) });
    } catch (error) {
      return sendError(res, 500, 'Failed to retrieve blog readership', {
        ref: reportError('admin.blogViews', error),
      });
    }
  });

  return router;
}

export default createAdminBlogRouter;
