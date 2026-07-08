import './load-env.js'; // must be first: populates process.env from .env before any secret is read
// Sentry init runs via `node --import ./instrument.js` (see package.json), NOT a top-level import
// here: ESM loads the whole import graph — including express — before any module body executes, so
// an in-file import would call Sentry.init() too late to instrument express. --import runs it first.
import * as Sentry from '@sentry/node';
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import sharp from "sharp";
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { blueprintTo3D } from './lib/staging/cad-handling.js';
import { createAuthStore } from './lib/data/auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './lib/services/stripe-webhooks.js';
import { createEnterpriseStore } from './lib/data/enterprise-store.js';
import { createUptimeMonitor } from './lib/data/uptime-monitor.js';
import { generateWithQualityRetry as runQualityRetry, normalizeFurnitureBuffers } from './lib/staging/staging-pipeline.js';
import createBillingRouter from './routes/billing.js';
import { createEmail } from './lib/services/email.js';
import { createLogging } from './lib/services/logging.js';
import { createMemory } from './lib/data/memory.js';
import { createConfig } from './lib/config/config.js';
import { generatePrompt, styleReferencePromptSuffix, maskReferencePromptSuffix, furnitureReferencePromptSuffix } from './lib/staging/prompts.js';
import { downscaleImage, enforceAspectRatio, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, downscaleImageForGPT, compositeForReview } from './lib/image/image-primitives.js';
import createPublicRouter from './routes/public.js';
import createChatRouter from './routes/chat.js';
import createStagingRouter from './routes/staging.js';
import createAdminRouter from './routes/admin.js';
import createAuthRouter from './routes/auth.js';
import { DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, HIDE_STAGING_BANNER, SHOW_STAGING_BANNER, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS } from './lib/config/runtime-flags.js';
import { setSensitiveHeaders, getStagingClientIp, isLikelyMobileStagingRequest, getUserIdentifier } from './lib/http/http-helpers.js';
import { getTemperatureForModel, getGeminiImageModel } from './lib/config/model-config.js';
import { createAuthHelpers } from './lib/services/auth-helpers.js';
import { getPromptCount, incPromptCount, getContactCount, incContactCount, initializePromptCount, initializeContactCount } from './lib/data/counters.js';
import { createImageAnnotation } from './lib/image/image-annotation.js';
import { createImageReview } from './lib/image/image-review.js';
import { createErase } from './lib/image/erase.js';
import { createHostedImages } from './lib/image/hosted-images.js';
import { createHttpGuards } from './lib/http/http-guards.js';
import { createAiClients } from './lib/services/ai-clients.js';
import { stagingProcessUpload, pdfUpload, chatUpload, hostImageUpload, HOSTED_IMAGE_MIME_EXT } from './lib/http/uploads.js';
import { authLimiter, emailLimiter, genLimiter } from './lib/http/rate-limiters.js';

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
  console.log('[google] OAuth client id loaded (Sign-In with Google enabled)');
}

// Staging-environment flags (IS_STAGING / HIDE_STAGING_BANNER / SHOW_STAGING_BANNER)
// → lib/config/runtime-flags.js (imported above). Boot log kept here so its ordering with
// the other startup lines is unchanged.
if (IS_STAGING) {
  console.log(
    '[staging] IS_STAGING enabled — Google sign-in and Stripe checkout are disabled' +
      (HIDE_STAGING_BANNER ? ' (staging banner hidden)' : ''),
  );
}

const LOGS_ACCESS_KEY = readEndpointAccessKey();
if (LOGS_ACCESS_KEY) {
  console.log('Endpoint access key successfully loaded');
} else {
  console.error('Error: No endpoint access key found in file or environment variable');
}

const enterpriseMeterEventName = readEnterpriseMeterEventName();

// Auth/enterprise helpers (lib/services/auth-helpers.js), sharing this server's stores + Stripe.
const { getAuthUserFromRequest, toPublicAuthUser, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount } = createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName });

// Home-page counters (rooms staged / contacts) live in lib/data/counters.js — imported above.

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);

// Middleware
// --- Security headers (helmet) ---------------------------------------------
// CSP is tuned for the third parties this app loads (Google sign-in, Stripe +
// Instagram embeds). script-src is a real allowlist — all of our JS is served
// from external files (no inline <script> blocks or on* handlers remain), so it
// deliberately omits 'unsafe-inline' and an injected inline script won't run.
// style-src still allows 'unsafe-inline' because the pages carry many inline
// style="" attributes; that's a lower-severity gap (CSS injection, not JS).
// Set DISABLE_CSP=1 to turn the policy off without a code change if a deploy
// surfaces an unexpected blocked resource.
const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  scriptSrc: [
    "'self'",
    // NB: no 'unsafe-inline' — keep it that way. Any inline JS must move to a
    // file under public/scripts/ (see e.g. footer-year.js, hover-glow.js).
    // HEIC upload conversion (heic2any/libheif) runs a WebAssembly module in a
    // Web Worker spawned from a blob: URL. 'wasm-unsafe-eval' permits ONLY WASM
    // compilation (not general eval); blob: lets the worker script load.
    "'wasm-unsafe-eval'",
    'blob:',
    'https://accounts.google.com',
    'https://apis.google.com',
    'https://www.gstatic.com',
    'https://*.stripe.com',
  ],
  // Allow the heic2any conversion worker (created from a blob: URL).
  workerSrc: ["'self'", 'blob:'],
  childSrc: ["'self'", 'blob:'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'data:', 'blob:'],
  // blob:/data: let the WASM worker load its embedded binary.
  connectSrc: ["'self'", 'https:', 'blob:', 'data:'],
  frameSrc: [
    "'self'",
    'https://www.instagram.com',
    'https://accounts.google.com',
    'https://*.stripe.com',
  ],
  upgradeInsecureRequests: [],
};
app.use(
  helmet({
    contentSecurityPolicy:
      process.env.DISABLE_CSP === '1' ? false : { directives: cspDirectives },
    // Embeds + the Google sign-in popup need these relaxed from helmet defaults.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// --- CORS: restrict to our own origins -------------------------------------
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  'https://stagify.ai,https://www.stagify.ai,http://localhost:3000'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin / non-browser requests (no Origin header) and our list.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// --- Response compression ---------------------------------------------------
// gzip text responses (HTML/CSS/JS/JSON) — ~75-80% smaller on the wire. Two
// deliberate skips:
//   1. Server-Sent Events (text/event-stream): compressing buffers the stream
//      and would break the AI Designer's live token-by-token responses.
//   2. The image-generation endpoints: they return multi-MB base64 of images
//      that are ALREADY compressed (PNG/JPEG/WebP), so gzip spends CPU for
//      near-zero savings. Small JSON from every other /api route still compresses.
const NO_COMPRESS_ROUTES = new Set([
  '/api/process-image',
  '/api/stage-by-endpoint-key',
  '/api/mask-edit',
]);
app.use(
  compression({
    filter: (req, res) => {
      if (NO_COMPRESS_ROUTES.has(req.path)) return false;
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
      return compression.filter(req, res); // default: compressible types over threshold
    },
  })
);

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

// JSON body parsing. Keep the app-wide limit SMALL so a single oversized JSON body
// can't spike memory or block the event loop (JSON.parse is synchronous) on ANY
// endpoint — this parser runs before the per-route rate limiters. Only the handful
// of routes that legitimately receive base64 images in JSON get a large limit.
// (Multipart image uploads go through multer, not this parser.)
const JSON_LARGE_LIMIT_PATHS = new Set([
  '/api/chat', // conversation history with embedded images
  '/api/mask-edit', // image + mask + optional reference image (data URLs)
  '/api/segment', // base64 image
  '/api/validate-image', // base64 image
  '/api/bug-report', // conversation history (may include images)
]);
const jsonSmall = express.json({ limit: '1mb' });
const jsonLarge = express.json({ limit: '25mb' }); // tune to the real max payload if needed
app.use((req, res, next) =>
  (JSON_LARGE_LIMIT_PATHS.has(req.path) ? jsonLarge : jsonSmall)(req, res, next)
);
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON parsing error:', err.message);
    console.error('Request body size:', req.headers['content-length'], 'bytes');
    return res.status(400).json({ error: 'Invalid JSON or request too large' });
  }
  if (err.type === 'entity.too.large') {
    console.error('Request entity too large:', err.message);
    console.error('Request body size:', req.headers['content-length'], 'bytes');
    console.error('Limit:', err.limit, 'bytes');
    return res.status(413).json({ error: 'Request entity too large', limit: err.limit });
  }
  next(err);
});

app.use(
  express.static('public', {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (/\.(html|css|js|json)$/i.test(filePath)) {
        // Always revalidate code/markup/translations so returning visitors
        // never get stale styling or scripts after a deploy (cheap 304s).
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(woff2?|ttf|otf|eot)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(png|jpe?g|webp|gif|svg|ico|avif)$/i.test(filePath)) {
        // Stable image assets — cache hard for a year. To update one in place,
        // rename it or append a ?v= query so returning visitors re-fetch.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(mp4|webm|mov|m4v|ogv|ogg|m4a|mp3)$/i.test(filePath)) {
        // Large media (e.g. the background video) rarely changes — cache for a
        // year so it isn't re-downloaded on every visit. Rename/?v= to bust.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// Multer upload configs (staging / PDF / chat / hosted-image) + HOSTED_IMAGE_MIME_EXT
// → lib/http/uploads.js (imported above). Pure config, no server-state deps.

// External PDF processing server URL
const PDF_PROCESSING_SERVER = 'https://stagify-project-imagination.onrender.com';

// DEBUG_MODE / EMAIL_DEBUG_MODE / DEBUG_EMAIL are computed once in
// lib/config/runtime-flags.js and imported at the top of this file (single source of
// truth shared with the extracted lib/ modules).

// Stats overrides (STATS_DEBUG / DEBUG_ROOMS / DEBUG_USERS) → lib/config/runtime-flags.js
// (imported above). Boot log kept here so its ordering is unchanged.
if (STATS_DEBUG) {
  console.log(`Stats debug: ENABLED (rooms=${DEBUG_ROOMS}, users=${DEBUG_USERS})`);
}

// getTemperatureForModel / getGeminiImageModel → lib/config/model-config.js
// getUserIdentifier / setSensitiveHeaders / getStagingClientIp /
// isLikelyMobileStagingRequest → lib/http/http-helpers.js  (imported at top)

// AI/email clients (genAI / openai / resend) → lib/services/ai-clients.js. Constructed once
// at boot from env vars (Render) or local *-key.txt fallbacks (dev).
const { genAI, openai, resend } = createAiClients({ __dirname, DEBUG_MODE });

const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'team@stagify.ai').trim();
const { getDataLogDir, escapeCsvField, logPromptToFile, logMaskEditToFile, logChatToFile } = createLogging({ __dirname, DEBUG_MODE });
const { logEmailOpenToFile, isConfirmedEmailClientOpen, sendRegistrationVerificationEmail } = createEmail({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, escapeCsvField, getDataLogDir });
const { loadMemories, saveMemories, exportAllMemories, resetAllMemories } = createMemory({ __dirname, DEBUG_MODE, openai });

// GPT-vision / Gemini helpers extracted to lib/, instantiated with this server's
// AI clients (the pure helpers they call are direct imports inside each module).
const { annotateImage } = createImageAnnotation({ openai });
const { reviewImageQuality, reviewMaskEdit, validateStageableImage } = createImageReview({ openai });
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

// Run an image-producing function up to QUALITY_MAX_ATTEMPTS times, returning the
// first "perfect" result or, failing that, the highest-scoring one.
// `generateOnce(attempt)` must resolve to a data-URL string (or throw).
// `onImageProduced(attempt)` (optional) fires once for every attempt that
// actually yields an image — used to meter billing per generation attempt
// (including quality-gate retries).
// Thin wrapper binding this server's defaults (DEBUG_MODE, the reviewImageQuality
// reviewer, QUALITY_MAX_ATTEMPTS). The retry/quality logic itself lives in
// lib/staging/staging-pipeline.js so it can be unit-tested without real model calls. The
// signature is unchanged, so all call sites and the router deps stay identical.
async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null, reviewFn = null, maxAttempts = QUALITY_MAX_ATTEMPTS) {
  return runQualityRetry(generateOnce, {
    label,
    onImageProduced,
    reviewFn: reviewFn || reviewImageQuality,
    maxAttempts,
    debug: DEBUG_MODE,
  });
}

async function processImageGeneration(prompt, req, geminiModel = 'gemini-2.5-flash-image') {
  try {
    if (!genAI) {
      throw new Error('Gemini AI service not properly configured');
    }
    
    if (DEBUG_MODE) {
      console.log(`[Image Generation] Generating image with prompt: "${prompt}"`);
      console.log(`[Image Generation] Using Gemini model: ${geminiModel}`);
    }
    
    // Use Gemini's image generation model (text-to-image, no input image needed)
    const model = genAI.getGenerativeModel({ model: geminiModel });
    
    // For text-to-image generation, we only send the text prompt
    const fullPrompt = `${prompt}

Composition: frame the full scene naturally, keeping ceilings, floors, walls, and the key subject matter completely in view (use a tight crop or close-up ONLY if the user explicitly requested one).`;
    const generatePrompt = [
      { text: fullPrompt }
    ];

    // Generate, with the self-check quality gate retrying poor results.
    return await generateWithQualityRetry(async () => {
      const result = await model.generateContent(generatePrompt);
      const response = await result.response;

      if (!response || !response.candidates || response.candidates.length === 0) {
        throw new Error('Image generation failed - no results generated');
      }

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          if (DEBUG_MODE) {
            console.log(`[Image Generation] Successfully generated image`);
          }
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }

      throw new Error('No image data in AI response');
    }, 'generation', null, (url) => reviewImageQuality(url, { instruction: prompt }));
  } catch (error) {
    console.error('Error generating image:', error);
    throw error;
  }
}

async function processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer = null, geminiModel = 'gemini-2.5-flash-image') {
  try {
    if (!genAI) {
      throw new Error('AI service not properly configured');
    }
    
    const processedImageBuffer = await downscaleImage(imageBuffer);
    const base64Image = processedImageBuffer.toString("base64");

    // Source aspect ratio: used to letterbox furniture refs to the room's shape
    // (below) and to lock the output back to it after generation (Gemini drifts).
    const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
    const roomAR = srcMeta && srcMeta.width && srcMeta.height ? srcMeta.width / srcMeta.height : null;
    
    const prompt = [
      { text: generatePrompt(
        stagingParams.roomType,
        stagingParams.furnitureStyle,
        stagingParams.additionalPrompt,
        stagingParams.removeFurniture
      ) },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Image,
        },
      },
    ];
    
    const furnitureBuffers = normalizeFurnitureBuffers(furnitureImageBuffer);
    let anyReferencePadded = false;
    for (const buf of furnitureBuffers) {
      const processedFurnitureBuffer = await downscaleImage(buf);
      // Letterbox the reference to the room's aspect ratio (transparent margins) so
      // its shape can't pull Gemini's output off the room's AR — same technique the
      // mask editor uses. No-op when the shapes already match; falls back to the
      // plain JPEG on any error so staging never breaks.
      let refBuf = processedFurnitureBuffer;
      let refMime = "image/jpeg";
      if (roomAR) {
        try {
          const padded = await padBufferToAspectRatio(processedFurnitureBuffer, roomAR, 0.02);
          if (padded.padded) {
            refBuf = padded.buffer;
            refMime = "image/png";
            anyReferencePadded = true;
          }
        } catch (padErr) {
          if (DEBUG_MODE) console.warn('[Staging] Furniture aspect-ratio match failed; sending as-is:', padErr.message);
        }
      }
      prompt.push({
        inlineData: {
          mimeType: refMime,
          data: refBuf.toString("base64"),
        },
      });
    }
    if (furnitureBuffers.length > 0) {
      // Same extra-image plumbing serves both furniture references and style
      // references — only the instruction differs.
      prompt[0].text += stagingParams.styleReference
        ? styleReferencePromptSuffix(furnitureBuffers.length)
        : furnitureReferencePromptSuffix(
            furnitureBuffers.length,
            Boolean(stagingParams.preserveExistingStaging)
          );
      if (DEBUG_MODE) {
        console.log(`[Staging] Including ${furnitureBuffers.length} ${stagingParams.styleReference ? 'style' : 'furniture'} reference image(s) in staging request`);
      }
      if (anyReferencePadded) {
        prompt[0].text += '\n\nNOTE ON REFERENCE IMAGES: One or more reference images have transparent/empty padding added around them to match the room\'s shape. Ignore that empty padding entirely — use only the actual furniture/subject shown, and scale it naturally within the room.';
      }
    }
    
    // Log prompt to file
    logPromptToFile(
      prompt[0].text,
      stagingParams.roomType,
      stagingParams.furnitureStyle,
      stagingParams.additionalPrompt,
      stagingParams.removeFurniture,
      req?.body?.userRole || 'unknown',
      req?.body?.userReferralSource || 'unknown',
      req?.body?.authenticatedEmail || req?.body?.userEmail || 'unknown',
      req
    );
    
    if (DEBUG_MODE) {
      console.log(`[Staging] Using Gemini model: ${geminiModel}`);
    }
    const model = genAI.getGenerativeModel({ model: geminiModel });

    // Furniture references to also show the QA reviewer (so it knows what was meant
    // to be added). Re-encode to JPEG so the data-URL MIME is always correct.
    const furnitureReviewUrls = [];
    for (const fb of furnitureBuffers) {
      try { furnitureReviewUrls.push(`data:image/jpeg;base64,${(await sharp(fb).jpeg().toBuffer()).toString('base64')}`); } catch { /* skip a furniture ref that fails to encode */ }
    }

    // Generate, with the self-check quality gate retrying poor results.
    const resultDataUrl = await generateWithQualityRetry(async () => {
      const result = await model.generateContent(prompt);
      const response = await result.response;

      if (!response || !response.candidates || response.candidates.length === 0) {
        throw new Error('AI processing failed - no results generated');
      }

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }

      const noImageErr = new Error('No image data in AI response');
      noImageErr.code = 'NO_IMAGE_GENERATED';
      throw noImageErr;
    }, 'staging', () => {
      // Meter every staging generation attempt (initial + quality-gate retries)
      // so enterprise usage is billed per generated image. Furniture erases run
      // outside this path and are intentionally NOT counted.
      if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
    }, (url) => reviewImageQuality(url, {
      instruction: (stagingParams.additionalPrompt && stagingParams.additionalPrompt.trim())
        ? stagingParams.additionalPrompt.trim()
        : `Stage this ${stagingParams.roomType || 'room'} professionally`,
      furnitureDataUrls: furnitureReviewUrls,
    }));

    // Lock the result to the source aspect ratio (crop excess, centered).
    if (srcMeta && srcMeta.width && srcMeta.height) {
      const m = /^data:image\/\w+;base64,(.+)$/.exec(resultDataUrl);
      if (m) {
        const fixed = await enforceAspectRatio(
          Buffer.from(m[1], 'base64'),
          srcMeta.width,
          srcMeta.height
        );
        return `data:image/png;base64,${fixed.toString('base64')}`;
      }
    }
    return resultDataUrl;
  } catch (error) {
    console.error('Error processing staging:', error);
    throw error;
  }
}

// ── Public image hosting (admin-managed) ───────────────────────────────────
// Admins upload an image from the dashboard; it's stored on the persistent disk
// and served publicly at /i/<id> behind an unguessable random id. A manifest
// (index.json) records the metadata so the dashboard can list and unhost them.
// HOSTED_IMAGE_MIME_EXT + hostImageUpload (multer) → lib/http/uploads.js (imported above).
// Hosted-image store + manifest → lib/image/hosted-images.js (instantiated above).

// NOTE: the multer upload-error handler lives AFTER the routers (see below), because
// all multer middleware runs inside routes/*.js and Express only reaches an error
// handler registered after the throwing route.

/**
 * Virtual staging after `stagingProcessUpload` has filled `req.files` / `req.body`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ user: object | null, mobileAnonymous: boolean, clientIp: string, recordUsage: boolean, treatAsPro: boolean }} meta
 */
async function handleVirtualStagingMultipart(req, res, meta) {
  const mainFile = req.files?.image?.[0];
  if (!mainFile) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  if (!genAI) {
    return res.status(500).json({ error: 'AI service not properly configured' });
  }

  const user = meta.user;
  const clientIp = meta.clientIp;
  const mobileAnonymous = meta.mobileAnonymous;

  const {
    roomType = 'Living room',
    furnitureStyle = 'standard',
    additionalPrompt = '',
    removeFurniture = false,
    keepFurniture = '',
    userRole = 'unknown',
    userReferralSource = 'unknown',
    userEmail = 'unknown',
    model: gptModelRaw,
    variationCount: variationRaw,
  } = req.body;

  req.body.userRole = userRole;
  req.body.userReferralSource = userReferralSource;
  req.body.userEmail = userEmail;
  req.body.authenticatedEmail = user
    ? user.email
    : mobileAnonymous
      ? `mobile-ip:${clientIp}`
      : 'endpoint-key';

  const isPro = meta.treatAsPro || (user && user.plan === 'pro');
  let selectedModel = gptModelRaw || 'gpt-4o-mini';
  if (!isPro) {
    selectedModel = 'gpt-4o-mini';
  } else if (selectedModel !== 'gpt-5-mini' && selectedModel !== 'gpt-4o-mini') {
    selectedModel = 'gpt-4o-mini';
  }

  let variationCount = parseInt(String(variationRaw || '1'), 10);
  if (Number.isNaN(variationCount)) variationCount = 1;
  variationCount = Math.min(3, Math.max(1, variationCount));
  if (!isPro) {
    variationCount = 1;
  }

  const furnitureFiles = isPro ? req.files?.furnitureImage : null;
  const furnitureBuffers =
    Array.isArray(furnitureFiles) && furnitureFiles.length > 0
      ? furnitureFiles.slice(0, 5).map((f) => f.buffer).filter(Boolean)
      : null;

  // "Remove existing furniture" is a Stagify+ / Enterprise feature (isPro already
  // covers enterprise-domain users, who are treated as pro here).
  const removeBool =
    isPro &&
    (removeFurniture === true ||
      removeFurniture === 'true' ||
      removeFurniture === 'on');

  // Two-stage removal stages every variation from one shared empty room, so we
  // cap output at a single image when furniture removal is on (matches the UI,
  // which hides the variations slider and pins it to 1).
  if (removeBool) variationCount = 1;

  const stagingParamsBase = {
    roomType,
    furnitureStyle,
    additionalPrompt,
    removeFurniture: removeBool,
  };

  const geminiModel = getGeminiImageModel(selectedModel);
  const images = [];

  // Two-stage removal: erase the furniture ONCE up front (not per-variation, so
  // a 3-variation job doesn't pay for 3 erases), then stage every variation from
  // the same empty room. On failure we fall back to the original single-pass
  // removal prompt by keeping removeFurniture true.
  let stageBaseBuffer = mainFile.buffer;
  let stageBaseParams = stagingParamsBase;
  let emptyRoomDataUrl = null;
  if (removeBool) {
    // Cheap GPT-vision pass first: if the room is already basically empty there's
    // no furniture to remove, so skip the erase entirely (saves a Gemini call).
    const alreadyEmpty = await roomIsAlreadyEmpty(mainFile.buffer);
    if (alreadyEmpty) {
      // Nothing to remove — and since removal is handled by the dedicated erase
      // stage (not here), tell the staging AI to ideally NOT remove furniture so
      // it just stages cleanly instead of re-running a "remove all furniture"
      // instruction on an already-empty room.
      stageBaseParams = { ...stagingParamsBase, removeFurniture: false };
      if (DEBUG_MODE) {
        console.log('[Erase] room already basically empty — skipping furniture-removal pass.');
      }
    } else {
      const keepInstruction = typeof keepFurniture === 'string' ? keepFurniture.trim().slice(0, 500) : '';
      const erased = await eraseFurniture(mainFile.buffer, req, keepInstruction);
      if (erased) {
        stageBaseBuffer = erased.buffer;
        emptyRoomDataUrl = erased.dataUrl;
        // The room is already empty — stage it cleanly instead of re-issuing the
        // "remove all furniture" instruction on an already-empty room.
        stageBaseParams = { ...stagingParamsBase, removeFurniture: false };
        if (DEBUG_MODE) {
          console.log('[Erase] furniture removed in pre-stage pass; staging from empty room.');
        }
      } else if (DEBUG_MODE) {
        console.log('[Erase] pre-stage erase unavailable; staging with single-pass removal prompt.');
      }
    }
  }

  for (let v = 0; v < variationCount; v++) {
    let extra = additionalPrompt || '';
    if (v > 0) {
      extra += `\n\n(Subtle variation ${v + 1} of ${variationCount}: keep architecture identical to the source—same walls, windows, doors, ceiling, floor, and room geometry. Preserve the exact aspect ratio and full frame — do not crop or zoom. Change only virtual staging: slightly different furniture arrangement, decor, accents, textiles, or art. Same overall furniture style and mood as the main request; do not redesign the room.)`;
    }
    const stagingParams = {
      ...stageBaseParams,
      additionalPrompt: extra.trim(),
    };

    const stagedImage = await processStaging(
      stageBaseBuffer,
      stagingParams,
      req,
      furnitureBuffers && furnitureBuffers.length ? furnitureBuffers : null,
      geminiModel
    );
    images.push(stagedImage);
    incPromptCount();
  }

  if (meta.recordUsage) {
    if (mobileAnonymous) {
      authStore.recordMobileIpGeneration(clientIp);
    } else if (user) {
      const entDomain = enterpriseDomainForUser(user);
      if (entDomain) {
        // Bill per staging generation attempt (initial + quality-gate retries),
        // which req._stagingGenerations accumulates across all variations. The
        // furniture-erase pass and its retries are deliberately excluded.
        reportEnterpriseUsage(entDomain, req._stagingGenerations || images.length || 1);
      } else if (user.plan === 'free') {
        authStore.recordFreeGeneration(user.id);
      }
    }
  }

  const updatedUser = user ? authStore.findUserByEmail(user.email) : null;
  const responseUser = updatedUser
    ? toPublicAuthUser(updatedUser)
    : user
      ? toPublicAuthUser(user)
      : null;

  if (images.length === 1) {
    return res.json({
      success: true,
      image: images[0],
      emptyRoom: emptyRoomDataUrl || undefined,
      user: responseUser,
    });
  }
  return res.json({
    success: true,
    images,
    image: images[0],
    emptyRoom: emptyRoomDataUrl || undefined,
    user: responseUser,
  });
}

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
app.use(createAuthRouter({ authStore, googleOAuthClient, resend, LOGS_ACCESS_KEY, authLimiter, emailLimiter, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, IS_STAGING, HIDE_STAGING_BANNER, SHOW_STAGING_BANNER, endpointKeyMatches, setSensitiveHeaders, getAuthUserFromRequest, toPublicAuthUser, sendRegistrationVerificationEmail , __dirname, googleClientId }));

// admin routes (routes/admin.js)
app.use(createAdminRouter({ authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT }));

// staging routes (routes/staging.js)
app.use(createStagingRouter({ genAI, openai, genLimiter, stagingProcessUpload, pdfUpload, PDF_PROCESSING_SERVER, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, getStagingClientIp, isLikelyMobileStagingRequest, reportEnterpriseUsage, requireProAccount, logMaskEditToFile, getUserIdentifier, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard }));

// chat routes (routes/chat.js)
app.use(createChatRouter({ openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, getUserIdentifier, annotateImage, downscaleImageForGPT, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount }));

// public routes (routes/public.js)
app.use(createPublicRouter({ authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY, emailLimiter, PDF_PROCESSING_SERVER, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getHostedImagesDir, readHostedImagesManifest, logEmailOpenToFile, isConfirmedEmailClientOpen, healthHandler, getPromptCount, getContactCount, incContactCount , __dirname }));

// Multer upload errors surface here — AFTER the routers that use multer, so Express
// actually reaches this handler (it only runs error middleware registered after the
// throwing route). Placed BEFORE the Sentry handler so an over-cap upload returns a
// clean 413 and doesn't get reported as a server error.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        message: 'That file is too large. Please upload a smaller file.',
        code: 'FILE_TOO_LARGE',
      });
    }
    return res.status(400).json({ error: 'Upload error', message: err.message, code: err.code });
  }
  next(err);
});

// Sentry Express error handler — after ALL routes so it can capture errors thrown in
// them. Captures the error, then passes it through unchanged (no effect on responses).
// No-op when SENTRY_DSN is unset.
Sentry.setupExpressErrorHandler(app);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI configured: ${!!genAI}`);

  // Begin the uptime heartbeat (and record any downtime gap since the last run).
  // Skipped under tests so the suite doesn't write real uptime state or leave a
  // timer/self-check running.
  if (process.env.NODE_ENV !== 'test') {
    try {
      uptimeMonitor.start();
    } catch (err) {
      console.error('Uptime monitor failed to start:', err.message);
    }
  }

  // Initialize prompt count on server startup
  initializePromptCount();
  // Initialize contact count on server startup
  initializeContactCount();
});
