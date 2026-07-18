import './load-env.js'; // must be first: populates process.env from .env before any secret is read
// Sentry init runs via `node --import ./instrument.js` (see package.json), NOT a top-level import
// here: ESM loads the whole import graph — including express — before any module body executes, so
// an in-file import would call Sentry.init() too late to instrument express. --import runs it first.
import * as Sentry from '@sentry/node';
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { blueprintTo3D } from './lib/staging/cad-handling.js';
import { createAuthStore } from './lib/data/auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './lib/services/stripe-webhooks.js';
import { createEnterpriseStore } from './lib/data/enterprise-store.js';
import { createUptimeMonitor } from './lib/data/uptime-monitor.js';
import { generateWithQualityRetry as runQualityRetry } from './lib/staging/staging-pipeline.js';
import createBillingRouter from './routes/billing.js';
import { createEmail } from './lib/services/email.js';
import { createLogging } from './lib/services/logging.js';
import { createMemory } from './lib/data/memory.js';
import { createConfig } from './lib/config/config.js';
import { maskReferencePromptSuffix } from './lib/staging/prompts.js';
import { downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, downscaleImageForGPT, compositeForReview } from './lib/image/image-primitives.js';
import createPublicRouter from './routes/public.js';
import createI18nRouter from './routes/i18n.js';
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
import { authLimiter, emailLimiter, genLimiter } from './lib/http/rate-limiters.js';
import { logger } from './lib/logger.js';
import { applyEdgeMiddleware, applyBodyAndStatic } from './lib/http/app-middleware.js';
import { createStagingGeneration } from './lib/staging/staging-generation.js';
import { createVirtualStagingHandler } from './lib/staging/virtual-staging-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { readStripeSecretKey, readStripeWebhookSecret, readStripePublishableKey, readEnterprisePriceId, readGoogleClientId, readGoogleClientSecret, readEndpointAccessKey, endpointKeyMatches, readEnterpriseMeterEventName } = createConfig({ __dirname });

const authStore = createAuthStore(__dirname);
const enterpriseStore = createEnterpriseStore(__dirname);
const uptimeMonitor = createUptimeMonitor(__dirname);
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

// AI/email clients (genAI / openai / resend) → lib/services/ai-clients.js. Constructed once
// at boot from env vars (Render) or local *-key.txt fallbacks (dev).
const { genAI, openai, resend } = createAiClients({ __dirname, DEBUG_MODE });

const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'team@stagify.ai').trim();
const { getDataLogDir, escapeCsvField, logPromptToFile, logMaskEditToFile, logChatToFile } = createLogging({ __dirname, DEBUG_MODE });
const { logEmailOpenToFile, isConfirmedEmailClientOpen, sendRegistrationVerificationEmail, sendAccountExistsNotice } = createEmail({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, escapeCsvField, getDataLogDir });
const { loadMemories, saveMemories, exportAllMemories, resetAllMemories } = createMemory({ __dirname, DEBUG_MODE, openai });

// GPT-vision / Gemini helpers extracted to lib/, instantiated with this server's
// AI clients (the pure helpers they call are direct imports inside each module).
const { annotateImage } = createImageAnnotation({ openai });
const { reviewImageQuality, reviewMaskEdit, validateStageableImage } = createImageReview({ genAI });
const { roomIsAlreadyEmpty, eraseFurniture } = createErase({ genAI, openai });
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
app.use(createAdminRouter({ authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT }));

// staging routes (routes/staging.js)
app.use(createStagingRouter({ genAI, openai, genLimiter, stagingProcessUpload, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount, logMaskEditToFile, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard }));

// chat routes (routes/chat.js)
app.use(createChatRouter({ openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, annotateImage, downscaleImageForGPT, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount }));

// localized-page routes (routes/i18n.js) — /es, /fr/ai-designer.html, … rendered
// server-side from the language JSON. Mounted before the public router; its prefixes
// (/es, /fr, …) are disjoint from every other route and from the static files.
app.use(createI18nRouter({ __dirname, DEBUG_MODE }));

// public routes (routes/public.js)
app.use(createPublicRouter({ authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY, endpointKeyMatches, emailLimiter, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getHostedImagesDir, readHostedImagesManifest, logEmailOpenToFile, isConfirmedEmailClientOpen, healthHandler, getPromptCount, getContactCount, incContactCount , __dirname }));

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
  }

  // Initialize prompt count on server startup
  initializePromptCount();
  // Initialize contact count on server startup
  initializeContactCount();
});
