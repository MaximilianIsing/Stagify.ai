import './load-env.js'; // must be first: populates process.env from .env before any secret is read
// Sentry init runs via `node --import ./instrument.js` (see package.json), NOT a top-level import
// here: ESM loads the whole import graph — including express — before any module body executes, so
// an in-file import would call Sentry.init() too late to instrument express. --import runs it first.
import * as Sentry from '@sentry/node';
import express from 'express';
import multer from 'multer';
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
import { createConfig } from './lib/config/config.js';
import { maskReferencePromptSuffix } from './lib/staging/prompts.js';
import { downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, downscaleImageForGPT, compositeForReview } from './lib/image/image-primitives.js';
import createPublicRouter from './routes/public.js';
import createI18nRouter from './routes/i18n.js';
import createReferralRouter from './routes/referrals.js';
import createChatRouter from './routes/chat.js';
import createStagingRouter from './routes/staging.js';
import createAdminRouter from './routes/admin.js';
import createAuthRouter from './routes/auth.js';
import { DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, HIDE_STAGING_BANNER, SHOW_STAGING_BANNER, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS } from './lib/config/runtime-flags.js';
import { setSensitiveHeaders, sendError } from './lib/http/http-helpers.js';
import { getTemperatureForModel, getGeminiImageModel } from './lib/config/model-config.js';
import { createAuthHelpers } from './lib/services/auth-helpers.js';
import { getPromptCount, incPromptCount, getContactCount, incContactCount, initializePromptCount, initializeContactCount } from './lib/data/counters.js';
import { createImageAnnotation } from './lib/image/image-annotation.js';
import { createImageReview } from './lib/image/image-review.js';
import { createErase } from './lib/image/erase.js';
import { createHostedImages } from './lib/image/hosted-images.js';
import { createHttpGuards } from './lib/http/http-guards.js';
import { createAiClients } from './lib/services/ai-clients.js';
import { stagingProcessUpload, chatUpload, hostImageUpload, HOSTED_IMAGE_MIME_EXT } from './lib/http/uploads.js';
import { authLimiter, emailLimiter, genLimiter, shareLimiter } from './lib/http/rate-limiters.js';
import { logger } from './lib/logger.js';
import { applyEdgeMiddleware, applyBodyAndStatic } from './lib/http/app-middleware.js';
import { createStagingGeneration } from './lib/staging/staging-generation.js';
import { createVirtualStagingHandler } from './lib/staging/virtual-staging-handler.js';
import { createLifecycleEmails } from './lib/services/lifecycle-emails.js';
import { createTrialLifecycle } from './lib/services/trial-lifecycle.js';
import { createEmailCatalog } from './lib/services/email-catalog.js';
import { createReferralLinks } from './lib/data/referral-links.js';
import { createProjects } from './lib/data/projects.js';
import { createProjectStorage } from './lib/data/project-storage.js';
import { createDesignBible } from './lib/staging/design-bible.js';
import { createRoomClustering, assignRoomKeys, pickHero } from './lib/staging/room-clustering.js';
import { createListingWorker } from './lib/staging/listing-worker.js';
import createProjectsRouter from './routes/projects.js';
import createSharePublicRouter from './routes/share-public.js';
import { createProjectBlobGc } from './lib/data/project-blob-gc.js';
import { createProjectInsights } from './lib/data/project-insights.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { readStripeSecretKey, readStripeWebhookSecret, readStripePublishableKey, readEnterprisePriceId, readGoogleClientId, readGoogleClientSecret, readEndpointAccessKey, endpointKeyMatches, readEnterpriseMeterEventName } = createConfig({ __dirname });

const authStore = createAuthStore(__dirname);
const enterpriseStore = createEnterpriseStore(__dirname);
const uptimeMonitor = createUptimeMonitor(__dirname);
// Webhook idempotency ledger — Stripe delivers at-least-once, so the billing
// router claims each event id here before handling it.
const stripeEvents = createStripeEventLog(__dirname);
// Campaign short-URLs (/columbia, …) and their click counters — see
// lib/data/referral-links.js for the registry that drives both the routes and the
// dashboard panel.
const referralLinks = createReferralLinks(__dirname);
// Listing Studio: the projects/photos/bibles/renders store plus the blob store the
// images themselves live in. Constructed here with the other stores so the tables exist
// before anything (notably the GDPR erasure below) reaches for them. The blob store is
// deliberately separate from SQLite — a 30-photo listing's renders and, far bigger, its
// source photographs have no business in a single-writer DB that Litestream replicates
// row by row.
//
// WRAPPED, unlike its neighbours, and that asymmetry is deliberate. The store prepares its
// statements at construction, so a `renders` table missing a column this build expects
// throws `no such column: …` right here — at module scope, before `app.listen`. This repo
// has no migration runner (a documented decision), which makes a forgotten `ALTER TABLE` a
// realistic future event; unguarded it would take auth, billing and every other route down
// with the Listing Studio. Degrading one feature is the correct failure mode for a schema
// the rest of the app does not read.
/** @type {ReturnType<typeof createProjects> | null} */
let projects = null;
/** @type {ReturnType<typeof createProjectStorage> | null} */
let projectStorage = null;
try {
  projects = createProjects(__dirname);
  projectStorage = createProjectStorage({ baseDir: __dirname });
} catch (err) {
  logger.error(
    '[listing-studio] DISABLED — its store could not be opened, so /api/projects will 503 while the rest of the app runs normally. ' +
    'This is almost always schema drift: a column this build expects is missing from an existing database. Error:',
    err && err.message ? err.message : err,
  );
}
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
const { getAuthUserFromRequest, toPublicAuthUser, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount } = createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName });

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
const { genAI, openai, resend } = createAiClients({ __dirname, DEBUG_MODE });
const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'team@stagify.ai').trim();
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || 'https://stagify.ai').replace(/\/$/, '');

// Trial-email lifecycle (welcome / activation / value / ending / win-back). The
// webhook fires the event-driven ones; trialLifecycle.start() (below, post-listen)
// runs the behaviour-based sweep.
const lifecycleEmails = createLifecycleEmails({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, appUrl: APP_URL });
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
    logger.error('[admin] test email send threw:', err && err.message ? err.message : err);
    return { ok: false, status: 502, error: 'Could not send the test email.' };
  }
}

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
  })
);

// JSON body parsing (small/large per-route limits + the JSON SyntaxError/413
// handler) and static-asset serving → lib/http/app-middleware.js. Mounted AFTER
// the billing router so Stripe's webhook still sees the raw body; the JSON error
// handler stays registered immediately after the parser and before the routers.
applyBodyAndStatic(app);

// Multer upload configs (staging / chat / hosted-image) + HOSTED_IMAGE_MIME_EXT
// → lib/http/uploads.js (imported above). Pure config, no server-state deps.

// DEBUG_MODE / EMAIL_DEBUG_MODE / DEBUG_EMAIL are computed once in
// lib/config/runtime-flags.js and imported at the top of this file (single source of
// truth shared with the extracted lib/ modules).

// Stats overrides (STATS_DEBUG / DEBUG_ROOMS / DEBUG_USERS) → lib/config/runtime-flags.js
// (imported above). Boot log kept here so its ordering is unchanged.
if (STATS_DEBUG) {
  logger.debug(`Stats debug: ENABLED (rooms=${DEBUG_ROOMS}, users=${DEBUG_USERS})`);
}

// getTemperatureForModel / getGeminiImageModel → lib/config/model-config.js
// setSensitiveHeaders → lib/http/http-helpers.js (imported at top)

// AI/email clients (genAI / openai / resend) + RESEND_FROM_EMAIL / APP_URL are
// constructed above the billing router (the Stripe webhook needs the Resend client
// for the trial-email lifecycle). Reused here for the remaining routers.
const { getDataLogDir, escapeCsvField, logPromptToFile, logMaskEditToFile, logChatToFile } = createLogging({ __dirname });
const { logEmailOpenToFile, isConfirmedEmailClientOpen, forgetEmailOpenState, sendRegistrationVerificationEmail, sendAccountExistsNotice } = createEmail({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, escapeCsvField, getDataLogDir });
const { loadMemories, saveMemories, exportAllMemories, resetAllMemories } = createMemory({ __dirname, DEBUG_MODE });
// GDPR erasure. Built here (not inside a store) because it spans every store's
// tables plus the CSV logs — see lib/data/user-deletion.js.
// `removeProjectFiles` is the erasure's hook into the blob store: deleteUser is one
// synchronous transaction and cannot await, so it takes the sync remover. Passed as the
// storage module's own function rather than a path built here — where a project's bytes
// live is project-storage.js's business, and re-deriving it at the composition root is
// exactly how the two would drift out of agreement.
const { deleteUser } = createUserDeletion({
  baseDir: __dirname,
  getDataLogDir,
  forgetEmailOpenState,
  // Guarded because the blob store may have failed to open (above). If it did, erasure
  // still removes every row, and the seam being absent is reported as `removed: false`
  // rather than silently — see the warning path in user-deletion.js.
  removeProjectFiles: projectStorage ? (projectId) => projectStorage.removeProjectSync(projectId) : undefined,
});

// GPT-vision / Gemini helpers extracted to lib/, instantiated with this server's
// AI clients (the pure helpers they call are direct imports inside each module).
const { annotateImage } = createImageAnnotation({ openai });
const { reviewImageQuality, reviewMaskEdit, validateStageableImage, reviewDesignConsistency } = createImageReview({ genAI });
const { roomIsAlreadyEmpty, eraseFurniture } = createErase({ genAI, openai });
const { blueprintTo3D } = createCadHandling({ genAI });
const { getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest } = createHostedImages({ getDataLogDir });
const { healthHandler, protectLogs, stagingEndpointKeyGuard } = createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches });

// ---------------------------------------------------------------------------
// Self-check quality gate
// After generating an image we ask a cheap vision model whether it is basically
// perfect (no obvious issues). If so, we accept it immediately. If not, it also
// returns a 0-100 score; we regenerate up to QUALITY_MAX_ATTEMPTS total and, if
// none come back perfect, return the highest-scoring attempt so the user always
// gets the best available image.
const QUALITY_MAX_ATTEMPTS = 3;

// The Gemini image-generation pipeline (the quality-gate retry wrapper +
// text-to-image + virtual staging) → lib/staging/staging-generation.js, bound to
// this server's AI clients + reviewers. The router-facing signatures are
// unchanged (generateWithQualityRetry keeps its positional shape), so the router
// dep-objects below still pass these under the same names.
const { generateWithQualityRetry, processImageGeneration, processStaging } = createStagingGeneration({
  genAI,
  DEBUG_MODE,
  runQualityRetry,
  reviewImageQuality,
  // Design-continuity gate. Only consulted when a staging request carries a designBible
  // (the multi-photo listing path), and combined WORST-OF with the quality verdict: a
  // beautiful render containing the wrong sofa is the exact failure listing staging
  // exists to prevent, so the two scores must not average each other out.
  reviewDesignConsistency,
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
// Instantiated AFTER createStagingGeneration because it consumes processStaging;
// keeps its (req, res, meta) signature so the staging router deps are unchanged.
const { handleVirtualStagingMultipart } = createVirtualStagingHandler({
  genAI,
  DEBUG_MODE,
  authStore,
  toPublicAuthUser,
  enterpriseDomainForUser,
  reportEnterpriseUsage,
  roomIsAlreadyEmpty,
  eraseFurniture,
  processStaging,
});

// ── Listing Studio (multi-photo listing staging) ───────────────────────────
// Built AFTER createStagingGeneration because the worker drives processStaging.
//
// The flow: a listing's photos are grouped into rooms (roomClustering), one hero frame
// per room is staged normally, a design bible is extracted from that render, and every
// remaining frame of the room is then conditioned on it. The bible is what makes the
// same sofa appear in the wide shot and the detail shot — the problem no one-photo-at-
// a-time stager solves.
const { extractBible } = createDesignBible({ genAI });
const roomClustering = createRoomClustering({ genAI });
// One in-process serial worker. A 30-frame listing cannot run inside an HTTP request,
// and this app is single-instance by design (SQLite is single-writer — see the README's
// known limitations), so the queue lives in the `renders` table and the worker leases
// one row at a time. Every bit of progress is therefore durable: a restart mid-listing
// resumes rather than restarting, and a lease abandoned by a killed process is reclaimed.
// Null when the store above failed to open, in which case the queue never runs.
const listingWorker = projects && projectStorage
  ? createListingWorker({
      projects,
      storage: projectStorage,
      processStaging,
      extractBible,
      getGeminiImageModel,
      // Makes a listing render attributable in prompt_logs.csv. Without it the worker (which
      // has no request) wrote 'unknown' in the email cell, and LOG_REDACTIONS matches that
      // file on email — so a GDPR erasure could never reach those rows, while the row itself
      // carried the operator's free-text notes.
      resolveOwnerEmail: (userId) => authStore.findUserById(userId)?.email || '',
      // Meters listing renders against an enterprise domain. `/stage` only enqueues, and
      // the renders happen later in the worker with no request in scope — which is exactly
      // why this path was metering nothing at all: enterprise accounts are promoted to
      // `plan: 'pro'`, so they passed the gate and staged whole listings free of charge.
      // Resolved per render (not captured once) because a domain can be deactivated
      // mid-listing, and `enterpriseDomainForUser` is the single place that decides whether
      // an account bills to a domain or to its own Stripe subscription.
      reportListingUsage: (userId, quantity) => {
        const owner = authStore.findUserById(userId);
        const domain = owner ? enterpriseDomainForUser(owner) : null;
        if (domain) reportEnterpriseUsage(domain, quantity);
      },
      DEBUG_MODE,
    })
  : null;

// Health check endpoints
// healthHandler / protectLogs / stagingEndpointKeyGuard → lib/http/http-guards.js (instantiated above).

const MAX_MASK_PROMPT_LENGTH = 1000;

// --- AI-assisted selection (Masking Studio) ----------------------------------
// Gemini 2.5 Flash segmentation: given a room photo and an optional natural-
// language target ("the sofa", "the empty floor area"), returns box-cropped
// probability masks. With no target it segments every distinct object, which
// the client caches and hit-tests so each wand click is instant. box_2d is
// [y0, x0, y1, x1] normalized to 0-1000 of the image sent here, so the client
// maps masks onto its full-resolution canvas without knowing our dimensions.
const MAX_SEGMENT_QUERY_LENGTH = 200;

// auth routes (routes/auth.js)
app.use(createAuthRouter({ authStore, googleOAuthClient, resend, LOGS_ACCESS_KEY, authLimiter, emailLimiter, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, SHOW_STAGING_BANNER, endpointKeyMatches, setSensitiveHeaders, getAuthUserFromRequest, toPublicAuthUser, sendRegistrationVerificationEmail, sendAccountExistsNotice, __dirname, googleClientId }));

// admin routes (routes/admin.js)
// Orphan-blob reclaim, exposed to the admin key as POST /api/admin/blob-gc. Only built when
// the Listing Studio store opened — with no database there is no set of live keys, and a
// sweep that could not read one would classify EVERY blob as an orphan.
const projectBlobGc = projects ? createProjectBlobGc({ baseDir: __dirname }) : null;
// Read-only support visibility: which listings are stuck, is the queue moving, who is large.
const projectInsights = projects ? createProjectInsights({ baseDir: __dirname }) : null;

app.use(createAdminRouter({ authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, deleteUser, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT, emailCatalog, sendTestEmail, referralLinks, sweepProjectBlobs: projectBlobGc ? projectBlobGc.sweep : undefined, listingHealth: projectInsights ? projectInsights.health : undefined }));

// staging routes (routes/staging.js)
app.use(createStagingRouter({ genAI, genLimiter, stagingProcessUpload, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount, logMaskEditToFile, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard }));

// Listing Studio routes (routes/projects.js) — the multi-photo listing workspace.
// Every route is Stagify+ gated INSIDE its handler and scoped to the validated session
// user's id; a project belonging to someone else answers 404 rather than 403, so the API
// is not an existence oracle for other people's listings.
if (projects && projectStorage && listingWorker) {
  app.use(createProjectsRouter({ projects, storage: projectStorage, roomClustering, assignRoomKeys, pickHero, listingWorker, getAuthUserFromRequest, requireProAccount, validateStageableImage, setSensitiveHeaders, genLimiter, appUrl: APP_URL, DEBUG_MODE }));
} else {
  // The store did not open. Answer the Listing Studio's routes with a clean 503 rather than
  // letting them fall through to the 404 handler, so a client can tell "temporarily
  // unavailable" from "no such endpoint", and the failure shows up in the access log
  // instead of being indistinguishable from a typo.
  app.use('/api/projects', (req, res) => sendError(res, 503, 'The Listing Studio is temporarily unavailable.', { code: 'LISTING_STUDIO_DISABLED' }));
}

// Client share links (routes/share-public.js) — /s/:token and the three /api/share/:token
// routes. UNAUTHENTICATED by design: this is what a broker sends to a seller or a buyer,
// neither of whom has an account.
//
// Mounted as its OWN router rather than on the projects router, deliberately. The projects
// router's every handler opens with `requireProAccount`, and its header says so; hanging a
// public surface off it would make that statement false and would put these four routes one
// careless refactor away from inheriting a gate they must not have — or, far worse, from a
// reviewer assuming they already have one.
//
// Mounted BEFORE the referral router (which owns the root namespace and must stay last), so
// /s/:token cannot be shadowed by a campaign slug.
if (projects && projectStorage) {
  app.use(createSharePublicRouter({
    shares: projects.shares, projects, storage: projectStorage, shareLimiter, __dirname,
  }));
}

// chat routes (routes/chat.js)
app.use(createChatRouter({ openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, annotateImage, downscaleImageForGPT, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount }));

// localized-page routes (routes/i18n.js) — /es, /fr/ai-designer.html, … rendered
// server-side from the language JSON. Mounted before the public router; its prefixes
// (/es, /fr, …) are disjoint from every other route and from the static files.
app.use(createI18nRouter({ __dirname, DEBUG_MODE }));

// public routes (routes/public.js)
app.use(createPublicRouter({ authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY, endpointKeyMatches, emailLimiter, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getHostedImagesDir, readHostedImagesManifest, logEmailOpenToFile, isConfirmedEmailClientOpen, healthHandler, getPromptCount, getContactCount, incContactCount , __dirname }));

// Referral/campaign short-URLs (routes/referrals.js) — /columbia and anything else
// created from the dashboard count the arrival and 302 to the home page.
//
// MOUNTED LAST, after every other router, and that placement is load-bearing: links
// are operator-created data, so this router matches `/:slug` and looks the slug up
// per request. Here it only ever sees paths nothing else claimed, which is what
// makes it impossible for a dashboard-created link to shadow a real page. Anything
// it does not recognise falls through to Express's 404 exactly as before.
app.use(createReferralRouter({ referralLinks }));

// Multer upload errors surface here — AFTER the routers that use multer, so Express
// actually reaches this handler (it only runs error middleware registered after the
// throwing route). Placed BEFORE the Sentry handler so an over-cap upload returns a
// clean 413 and doesn't get reported as a server error.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'File too large', {
        code: 'FILE_TOO_LARGE',
        details: 'That file is too large. Please upload a smaller file.',
      });
    }
    // Fold the multer message into `error` itself — the staging client surfaces
    // this field to the user (app.js falls back to `error` when there's no `code`
    // it recognises), so the specific reason must stay in the primary string.
    return sendError(res, 400, err.message || 'Upload error', { code: err.code });
  }
  next(err);
});

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
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  logger.error('Unhandled route error:', err);
  sendError(res, err.status || err.statusCode || 500, 'Internal server error');
});

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
      logger.error('Uptime monitor failed to start:', err.message);
    }

    // Behaviour-based trial emails (activation nudge + mid-trial value). The
    // event-driven ones fire from the Stripe webhook; this sweep covers the two
    // that depend on trial age + whether the user has staged yet.
    try {
      trialLifecycle.start();
    } catch (err) {
      logger.error('Trial-lifecycle sweep failed to start:', err.message);
    }

    // Listing-staging queue. Skipped under tests for the same reason as the two above:
    // a suite that booted the real server would otherwise start rendering. Its interval
    // is unref()'d, so it never holds the process open.
    try {
      // Optional-called: null when the Listing Studio's store failed to open (see above),
      // in which case there is nothing for the queue to do and the rest of the app runs on.
      listingWorker?.start();
    } catch (err) {
      logger.error('Listing worker failed to start:', err.message);
    }
  }

  // Initialize prompt count on server startup
  initializePromptCount();
  // Initialize contact count on server startup
  initializeContactCount();
});
