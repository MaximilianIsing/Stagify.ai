import './load-env.js'; // must be first: populates process.env from .env before any secret is read
// Sentry init runs via `node --import ./instrument.js` (see package.json), NOT a top-level import
// here: ESM loads the whole import graph — including express — before any module body executes, so
// an in-file import would call Sentry.init() too late to instrument express. --import runs it first.
import * as Sentry from '@sentry/node';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createCadHandling } from './lib/staging/cad-handling.js';
import { createAuthStore } from './lib/data/auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './lib/services/stripe-webhooks.js';
import { createEnterpriseStore } from './lib/data/enterprise-store.js';
import { createStripeEventLog } from './lib/data/stripe-events.js';
import { createUptimeMonitor } from './lib/data/uptime-monitor.js';
import { generateWithQualityRetry as runQualityRetry } from './lib/staging/staging-pipeline.js';
import createBillingRouter from './routes/billing.js';
import { createEmail } from './lib/services/email.js';
import { createLogging } from './lib/services/logging.js';
import { createMemory } from './lib/data/memory.js';
import { createUserDeletion } from './lib/data/user-deletion.js';
import { createBlobTombstones, createBlobReaper } from './lib/data/blob-tombstones.js';
import { createStagedRenders } from './lib/data/staged-renders.js';
import { createRenderRefs } from './lib/data/render-refs.js';
import { createGalleryShares } from './lib/data/gallery-shares.js';
import { getDb } from './lib/data/db.js';
import { createAdminMetrics } from './lib/analytics/admin-metrics.js';
import { createServiceHealth, healthFlags } from './lib/health/service-health.js';
import { checkBackupStatus } from './lib/health/backup-status.js';
import { createApiUsageStats } from './lib/analytics/api-usage.js';
import { createAdminBrief } from './lib/services/admin-brief.js';
import { createAdminAnalyst } from './lib/services/admin-analyst.js';
import createGalleryRouter from './routes/gallery.js';
import createSharePublicRouter from './routes/share-public.js';
import { createRenderPersistence } from './lib/staging/render-persistence.js';
import { createConfig } from './lib/config/config.js';
import { maskReferencePromptSuffix } from './lib/staging/prompts.js';
import { downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, downscaleImageForGPT, compositeForReview } from './lib/image/image-primitives.js';
import { createPublicStats } from './lib/data/public-stats.js';
import createPublicRouter from './routes/public.js';
import createI18nRouter from './routes/i18n.js';
import createReferralRouter from './routes/referrals.js';
import createObjectLocalRouter from './routes/object-local.js';
import createChatRouter from './routes/chat.js';
import createStagingRouter from './routes/staging.js';
import createAdminRouter from './routes/admin/index.js';
import { createAdminRendersRouter } from './routes/admin/renders.js';
import { createAdminApiUsageRouter } from './routes/admin/api-usage.js';
import { createAdminAnalystRouter } from './routes/admin/analyst.js';
import { createAdminBlogRouter } from './routes/admin/blog.js';
import { createAdminAccessRouter } from './routes/admin/access.js';
import createAuthRouter from './routes/auth.js';
import { DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, HIDE_STAGING_BANNER, SHOW_STAGING_BANNER, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS } from './lib/config/runtime-flags.js';
import createNotFoundHandler from './lib/http/not-found.js';
import { setSensitiveHeaders, sendError } from './lib/http/http-helpers.js';
import { getTemperatureForModel, getGeminiImageModel } from './lib/config/model-config.js';
import { createAuthHelpers } from './lib/services/auth-helpers.js';
import { getPromptCount, incPromptCount, getContactCount, incContactCount, initializePromptCount, initializeContactCount } from './lib/data/counters.js';
import { createObjectStore } from './lib/data/object-store.js';
import { createImageAnnotation } from './lib/image/image-annotation.js';
import { createImageReview } from './lib/image/image-review.js';
import { createErase } from './lib/image/erase.js';
import { createHostedImages } from './lib/image/hosted-images.js';
import { createHttpGuards } from './lib/http/http-guards.js';
import { createAiClients } from './lib/services/ai-clients.js';
import { stagingProcessUpload, chatUpload, hostImageUpload, HOSTED_IMAGE_MIME_EXT } from './lib/http/uploads.js';
import { authLimiter, emailLimiter, genLimiter, setRateLimitRejectionLogger } from './lib/http/rate-limiters.js';
import { logger } from './lib/logger.js';
import { applyEdgeMiddleware, applyBodyAndStatic } from './lib/http/app-middleware.js';
import { applyVanityRedirects } from './lib/http/vanity-redirects.js';
import { multerErrorHandler } from './lib/http/multer-errors.js';
import { createStagingGeneration } from './lib/staging/staging-generation.js';
import { createVirtualStagingHandler } from './lib/staging/virtual-staging-handler.js';
import { createExteriorHandler } from './lib/staging/exterior-handler.js';
import { createMaskingSaveHandler } from './lib/staging/masking-save-handler.js';
import { createLifecycleEmails } from './lib/services/lifecycle-emails.js';
import { createTrialLifecycle } from './lib/services/trial-lifecycle.js';
import { createEmailCatalog } from './lib/services/email-catalog.js';
import { createReferralLinks } from './lib/data/referral-links.js';
import { createBlogViews } from './lib/data/blog-views.js';
import { createEmailOptOut } from './lib/data/email-optout.js';
import { createAdminSessions } from './lib/data/admin-sessions.js';
import { createAdminAccess } from './lib/data/admin-access.js';
import { createApiKeys } from './lib/data/api-keys.js';
import { createApiBilling } from './lib/data/api-billing.js';
import { createApiKeyAuth } from './lib/http/api-key-auth.js';
import { createConcurrencyGate } from './lib/http/api-concurrency.js';
import { createApiRenderBilling } from './lib/staging/api-render-billing.js';
import createApiV1Router from './routes/api-v1.js';
import createApiKeysRouter from './routes/api-keys.js';
import { createCreditPacks } from './lib/data/credit-packs.js';
import { createStripeCreditTopup } from './lib/services/stripe-credit-topup.js';
import { errorMessage } from './lib/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { readStripeSecretKey, readStripeWebhookSecret, readStripePublishableKey, readEnterprisePriceId, readGoogleClientId, readGoogleClientSecret, readEndpointAccessKey, endpointKeyMatches, readEnterpriseMeterEventName, readApiCreditPriceIds } = createConfig();

const authStore = createAuthStore(__dirname);
const enterpriseStore = createEnterpriseStore(__dirname);
const uptimeMonitor = createUptimeMonitor(__dirname);
checkBackupStatus({ isStaging: IS_STAGING, logger, sentry: Sentry }); // alerts if prod booted without Litestream
// Webhook idempotency ledger — Stripe delivers at-least-once, so the billing
// router claims each event id here before handling it.
const stripeEvents = createStripeEventLog(__dirname);
// Campaign short-URLs (/columbia, …) and their click counters — see
// lib/data/referral-links.js for the registry that drives both the routes and the
// dashboard panel.
const referralLinks = createReferralLinks(__dirname);
// Blog readership. Written by the public router as it serves each article, read by
// the dashboard's Blog tab. See lib/data/blog-views.js for what is (and isn't) kept.
const blogViews = createBlogViews(__dirname);
// Who has unsubscribed from the trial-lifecycle emails, and the token that let
// them. Opened unconditionally: the sender needs it to mint a link on every send,
// erasure needs it to forget one, and the table is a row per mailed address.
const emailOptOut = createEmailOptOut(__dirname);
// Admin-console sessions: the operator trades the master key for a scoped,
// expiring, revocable token once, instead of retyping the key on every page load.
// See lib/data/admin-sessions.js for why the key itself is never persisted.
const adminSessions = createAdminSessions(__dirname);
// Who opens the console, from where, and what was refused. Built here rather than
// in the router because createHttpGuards below needs it: the denied half is
// recorded in the rejection funnel, not on a route. See lib/data/admin-access.js
// for why this is the one table in the app that keeps an IP indefinitely.
const adminAccess = createAdminAccess(__dirname);
// The public API: per-account keys and the prepaid credit balance they spend.
// Both are plain stores over the shared connection; nothing here reaches the network,
// so an unconfigured Stripe only means credits cannot be BOUGHT, not that the API
// breaks — an account with a balance keeps rendering.
const apiKeys = createApiKeys(__dirname);
const apiBilling = createApiBilling(__dirname);
// Where the gallery's BYTES live — R2 in production, the local disk in dev/CI, and
// deliberately DISABLED on Render when R2 is not configured rather than falling back
// to the app volume (see lib/data/object-store.js for why that branch exists).
// Never throws: a storage misconfiguration turns the gallery off and leaves staging
// untouched, the same posture scripts/start.sh takes for a missing Litestream setup.
const objectStore = createObjectStore({ baseDir: __dirname });
setInterval(() => authStore.pruneSessions(), 6 * 60 * 60 * 1000).unref?.();

const stripeSecretKey = readStripeSecretKey();
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

const stripeWebhookSecret = readStripeWebhookSecret();

const stripePublishableKey = readStripePublishableKey();

const enterprisePriceId = readEnterprisePriceId();

const googleClientId = readGoogleClientId();
const googleClientSecret = readGoogleClientSecret();
const googleOAuthClient = googleClientId
  ? new OAuth2Client(googleClientId, googleClientSecret || undefined)
  : null;
if (googleClientId) {
  logger.info('[google] OAuth client id loaded (Sign-In with Google enabled)');
}

// Staging-environment flags (IS_STAGING / HIDE_STAGING_BANNER / SHOW_STAGING_BANNER)
// → lib/config/runtime-flags.js (imported above). Boot log kept here so its ordering with
// the other startup lines is unchanged.
if (IS_STAGING) {
  logger.info(
    '[staging] IS_STAGING enabled — Google sign-in and Stripe checkout are disabled' +
      (HIDE_STAGING_BANNER ? ' (staging banner hidden)' : ''),
  );
}

const LOGS_ACCESS_KEY = readEndpointAccessKey();
if (LOGS_ACCESS_KEY) {
  logger.info('Endpoint access key successfully loaded');
} else {
  logger.error('Error: No endpoint access key found in file or environment variable');
}

const enterpriseMeterEventName = readEnterpriseMeterEventName();

// Auth/enterprise helpers (lib/services/auth-helpers.js), sharing this server's stores + Stripe.
const { getAuthUserFromRequest, toPublicAuthUser, enterpriseDomainForUser, reportEnterpriseUsage, recordStagingActivity, requireProAccount } = createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName });

// Home-page counters (rooms staged / contacts) live in lib/data/counters.js — imported above.

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);

// Middleware — security headers (helmet/CSP), CORS allow-list, and response
// compression → lib/http/app-middleware.js. Mounted BEFORE the billing router
// below, which needs the raw request body for Stripe signature verification.
applyEdgeMiddleware(app);

// Rate limiters (authLimiter / emailLimiter / genLimiter) → lib/http/rate-limiters.js
// (imported above). Pure config; each reads its RL_* env override at module load.

// AI/email clients (genAI / openai / resend) → lib/services/ai-clients.js.
// Constructed HERE (before the billing router) because the Stripe webhook drives
// the trial-email lifecycle, which needs the Resend client. genAI/openai are just
// held for the routers mounted further down.
const { genAI, openai, resend } = createAiClients({ DEBUG_MODE });
const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'team@stagify.ai').trim();
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || 'https://stagify.ai').replace(/\/$/, '');

// Trial-email lifecycle (welcome / activation / value / ending / win-back). The
// webhook fires the event-driven ones; trialLifecycle.start() (below, post-listen)
// runs the behaviour-based sweep.
const lifecycleEmails = createLifecycleEmails({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, appUrl: APP_URL, optOut: emailOptOut });
const trialLifecycle = createTrialLifecycle({ authStore, emails: lifecycleEmails });

// Email catalog (every user-facing email, built from the same renderers the senders
// use) powers the admin dashboard's Emails tab — preview gallery + "send test to me".
const emailCatalog = createEmailCatalog({ appUrl: APP_URL });

/**
 * Send a one-off copy of a catalog email to an admin-supplied address (the Emails
 * tab's "send test" button). Sends to the exact address requested — no
 * EMAIL_DEBUG_MODE redirect, because the operator is deliberately testing delivery
 * to themselves. Never throws; returns a { ok, status?, error? } shape.
 * @param {{ id: string, toEmail: string }} arg - Catalog id + recipient.
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
async function sendTestEmail({ id, toEmail }) {
  if (!resend) return { ok: false, status: 503, error: 'Email delivery is not configured on this server.' };
  const entry = emailCatalog.renderById(id);
  if (!entry) return { ok: false, status: 400, error: 'Unknown email template.' };
  try {
    const result = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject: `[Test] ${entry.subject}`,
      html: entry.html,
      text: entry.text,
    });
    if (result && result.error) {
      const msg = typeof result.error?.message === 'string' ? result.error.message : JSON.stringify(result.error);
      logger.error('[admin] test email send failed:', msg);
      return { ok: false, status: 502, error: 'The email provider rejected the send.' };
    }
    return { ok: true };
  } catch (err) {
    logger.error('[admin] test email send threw:', errorMessage(err));
    return { ok: false, status: 502, error: 'Could not send the test email.' };
  }
}

// API credit packs and the Stripe events that move a balance. Built here so the
// billing router below can dispatch a paid one-time session into it — credits are the
// one thing the webhook grants that is not a subscription.
const creditPacks = createCreditPacks(readApiCreditPriceIds());
const creditTopup = createStripeCreditTopup({ apiBilling, creditPacks, authStore });

// Billing & enterprise routes (routes/billing.js). Mounted BEFORE express.json
// below so the Stripe webhook can read the RAW request body for signature
// verification; the other billing routes carry their own inline express.json.
app.use(
  createBillingRouter({
    stripe,
    stripeWebhookSecret,
    stripePublishableKey,
    enterprisePriceId,
    authStore,
    enterpriseStore,
    handleStripeEvent,
    getAuthUserFromRequest,
    trialLifecycle,
    stripeEvents,
    creditTopup,
  })
);

// Short vanity URLs (/brand → /about.html#brand-kit). BEFORE the static middleware:
// public/brand/ is a real directory → lib/http/vanity-redirects.js explains why.
applyVanityRedirects(app);

// JSON body parsing (small/large per-route limits + the JSON SyntaxError/413
// handler) and static-asset serving → lib/http/app-middleware.js. Mounted AFTER
// the billing router so Stripe's webhook still sees the raw body; the JSON error
// handler stays registered immediately after the parser and before the routers.
// readPublicStats is the one reader behind every published copy of the usage figures —
// the injected HTML here, the locale renders, llms.txt and /api/stats.
const readPublicStats = createPublicStats({ authStore });
applyBodyAndStatic(app, { readPublicStats });

// Multer upload configs + HOSTED_IMAGE_MIME_EXT → lib/http/uploads.js (imported above).

// DEBUG_MODE / EMAIL_DEBUG_MODE / DEBUG_EMAIL and the stats overrides (STATS_DEBUG /
// DEBUG_ROOMS / DEBUG_USERS) are all computed once in lib/config/runtime-flags.js and
// imported at the top of this file — one source of truth shared with the extracted lib/
// modules. The boot log stays here so its ordering is unchanged.
if (STATS_DEBUG) {
  logger.debug(`Stats debug: ENABLED (rooms=${DEBUG_ROOMS}, users=${DEBUG_USERS})`);
}

// getTemperatureForModel / getGeminiImageModel → lib/config/model-config.js;
// setSensitiveHeaders → lib/http/http-helpers.js (imported at top). The AI/email clients
// (genAI / openai / resend) + RESEND_FROM_EMAIL / APP_URL are constructed above the
// billing router (the Stripe webhook needs the Resend client for the trial-email
// lifecycle). Reused here for the remaining routers.
const { getDataLogDir, escapeCsvField, logPromptToFile, logMaskEditToFile, logChatToFile, logRejectionToFile } = createLogging({ __dirname });
// The rate limiters are module singletons built at import time, before this factory
// exists, so they take the rejection writer through a setter rather than a dep.
setRateLimitRejectionLogger(logRejectionToFile);
// Passed to the auth/public routers WHOLE (as `email`) rather than torn into loose
// names — see docs/guides/architecture.md on the flat-vs-grouped dep split.
// `forgetEmailOpenState` is pulled back out because it is a createUserDeletion
// FACTORY input, not part of any router's surface.
const email = createEmail({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, escapeCsvField, getDataLogDir });
const { forgetEmailOpenState } = email;
const { loadMemories, saveMemories, exportAllMemories, resetAllMemories } = createMemory({ __dirname, DEBUG_MODE });
// GDPR erasure. Built here (not inside a store) because it spans every store's
// tables plus the CSV logs — see lib/data/user-deletion.js.
// The queue of object-store bytes owed a deletion, and the worker that drains it.
//
// An erasure commits the OBLIGATION to delete inside its synchronous transaction and
// returns; the bytes are in R2, so actually deleting them is async network work that
// must not hold the write lock, must not be able to fail a right-to-erasure request,
// and must survive the process dying. See lib/data/blob-tombstones.js.
const blobTombstones = createBlobTombstones(__dirname);
const blobReaper = createBlobReaper({ tombstones: blobTombstones, objectStore });
// The gallery's rows. Opened unconditionally — the tables are cheap and erasure needs
// them present either way — while the object store above decides whether anything is
// actually stored.
const stagedRenders = createStagedRenders(__dirname);
const renderRefs = createRenderRefs(__dirname);
const galleryShares = createGalleryShares(__dirname);
// Renders whose upload died mid-flight leave a `pending` row and possibly some orphan
// bytes. Hourly is well inside the one-hour staleness floor, and the floor is measured
// against each row's own created_at, so a restart cannot mark a live render failed.
setInterval(() => {
  try { stagedRenders.sweepStalePending(); } catch (error) { logger.error('[gallery] stale sweep failed:', error); }
}, 60 * 60 * 1000).unref?.();
// Same shape as the session prune above: a plain interval, unref'd so it cannot hold
// the process open. Erasure and eviction both kick a drain themselves; this is the
// backstop that finishes the work when R2 was down at the time.
setInterval(() => { void blobReaper.drain().catch(() => {}); }, 5 * 60 * 1000).unref?.();

const { deleteUser } = createUserDeletion({ baseDir: __dirname, getDataLogDir, forgetEmailOpenState, blobReaper });

// GPT-vision / Gemini helpers extracted to lib/, instantiated with this server's
// AI clients (the pure helpers they call are direct imports inside each module).
const { annotateImage } = createImageAnnotation({ openai });
const { reviewImageQuality, reviewMaskEdit, validateStageableImage, validateExteriorImage, compareRoomPhotos } = createImageReview({ genAI });
// Erase is verified on the Gemini comparative judge when configured, else OpenAI vision.
const { roomIsAlreadyEmpty, eraseFurniture } = createErase({ genAI, openai, compareRoomPhotos: genAI ? compareRoomPhotos : null });
// NO reviewer, on purpose — the quality gate is OFF for blueprint renders, and that is a
// measured decision rather than an oversight (cad-handling.js still accepts one, and the
// specs inject a fake, so re-enabling is a one-word change here).
//
// The gate's bargain is "retry until perfect, cheaply, because most renders pass first
// time". Blueprint renders do not pass. Measured on a clean five-room plan, both views ran
// the full 3 attempts and settled at 80/100, each time on a real but minor defect the
// reviewer named correctly (a floating bathtub; an armchair leg melting into the floor).
// So the gate degenerates from "usually one call" into "always three calls for best-of-3"
// — on gemini-3-pro-image (the CAD model at the time), the priciest model in the app, at ~57s per attempt.
//
// maxAttempts is deliberately left alone (see the same note in staging-generation.js): the
// loop only re-enters on a THROW, so a passing reviewer means ONE generation in the happy
// path while a transient provider error is still retried. That is the half of the retry
// worth keeping, and `maxAttempts: 1` would have thrown it away with the rest.
const { blueprintTo3D } = createCadHandling({ genAI });
// Passed to the admin/public routers WHOLE (as `hostedImages`), same rationale as
// `email` above. Note `getDataLogDir` going IN stays a loose factory input.
const hostedImages = createHostedImages({ getDataLogDir });
const healthDeps = { getDb: () => getDb(__dirname), objectStore, openai, stripe, resend, googleOAuthClient };
const { healthHandler, protectLogs, requireEndpointKey, stagingEndpointKeyGuard } = createHttpGuards({
  genAI, LOGS_ACCESS_KEY, endpointKeyMatches, adminSessions, adminAccess,
  healthFlags: () => healthFlags(healthDeps),
});

// Self-check quality gate: each render is reviewed (lib/image/image-review.js); a
// not-perfect one is regenerated up to this many times and the best-scored one ships.
// Interior staging is the exception: its review is advisory and only provider errors
// retry (see processStaging in lib/staging/staging-generation.js).
const QUALITY_MAX_ATTEMPTS = 3;

// The Gemini image-generation pipeline (the quality-gate retry wrapper +
// text-to-image + virtual staging) → lib/staging/staging-generation.js, bound to
// this server's AI clients + reviewers. generateWithQualityRetry keeps its
// positional shape for the router dep-objects below.
const { generateWithQualityRetry, processImageGeneration, processStaging } = createStagingGeneration({
  genAI,
  DEBUG_MODE,
  runQualityRetry,
  reviewImageQuality,
  QUALITY_MAX_ATTEMPTS,
  logPromptToFile,
});

// ── Public image hosting (admin-managed) ───────────────────────────────────
// Admins upload an image from the dashboard; it's stored on the persistent disk
// and served publicly at /i/<id> behind an unguessable random id. A manifest
// (index.json) records the metadata so the dashboard can list and unhost them.
// HOSTED_IMAGE_MIME_EXT + hostImageUpload (multer) → lib/http/uploads.js (imported above).
// Hosted-image store + manifest → lib/image/hosted-images.js (instantiated above).

// NOTE: the multer upload-error handler lives AFTER the routers (see below), because
// all multer middleware runs inside routes/*.js and Express only reaches an error
// handler registered after the throwing route.

// The virtual-staging multipart handler → lib/staging/virtual-staging-handler.js.
// Instantiated AFTER createStagingGeneration because it consumes processStaging.
// Turns a finished render into a gallery entry: rows synchronously so the free-tier cap
// is unraceable, bytes afterwards so nobody waits on an object store for a history
// feature. A no-op whenever the object store is unconfigured.
const renderPersistence = createRenderPersistence({ objectStore, stagedRenders, renderRefs, blobReaper });

const { handleVirtualStagingMultipart } = createVirtualStagingHandler({
  genAI,
  DEBUG_MODE,
  authStore,
  toPublicAuthUser,
  enterpriseDomainForUser,
  reportEnterpriseUsage,
  recordStagingActivity,
  logRejectionToFile,
  roomIsAlreadyEmpty,
  eraseFurniture,
  processStaging,
  renderPersistence,
});

// The Exterior Studio handler → lib/staging/exterior-handler.js. Also instantiated AFTER
// createStagingGeneration, and for the same reason: it consumes processStaging.
const { handleExteriorMultipart } = createExteriorHandler({
  genAI,
  DEBUG_MODE,
  authStore,
  toPublicAuthUser,
  enterpriseDomainForUser,
  reportEnterpriseUsage,
  recordStagingActivity,
  validateExteriorImage,
  processStaging,
  renderPersistence,
});

// The Masking Studio's save → lib/staging/masking-save-handler.js. Takes renderPersistence
// and nothing else: it neither calls a model nor resolves an account, because the composite
// arrives already made and the router has already established the Stagify+ user.
//
// Pre-built here, like the two handlers above, so the staging router never receives
// renderPersistence itself — which is what makes it structurally impossible for
// createMaskEditHandler to reach the gallery.
const { handleMaskingSave } = createMaskingSaveHandler({ renderPersistence });

// Health check endpoints
// healthHandler / protectLogs / stagingEndpointKeyGuard → lib/http/http-guards.js (instantiated above).

const MAX_MASK_PROMPT_LENGTH = 1000;

// --- AI-assisted selection (Masking Studio) ----------------------------------
// Gemini box detection (SEGMENT_MODEL, lib/staging/segment.js): given a room photo
// and an optional natural-language target ("the sofa", "the empty floor area"),
// returns labelled bounding boxes (no pixel masks). With no target it boxes every
// distinct object, which the client caches and hit-tests so each wand click is
// instant. box_2d is [y0, x0, y1, x1] normalized to 0-1000 of the image sent here,
// so the client maps boxes onto its full-resolution canvas without knowing our dimensions.
const MAX_SEGMENT_QUERY_LENGTH = 200;

// auth routes (routes/auth.js)
app.use(createAuthRouter({ authStore, googleOAuthClient, resend, LOGS_ACCESS_KEY, authLimiter, emailLimiter, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, SHOW_STAGING_BANNER, endpointKeyMatches, setSensitiveHeaders, getAuthUserFromRequest, toPublicAuthUser, email, __dirname, googleClientId }));

// admin routes (routes/admin/index.js)
//
// adminMetrics is built here rather than inside the router because it prepares
// its statements once, at construction — see the N+1 guard in
// test/analytics/admin-metrics.test.js. It must come AFTER the gallery stores
// above, which are what create the tables it prepares against.
const adminMetrics = createAdminMetrics({ db: getDb(__dirname), getDataLogDir });
const adminBrief = createAdminBrief({ openai });
// Per-subsystem health for /status and the console's status tab. Built here because it
// needs adminMetrics above; `getInFlight` is read through a closure because the API
// concurrency gate is created further down (nothing calls it until a request arrives).
const serviceHealth = createServiceHealth({
  ...healthDeps, genAI,
  getHealthCounters: () => adminMetrics.healthCounters(),
  getInFlight: () => apiInFlight(),
  concurrencyLimit: Number(process.env.API_CONCURRENCY_GLOBAL || 12),
});
// The Signals drawer's analyst. Same client, opposite instrument: the brief restates
// findings that are already computed, this one answers a question by calling tools
// the browser then runs against the data it already holds.
const adminAnalyst = createAdminAnalyst({ openai });
// Site-wide reads of the public render API, for the console's API usage tab. Built
// here for the same reason adminMetrics is: it prepares its statements once, at
// construction, so it must come after the stores that create the tables it reads.
const apiUsageStats = createApiUsageStats({ db: getDb(__dirname) });
// The render inspector rides beside the admin router rather than inside it —
// routes/admin/index.js is at its line cap. Same guard, same tab, separate file.
app.use(createAdminRendersRouter({ stagedRenders, objectStore, protectLogs, setSensitiveHeaders }));
// Same reasoning again: routes/admin/index.js is full, so the API usage tab's one endpoint
// rides beside it rather than inside it.
app.use(createAdminApiUsageRouter({ apiUsageStats, protectLogs, setSensitiveHeaders }));
// And once more: the analyst drawer's single endpoint is a sibling for the same
// reason. It is reachable from every tab, so it is wired beside the router rather
// than inside the Signals tab's.
app.use(createAdminAnalystRouter({ adminAnalyst, protectLogs, setSensitiveHeaders }));
app.use(createAdminBlogRouter({ blogViews, protectLogs, __dirname }));
// MUST stay above createAdminRouter: it records GET /api/admin/ping by matching it
// first and falling through to the real handler there. See routes/admin/access.js.
app.use(createAdminAccessRouter({ adminAccess, protectLogs }));
app.use(createAdminRouter({ authStore, uptimeMonitor, serviceHealth, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, deleteUser, getDataLogDir, hostedImages, protectLogs, requireEndpointKey, adminSessions, __dirname, HOSTED_IMAGE_MIME_EXT, emailCatalog, sendTestEmail, referralLinks, adminMetrics, adminBrief, adminAccess }));

// staging routes (routes/staging.js)
app.use(createStagingRouter({ genAI, genLimiter, stagingProcessUpload, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, reportEnterpriseUsage, recordStagingActivity, requireProAccount, logMaskEditToFile, logRejectionToFile, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, handleExteriorMultipart, handleMaskingSave, stagingEndpointKeyGuard }));

// public developer API (routes/api-v1.js)
//
// Constructed HERE rather than inside the router because the billing band wraps
// handleVirtualStagingMultipart, which is itself built above — the same ordering
// constraint createVirtualStagingHandler has against processStaging.
const { requireApiKey } = createApiKeyAuth({ apiKeys, authStore, apiBilling });
// 3 per key / 12 per process. The per-key figure is what stops one customer's batch
// script monopolising the box; the global one is what stops twelve customers doing it
// collectively. Both are far below what a queue would allow, which is the trade a
// synchronous API makes on purpose.
const { gate: apiConcurrencyGate, inFlight: apiInFlight } = createConcurrencyGate({
  limit: Number(process.env.API_CONCURRENCY_PER_KEY || 3),
  globalLimit: Number(process.env.API_CONCURRENCY_GLOBAL || 12),
  onReject: (req, scope) => logRejectionToFile('api_concurrency', 'CONCURRENCY_LIMIT', scope, { req }),
});
const { runBilledRender } = createApiRenderBilling({ apiBilling, handleVirtualStagingMultipart });
app.use(createApiKeysRouter({
  apiKeys,
  apiBilling,
  creditPacks,
  stripe,
  getAuthUserFromRequest,
}));
app.use(createApiV1Router({
  apiBilling,
  requireApiKey,
  concurrencyGate: apiConcurrencyGate,
  stagingProcessUpload,
  runBilledRender,
}));

// chat routes (routes/chat.js)
app.use(createChatRouter({ openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, recordStagingActivity, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, annotateImage, downscaleImageForGPT, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount, renderPersistence }));

// localized-page routes (routes/i18n.js) — /es, /fr/ai-designer.html, … rendered
// server-side from the language JSON. Mounted before the public router; its prefixes
// (/es, /fr, …) are disjoint from every other route and from the static files.
app.use(createI18nRouter({ __dirname, DEBUG_MODE, blogViews, readPublicStats }));

// public routes (routes/public.js)
app.use(createPublicRouter({ authStore, readPublicStats, uptimeMonitor, serviceHealth, resend, LOGS_ACCESS_KEY, endpointKeyMatches, emailLimiter, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, hostedImages, email, healthHandler, getPromptCount, getContactCount, incContactCount , blogViews, emailOptOut, __dirname }));

// The owner's gallery (routes/gallery.js) and the public share page
// (routes/share-public.js). Two routers rather than one because they answer to very
// different callers: a signed-in account, and an anonymous stranger holding a token.
app.use(createGalleryRouter({
  stagedRenders, renderRefs, shares: galleryShares, objectStore, getAuthUserFromRequest,
  appOrigin: process.env.APP_ORIGIN || '',
}));
app.use(createSharePublicRouter({
  shares: galleryShares, stagedRenders, objectStore, __dirname,
}));

// Local gallery blobs (routes/object-local.js) — DEV AND CI ONLY, and mounted only
// when the local backend actually answered. In production R2 presigns straight at the
// bucket, so no render byte passes through this process; that is the whole reason the
// bytes are not on the app disk. Mounting it unconditionally would create a
// same-origin byte route in production that nothing needs and everything could grow to
// depend on.
if (objectStore.backend === 'local') {
  app.use(createObjectLocalRouter({ objectStore: /** @type {any} */ (objectStore) }));
}

// Referral/campaign short-URLs (routes/referrals.js) — /columbia and anything else
// created from the dashboard count the arrival and 302 to the home page.
//
// MOUNTED LAST, after every other router, and that placement is load-bearing: links
// are operator-created data, so this router matches `/:slug` and looks the slug up
// per request. Here it only ever sees paths nothing else claimed, which is what
// makes it impossible for a dashboard-created link to shadow a real page. Anything
// it does not recognise falls through to the branded 404 below.
app.use(createReferralRouter({ referralLinks }));

// Nothing claimed the path — serve the branded 404 (lib/http/not-found.js). It sits
// after every router by definition, and is a plain handler rather than a router so it
// does not disturb the "referral router is mounted last" guard above.
//
// This must be a NORMAL middleware, not a 4-arg error handler: Express only reaches
// those via next(err), and an unmatched route never produces one.
app.use(createNotFoundHandler({ __dirname, DEBUG_MODE }));

// Multer upload errors surface here — AFTER the routers that use multer, so Express
// actually reaches this handler (it only runs error middleware registered after the
// throwing route). Placed BEFORE the Sentry handler so an over-cap upload returns a
// clean 413 and doesn't get reported as a server error. The mapping itself lives in
// lib/http/multer-errors.js; this line owns only its position in the chain.
app.use(multerErrorHandler);

// Sentry Express error handler — after ALL routes so it can capture errors thrown in
// them. Captures the error, then passes it through unchanged (no effect on responses).
// No-op when SENTRY_DSN is unset.
Sentry.setupExpressErrorHandler(app);

// Final catch-all error handler — MUST be last. Without it, any error that reaches
// Express's pipeline (a synchronous throw in a handler, or any next(err)) falls
// through to Express's built-in default handler, which — because NODE_ENV isn't
// 'production' here — renders the full stack trace as an HTML page to the client.
// This returns a clean JSON 500 instead. The res.headersSent guard hands off to
// Express so an error mid-stream (e.g. the chat SSE route) still aborts correctly
// rather than trying to write a second set of headers.
app.use(/** @type {import('express').ErrorRequestHandler} */ ((err, req, res, next) => {
  if (res.headersSent) return next(err);
  logger.error('Unhandled route error:', err);
  sendError(res, err.status || err.statusCode || 500, 'Internal server error');
}));

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`AI configured: ${!!genAI}`);

  // Begin the uptime heartbeat (and record any downtime gap since the last run).
  // Skipped under tests so the suite doesn't write real uptime state or leave a
  // timer/self-check running.
  if (process.env.NODE_ENV !== 'test') {
    try {
      uptimeMonitor.start();
    } catch (err) {
      logger.error('Uptime monitor failed to start:', errorMessage(err));
    }

    // Prime the per-subsystem checks and keep them warm, so the first visitor to
    // /status sees verdicts rather than "checking…".
    try {
      serviceHealth.start();
    } catch (err) {
      logger.error('Service health checks failed to start:', errorMessage(err));
    }

    // Behaviour-based trial emails (activation nudge + mid-trial value). The
    // event-driven ones fire from the Stripe webhook; this sweep covers the two
    // that depend on trial age + whether the user has staged yet.
    try {
      trialLifecycle.start();
    } catch (err) {
      logger.error('Trial-lifecycle sweep failed to start:', errorMessage(err));
    }
  }

  // Initialize prompt count on server startup
  initializePromptCount();
  // Initialize contact count on server startup
  initializeContactCount();
});
