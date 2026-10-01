// The admin console's wiring: every router behind /api/admin/*, and the admin-only
// services they read, mounted in one place.
//
// The console is one routers-per-tab family. routes/admin/index.js holds the core
// (sign-in, data exports, account actions); each sibling owns one tab or drawer with
// its own data source and its own rules (hosted-images, status, signals, emails,
// referrals, renders, api-usage, analyst, blog, access). Mounting them here keeps that domain together
// and out of server.js, which only hands over the shared stores and guards.
//
// What stays in server.js on purpose: adminMetrics and serviceHealth. serviceHealth
// also feeds the public /status page and is started after listen(), and it reads
// adminMetrics' counters, so both belong to the composition root and arrive as deps.

import createAdminRouter from './index.js';
import { createAdminRendersRouter } from './renders.js';
import { createAdminApiUsageRouter } from './api-usage.js';
import { createAdminAnalystRouter } from './analyst.js';
import { createAdminBlogRouter } from './blog.js';
import { createAdminAccessRouter } from './access.js';
import { createAdminHostedImagesRouter } from './hosted-images.js';
import { createAdminStatusRouter } from './status.js';
import { createAdminSignalsRouter } from './signals.js';
import { createAdminEmailsRouter } from './emails.js';
import { createAdminReferralsRouter } from './referrals.js';
import { createAdminBrief } from '../../lib/services/admin-brief.js';
import { createAdminAnalyst } from '../../lib/services/admin-analyst.js';
import { createApiUsageStats } from '../../lib/analytics/api-usage.js';

/**
 * Every router's deps in one bag: each factory destructures only its own keys.
 * @typedef {Parameters<typeof createAdminRouter>[0]
 *   & Parameters<typeof createAdminHostedImagesRouter>[0]
 *   & Parameters<typeof createAdminStatusRouter>[0]
 *   & Omit<Parameters<typeof createAdminSignalsRouter>[0], 'adminBrief'>
 *   & Parameters<typeof createAdminEmailsRouter>[0]
 *   & Parameters<typeof createAdminReferralsRouter>[0]
 * } AdminDeps
 */

/**
 * Build the admin-only services and mount every admin router on `app`.
 *
 * @param {import('express').Express} app
 * @param {AdminDeps & {
 *   openai: Parameters<typeof createAdminBrief>[0]['openai'],
 *   db: Parameters<typeof createApiUsageStats>[0]['db'],
 *   stagedRenders: Parameters<typeof createAdminRendersRouter>[0]['stagedRenders'],
 *   objectStore: Parameters<typeof createAdminRendersRouter>[0]['objectStore'],
 *   blogViews: Parameters<typeof createAdminBlogRouter>[0]['blogViews'],
 * }} deps - The routers' shared deps, plus the stores the services and the
 *   renders/blog routers read.
 * @returns {void}
 */
export function mountAdminConsole(app, deps) {
  const { openai, db, stagedRenders, objectStore, blogViews, ...adminDeps } = deps;
  const { protectLogs, setSensitiveHeaders, adminAccess, __dirname } = adminDeps;

  // The Signals tab's brief and the analyst drawer share one client but are opposite
  // instruments: the brief restates findings already computed, the analyst answers a
  // question by calling tools the browser runs against data it already holds.
  const adminBrief = createAdminBrief({ openai });
  const adminAnalyst = createAdminAnalyst({ openai });
  // Prepares its statements once, at construction, so it must be built after the
  // stores that create the tables it reads (server.js opens those first).
  const apiUsageStats = createApiUsageStats({ db });

  app.use(createAdminRendersRouter({ stagedRenders, objectStore, protectLogs, setSensitiveHeaders }));
  app.use(createAdminApiUsageRouter({ apiUsageStats, protectLogs, setSensitiveHeaders }));
  // Reachable from every tab, so it is its own router rather than part of Signals.
  app.use(createAdminAnalystRouter({ adminAnalyst, protectLogs, setSensitiveHeaders }));
  app.use(createAdminBlogRouter({ blogViews, protectLogs, __dirname }));
  // MUST stay above createAdminRouter: it records GET /api/admin/ping by matching it
  // first and falling through to the real handler there. See routes/admin/access.js;
  // test/server/router-mount-order.test.js enforces the order.
  app.use(createAdminAccessRouter({ adminAccess: adminAccess ?? null, protectLogs }));
  app.use(createAdminHostedImagesRouter(adminDeps));
  app.use(createAdminStatusRouter(adminDeps));
  app.use(createAdminSignalsRouter({ ...adminDeps, adminBrief }));
  app.use(createAdminEmailsRouter(adminDeps));
  app.use(createAdminReferralsRouter(adminDeps));
  app.use(createAdminRouter(adminDeps));
}
