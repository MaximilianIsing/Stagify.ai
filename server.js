import './load-env.js'; // must be first: populates process.env from .env before any secret is read
// Sentry init runs via `node --import ./instrument.js` (see package.json), NOT a top-level import
// here: ESM loads the whole import graph — including express — before any module body executes, so
// an in-file import would call Sentry.init() too late to instrument express. --import runs it first.
import * as Sentry from '@sentry/node';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import sharp from "sharp";
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { Resend } from 'resend';
import { blueprintTo3D } from './lib/cad-handling.js';
import { createAuthStore } from './lib/auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './lib/stripe-webhooks.js';
import { createEnterpriseStore } from './lib/enterprise-store.js';
import { createUptimeMonitor } from './lib/uptime-monitor.js';
import { generateWithQualityRetry as runQualityRetry, normalizeFurnitureBuffers } from './lib/staging-pipeline.js';
import createBillingRouter from './routes/billing.js';
import { createEmail } from './lib/email.js';
import { createLogging } from './lib/logging.js';
import { createMemory } from './lib/memory.js';
import { createConfig } from './lib/config.js';
import { generatePrompt, styleReferencePromptSuffix, maskReferencePromptSuffix, furnitureReferencePromptSuffix, QUALITY_REVIEW_PROMPT, REVIEW_WHY_SUFFIX, MASK_REVIEW_PROMPT, FURNITURE_ERASE_PROMPT, EMPTY_ROOM_CHECK_PROMPT, STAGEABLE_IMAGE_CHECK_PROMPT, DEFAULT_UNSTAGEABLE_REASON } from './lib/prompts.js';
import { downscaleImage, enforceAspectRatio, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, downscaleImageForGPT, compositeForReview } from './lib/image-primitives.js';
import createPublicRouter from './routes/public.js';
import createChatRouter from './routes/chat.js';
import createStagingRouter from './routes/staging.js';
import createAdminRouter from './routes/admin.js';
import createAuthRouter from './routes/auth.js';
import { DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL } from './lib/runtime-flags.js';
import { setSensitiveHeaders, getStagingClientIp, isLikelyMobileStagingRequest, getUserIdentifier } from './lib/http-helpers.js';
import { getTemperatureForModel, getGeminiImageModel } from './lib/model-config.js';
import { createAuthHelpers } from './lib/auth-helpers.js';
import { getPromptCount, incPromptCount, getContactCount, incContactCount, initializePromptCount, initializeContactCount } from './lib/counters.js';

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

// --- Staging environment flag -------------------------------------------------
// When IS_STAGING is truthy ("1"/"true"/"on"/"yes") this deploy is the Stagify
// *staging* (test) site, not production. In that mode we disable the real
// third-party sign-up/payment paths: Google sign-in is turned off (both the UI,
// via /api/auth/config, and the /api/auth/google endpoint) and the Stripe
// subscribe / "Stripe help center" buttons are blocked or hidden in the UI.
// Off by default, so production behaviour is unchanged.
const IS_STAGING = /^(1|true|on|yes)$/i.test(String(process.env.IS_STAGING || '').trim());
// HIDE_STAGING_BANNER hides ONLY the red staging banner (e.g. for screenshots or
// demos on the staging site) — it does NOT re-enable Google sign-in or Stripe.
const HIDE_STAGING_BANNER = /^(1|true|on|yes)$/i.test(String(process.env.HIDE_STAGING_BANNER || '').trim());
const SHOW_STAGING_BANNER = IS_STAGING && !HIDE_STAGING_BANNER;
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

// Auth/enterprise helpers (lib/auth-helpers.js), sharing this server's stores + Stripe.
const { getAuthUserFromRequest, toPublicAuthUser, enterpriseDomainForUser, reportEnterpriseUsage, requireProAccount } = createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName });

// Home-page counters (rooms staged / contacts) live in lib/counters.js — imported above.

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);

// Middleware
// --- Security headers (helmet) ---------------------------------------------
// CSP is tuned for the inline scripts/handlers this app uses plus the third
// parties it loads (Google sign-in, Stripe + Instagram embeds).
// Set DISABLE_CSP=1 to turn the policy off without a code change if a deploy
// surfaces an unexpected blocked resource.
const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
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

// --- Rate limiters ----------------------------------------------------------
const rlOpts = { standardHeaders: 'draft-7', legacyHeaders: false };
// Sign-in / account actions: blunt brute-force protection.
const authLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_AUTH || 40),
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
// Anything that sends an email: keep tight to prevent spam/abuse.
const emailLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_EMAIL || 6),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});
// Paid AI generation: a generous backstop against cost abuse (humans stay well under).
const genLimiter = rateLimit({
  ...rlOpts,
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.RL_GEN || 60),
  message: { error: 'You are generating too quickly. Please wait a moment and try again.' },
});

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

// Explicit routes for SEO files to ensure they're always accessible
/**
 * Grant Stagify+ to the signed-in account when ?key= matches endpointkey.txt (or endpoint_key env).
 * If the browser has no Authorization header, returns a tiny page that re-opens this URL with
 * ?authToken= from localStorage (same pattern as other auth flows).
 */
// Static page that collects the admin key (from a #fragment or a field) and the
// session token client-side, then POSTs them as headers. The page itself holds
// no secrets, so it's safe to serve unconditionally.
/**
 * Grant Stagify+ to the signed-in account. Both secrets ride in headers:
 *   X-Stagify-Endpoint-Key: <admin key>   (constant-time compared)
 *   Authorization: Bearer <session token>
 * Nothing sensitive touches the URL, so it can't leak via access logs, browser
 * history, or Referer headers.
 */
// Configure multer for file uploads (images)
const storage = multer.memoryStorage();
const imageFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PNG, JPG, JPEG, and WebP files are allowed'));
  }
};

const stagingProcessUpload = multer({
  storage: storage,
  // 25MB per file. memoryStorage buffers every file whole and .fields() allows up to
  // 6 files (1 room image + 5 furniture refs), so this caps a request at ~150MB of
  // RAM instead of the previous ~600MB. Photos are downscaled to 1920x1080 after
  // receipt anyway, so 25MB is already far above any real phone photo.
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: imageFileFilter
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'furnitureImage', maxCount: 5 }
]);

// Configure multer for PDF uploads
const pdfUpload = multer({
  storage: storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB — floor-plan PDFs are small; buffered whole in RAM
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Configure multer for chat file uploads (images, PDFs, text files)
const chatUpload = multer({
  storage: storage,
  limits: {
    // .array('files', 5) buffers up to 5 files whole in RAM, so 20MB/file caps a
    // request at ~100MB + the history field, vs the previous ~250MB+.
    fileSize: 20 * 1024 * 1024, // 20MB per file
    fieldSize: 25 * 1024 * 1024, // conversation history (base64 images); matches the /api/chat JSON cap
  },
  fileFilter: (req, file, cb) => {
    // Allow all files - let the AI handle unsupported file types
    cb(null, true);
  }
});

// External PDF processing server URL
const PDF_PROCESSING_SERVER = 'https://stagify-project-imagination.onrender.com';

// DEBUG_MODE / EMAIL_DEBUG_MODE / DEBUG_EMAIL are computed once in
// lib/runtime-flags.js and imported at the top of this file (single source of
// truth shared with the extracted lib/ modules).

// Stats debug — when STATS_DEBUG=true, the home-page hero stats (Rooms Staged /
// Users Served) are faked to the fixed env numbers DEBUG_ROOMS / DEBUG_USERS
// instead of the real counts. When false or unset, the real counts are served
// unchanged. Handy for screenshots/demos without touching real data.
const STATS_DEBUG = String(process.env.STATS_DEBUG || '').trim().toLowerCase() === 'true';
// Parse to a finite number, or NaN if unset/blank/non-numeric (so it falls back
// to the real count rather than silently becoming 0).
const parseStatOverride = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
const DEBUG_ROOMS = parseStatOverride(process.env.DEBUG_ROOMS);
const DEBUG_USERS = parseStatOverride(process.env.DEBUG_USERS);
if (STATS_DEBUG) {
  console.log(`Stats debug: ENABLED (rooms=${DEBUG_ROOMS}, users=${DEBUG_USERS})`);
}

// getTemperatureForModel / getGeminiImageModel → lib/model-config.js
// getUserIdentifier / setSensitiveHeaders / getStagingClientIp /
// isLikelyMobileStagingRequest → lib/http-helpers.js  (imported at top)

// Initialize Google AI (for image processing)
let genAI;
try {
  // Try environment variable first (Render), then fall back to local file
  let apiKey = process.env.GOOGLE_AI_API_KEY;
  if (apiKey === undefined){
    if (DEBUG_MODE) {
      console.log('GOOGLE_AI_API_KEY is not set in an enviorment variable, using local file');
    }
    apiKey = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
  }
  if (DEBUG_MODE) {
    console.log("Google AI API key successfully loaded");
  }
  genAI = new GoogleGenerativeAI(apiKey);
} catch (error) {
  console.error('Error initializing Google AI:', error.message);
}

// Initialize OpenAI GPT (for chat)
let openai;
try {
  // Try environment variable first (Render), then fall back to local file
  let gptApiKey = process.env.GPT_KEY;
  if (gptApiKey === undefined) {
    if (DEBUG_MODE) {
      console.log('GPT_KEY is not set in an environment variable, using local file');
    }
    const gptKeyFile = path.join(__dirname, 'gpt-key.txt');
    if (fs.existsSync(gptKeyFile)) {
      gptApiKey = fs.readFileSync(gptKeyFile, 'utf8').trim();
    }
  }
  if (gptApiKey) {
    openai = new OpenAI({ apiKey: gptApiKey });
    if (DEBUG_MODE) {
      console.log("OpenAI API key successfully loaded");
    }
  } else {
    if (DEBUG_MODE) {
      console.log("Warning: GPT key file is empty, chat features may not work");
    }
  }
} catch (error) {
  console.error('Error initializing OpenAI:', error.message);
  console.log('Chat features will not be available');
}

// Initialize Resend (for email sending)
let resend;
try {
  // Try environment variable first (Render), then fall back to local file
  let resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey === undefined) {
    if (DEBUG_MODE) {
      console.log('RESEND_API_KEY is not set in an environment variable, using local file');
    }
    const resendKeyFile = path.join(__dirname, 'resendkey.txt');
    if (fs.existsSync(resendKeyFile)) {
      resendApiKey = fs.readFileSync(resendKeyFile, 'utf8').trim();
    }
  }
  if (resendApiKey) {
    resend = new Resend(resendApiKey);
    if (DEBUG_MODE) {
      console.log("Resend API key successfully loaded");
    }
  } else {
    if (DEBUG_MODE) {
      console.log("Warning: Resend key not found, email features will not be available");
    }
  }
} catch (error) {
  console.error('Error initializing Resend:', error.message);
  console.log('Email features will not be available');
}

const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || 'team@stagify.ai').trim();
const { getDataLogDir, escapeCsvField, logPromptToFile, logMaskEditToFile, logChatToFile } = createLogging({ __dirname, DEBUG_MODE });
const { logEmailOpenToFile, isConfirmedEmailClientOpen, sendRegistrationVerificationEmail } = createEmail({ resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, escapeCsvField, getDataLogDir });
const { getMemoriesFile, loadMemories, saveMemories } = createMemory({ __dirname, DEBUG_MODE, openai });


// Gemini image models don't strictly honor the input aspect ratio — they tend to
// "square up" wide/short rooms and return an image that's slightly taller (or
// wider) than the source. We correct this with a GENTLE non-uniform resize back
// to the source ratio (keep width, nudge height) — NOT a crop, so no content is
// lost and the result never looks zoomed-in. The correction is only applied when
// the drift is small enough to be imperceptible; larger drifts are left untouched
// (stretching them would distort the room more than the wrong ratio does, and
// they're better handled by regeneration). Fails open on any error.




// Downscale base64 image data URL for GPT API (max 2048x2048, recommended 1024x1024)
// Annotate an image with a short description using GPT
async function annotateImage(imageDataUrl, isCAD = false, detectBlueprint = false) {
  try {
    if (!openai) {
      if (DEBUG_MODE) {
        console.log('[Image Annotation] OpenAI not initialized, skipping annotation');
      }
      return null;
    }
    
    // Downscale image first to save tokens
    const downscaledUrl = await downscaleImageForGPT(imageDataUrl);
    
    // Build prompt based on whether we need to detect blueprint
    let promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True" if this is a blueprint, floor plan, or architectural drawing (top-down 2D plan view), or "CAD: False" if it is a normal room photo or 3D interior view.';
    if (isCAD) {
      // For explicitly CAD images, just get description and mark as CAD: True
      promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True".';
    } else if (!detectBlueprint) {
      // For staged/generated images that are not CAD, just get description and mark as CAD: False
      promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: False".';
    }
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: downscaledUrl } }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 50
    });
    
    let annotation = completion.choices[0].message.content.trim();
    
    // Extract CAD classification from the response
    const cadMatch = annotation.match(/CAD:\s*(True|False)/i);
    if (cadMatch) {
      // Remove the CAD: True/False line from the annotation text
      annotation = annotation.replace(/\n?\s*CAD:\s*(True|False)\s*\.?$/i, '').trim();
      // Add CAD classification back in standardized format
      const cadValue = cadMatch[1];
      annotation += ` CAD: ${cadValue}`;
    } else {
      // If API didn't return CAD classification, use the provided isCAD value
      annotation += ` CAD: ${isCAD ? 'True' : 'False'}`;
      if (DEBUG_MODE) {
        console.log(`[Image Annotation] Warning: API did not return CAD classification, using default: ${isCAD ? 'True' : 'False'}`);
      }
    }
    
    if (DEBUG_MODE) {
      console.log(`[Image Annotation] Generated annotation: "${annotation}"`);
    }
    return annotation;
  } catch (error) {
    console.error('[Image Annotation] Error annotating image:', error);
    return null;
  }
}




























/** Shared prompt block: clarify ambiguity before acting; never ask and trigger image actions in the same turn. */


// Self-knowledge: facts about Stagify the AI Designer can draw on when a user
// asks about the product, company, team, pricing, or features. Keep this as the
// single source of truth — update here if any fact changes.


// ---------------------------------------------------------------------------
// Designer chat routing — strict Structured Outputs schema.
// The conversational model returns ONE JSON object: its reply plus any image
// actions (stage / generate / CAD / view / recall) and memory updates. Using
// OpenAI's strict json_schema (constrained decoding) guarantees valid JSON,
// every field present, and valid enums — removing the malformed-output and
// invalid-roomType failure modes that plain json_object can't prevent.
// staging/generate/cad are ALWAYS arrays here (null when unused); the downstream
// consumers already accept arrays, so this needs no changes there.
// ---------------------------------------------------------------------------











/**
 * Process image through Stagify staging pipeline
 */
/**
 * Generate an image from a text prompt using Gemini
 * This is separate from the staging system - pure text-to-image generation
 */
// ---------------------------------------------------------------------------
// Self-check quality gate
// After generating an image we ask a cheap vision model whether it is basically
// perfect (no obvious issues). If so, we accept it immediately. If not, it also
// returns a 0-100 score; we regenerate up to QUALITY_MAX_ATTEMPTS total and, if
// none come back perfect, return the highest-scoring attempt so the user always
// gets the best available image.
const QUALITY_MAX_ATTEMPTS = 3;


// When DEBUG is on, ask the reviewer to also name the specific defect(s) so we can
// log them; kept out of the prompt in production to avoid the extra output tokens.

// Review a single generated image. Returns { perfect, score }.
// Fails OPEN (perfect: true) on any error so a flaky reviewer never blocks
// delivering an image to the user.
// opts: { instruction, furnitureDataUrls } — instruction is what the user asked for
// (so the reviewer judges against intent, not its own taste); furnitureDataUrls are
// any uploaded furniture references to also show it.
async function reviewImageQuality(imageDataUrl, opts = {}) {
  if (!openai) return { perfect: true, score: 100, reason: 'reviewer disabled' };
  try {
    const { instruction = '', furnitureDataUrls = [] } = opts;
    const mainUrl = await downscaleImageForGPT(imageDataUrl);
    const extraUrls = [];
    if (Array.isArray(furnitureDataUrls)) {
      for (const u of furnitureDataUrls) {
        try { extraUrls.push(await downscaleImageForGPT(u)); } catch { /* skip a furniture ref that fails to downscale */ }
      }
    }
    let guide = ' Image 1 is the photo to review.';
    if (extraUrls.length) {
      guide += ` The remaining ${extraUrls.length === 1 ? 'image is the furniture piece' : 'images are the furniture pieces'} the user uploaded to be included — check it was incorporated in a reasonable way (an exact match is NOT required; do not flag minor differences in shape, color, or angle).`;
    }
    const instr = (instruction && instruction.trim())
      ? ` The user's request was: "${instruction.trim()}". A result that reasonably fulfills this request is GOOD even if it differs from what you might have chosen — judge against the request, not your own taste.`
      : '';
    const content = [
      { type: 'text', text: QUALITY_REVIEW_PROMPT + instr + guide + (DEBUG_MODE ? REVIEW_WHY_SUFFIX : '') },
      { type: 'image_url', image_url: { url: mainUrl } },
    ];
    for (const u of extraUrls) content.push({ type: 'image_url', image_url: { url: u } });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: DEBUG_MODE ? 220 : 80,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    const perfect = /PERFECT:\s*true/i.test(raw);
    if (perfect) return { perfect: true, score: 100, reason: raw };
    const m = raw.match(/SCORE:\s*(\d{1,3})/i);
    // No score on a "not perfect" verdict → treat as a low score for ranking.
    const score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
    if (DEBUG_MODE) console.log(`[Quality] reviewer flagged NOT perfect (score ${score}): ${raw.replace(/\s+/g, ' ')}`);
    return { perfect: false, score, reason: raw };
  } catch (error) {
    console.error('[Quality] review failed, accepting image:', error.message);
    return { perfect: true, score: 100, reason: 'reviewer error' };
  }
}

// Mask-edit QA: shows the reviewer BOTH the original and the edited image so it
// can judge a localized edit — including whether it REMOVED TOO MUCH. Returns
// { perfect, score }. Fails OPEN on any error so a flaky reviewer never blocks.

// opts: { instruction, locatorDataUrl, locatorMarked, referenceDataUrl } — instruction
// is what the user asked for (so the reviewer judges against intent, e.g. an intended
// removal is not "removed too much"); locatorDataUrl shows which area was editable (the
// magenta-outlined room when locatorMarked, else a B/W mask); referenceDataUrl is the
// furniture/look they wanted placed.
async function reviewMaskEdit(originalDataUrl, editedDataUrl, opts = {}) {
  if (!openai) return { perfect: true, score: 100, reason: 'reviewer disabled' };
  try {
    const { instruction = '', locatorDataUrl = null, locatorMarked = false, referenceDataUrl = null } = opts;
    const origSmall = await downscaleImageForGPT(originalDataUrl);
    const editSmall = await downscaleImageForGPT(editedDataUrl);
    let guide = ' Image 1 is the ORIGINAL room; image 2 is AFTER the edit.';
    const extras = [];
    if (locatorDataUrl) { try { extras.push({ desc: locatorMarked ? 'outline' : 'mask', url: await downscaleImageForGPT(locatorDataUrl) }); } catch { /* optional reviewer image; skip on failure */ } }
    if (referenceDataUrl) { try { extras.push({ desc: 'reference', url: await downscaleImageForGPT(referenceDataUrl) }); } catch { /* optional reviewer image; skip on failure */ } }
    let idx = 3;
    for (const e of extras) {
      if (e.desc === 'outline') guide += ` Image ${idx} is the SAME room with the editable area outlined in magenta — judge ONLY inside that outline and ignore everything outside it. The magenta line is just a location guide, NOT part of the photo, so never count it as a defect.`;
      else if (e.desc === 'mask') guide += ` Image ${idx} is the MASK: only the WHITE area was editable — judge ONLY inside it and ignore everything outside it.`;
      else guide += ` Image ${idx} is the REFERENCE the user wanted placed inside the masked area — the edit should resemble its identity (its exact angle and background do not matter).`;
      idx++;
    }
    const instr = (instruction && instruction.trim())
      ? ` The user's instruction was: "${instruction.trim()}". Judge whether the edit reflects THIS instruction. If it asked to REMOVE, clear, delete, or empty something, then a now-empty or barer masked area is CORRECT and expected — do NOT flag that as "removed too much".`
      : '';
    const content = [
      { type: 'text', text: MASK_REVIEW_PROMPT + instr + guide + (DEBUG_MODE ? REVIEW_WHY_SUFFIX : '') },
      { type: 'image_url', image_url: { url: origSmall } },
      { type: 'image_url', image_url: { url: editSmall } },
    ];
    for (const e of extras) content.push({ type: 'image_url', image_url: { url: e.url } });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: DEBUG_MODE ? 220 : 80,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    const perfect = /PERFECT:\s*true/i.test(raw);
    if (perfect) return { perfect: true, score: 100, reason: raw };
    const m = raw.match(/SCORE:\s*(\d{1,3})/i);
    const score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
    if (DEBUG_MODE) console.log(`[Mask QA] reviewer flagged NOT perfect (score ${score}): ${raw.replace(/\s+/g, ' ')}`);
    return { perfect: false, score, reason: raw };
  } catch (error) {
    console.error('[Mask QA] review failed, accepting image:', error.message);
    return { perfect: true, score: 100, reason: 'reviewer error' };
  }
}


// Run an image-producing function up to QUALITY_MAX_ATTEMPTS times, returning the
// first "perfect" result or, failing that, the highest-scoring one.
// `generateOnce(attempt)` must resolve to a data-URL string (or throw).
// `onImageProduced(attempt)` (optional) fires once for every attempt that
// actually yields an image — used to meter billing per generation attempt
// (including quality-gate retries).
// Thin wrapper binding this server's defaults (DEBUG_MODE, the reviewImageQuality
// reviewer, QUALITY_MAX_ATTEMPTS). The retry/quality logic itself lives in
// lib/staging-pipeline.js so it can be unit-tested without real model calls. The
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





// Two-stage "remove existing furniture": before staging, physically empty the
// room in a dedicated pass. Cost-conscious but reliable — it starts on the cheap
// 2.5-flash model and only escalates (extra attempts, then the stronger model) if
// a GPT-vision check finds leftover furniture. See eraseFurniture() below.

// Cheap GPT-vision pre-check: if the room is already essentially empty there's
// nothing to erase, so we skip the (more expensive) Gemini removal pass entirely.
// Fails open — on any error or when the reviewer is disabled we DON'T skip, so a
// flaky check never silently turns off furniture removal.

async function roomIsAlreadyEmpty(imageBuffer) {
  if (!openai) return false;
  try {
    const processed = await downscaleImage(imageBuffer);
    const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EMPTY_ROOM_CHECK_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    return /EMPTY:\s*true/i.test(raw);
  } catch (error) {
    console.error('[Erase] empty-room pre-check failed, proceeding with erase:', error.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stageability pre-check
// Before a room ever reaches a (paid) Gemini generation, a cheap GPT-vision pass
// confirms the upload is actually a stageable property space — an interior room
// or a stageable exterior — and not a selfie, a pet, a product close-up, food, a
// document/screenshot, a car, or a random landscape. Returns { valid, reason }.
// Fails OPEN (valid: true) on any error or when the reviewer is disabled, so a
// flaky check never blocks a legitimate upload. The main stager and Masking
// Studio call this the moment a photo is chosen (see POST /api/validate-image).


async function validateStageableImage(imageBuffer) {
  if (!openai) return { valid: true, reason: '' };
  try {
    const processed = await downscaleImage(imageBuffer);
    const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: STAGEABLE_IMAGE_CHECK_PROMPT },
            // detail: 'low' → one ~512px tile (~85 image tokens) instead of
            // high-detail tiling. A room/not-a-room judgment needs nothing more,
            // and it makes the call several times faster (and cheaper).
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 60,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    const valid = /VALID:\s*true/i.test(raw);
    if (valid) return { valid: true, reason: '' };
    const m = raw.match(/REASON:\s*(.+)/i);
    const reason = m && m[1] ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    if (DEBUG_MODE) console.log(`[Validate] upload rejected as not stageable: ${raw.replace(/\s+/g, ' ')}`);
    return { valid: false, reason: reason || DEFAULT_UNSTAGEABLE_REASON };
  } catch (error) {
    console.error('[Validate] stageability check failed, allowing image:', error.message);
    return { valid: true, reason: '' };
  }
}

// Build the keep-exception clause appended to the erase prompt. Deliberately
// strict/anti-generalization: the model otherwise reads "keep the paintings" as
// permission to keep nearby/similar furniture too.
function buildKeepExceptionText(keepInstruction) {
  if (!keepInstruction || !keepInstruction.trim()) return '';
  return `\n\nNARROW EXCEPTION — keep ONLY these specific items, exactly where they are and unchanged: ${keepInstruction.trim()}.\nThis exception is strictly limited to the exact items named. Do NOT extend it to other items just because they are nearby, similar in type, look valuable, or seem related. For example, if told to keep paintings, you keep ONLY the paintings — you still remove every cabinet, sofa, table, chair, shelf, rug, and all other furniture and decor. Everything not explicitly named in this exception MUST still be removed in full, exactly as instructed above.`;
}

// GPT-vision verification of an erase result: is the room truly empty except for
// the user's kept items? Returns { empty, remaining } where `remaining` lists the
// leftover items so the retry can call them out by name. Fails OPEN (treats as
// clean) on any error so a flaky reviewer never blocks the pipeline.
async function verifyRoomEmptied(imageBuffer, keepInstruction = '') {
  if (!openai) return { empty: true, remaining: '' };
  try {
    const processed = await downscaleImage(imageBuffer);
    const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
    const keep = keepInstruction && keepInstruction.trim();
    let instruction = `You are inspecting an interior room photo that was supposed to have ALL furniture, decor, rugs, curtains, wall art, plants, lamps, and movable objects removed, leaving an empty unfurnished room.`;
    if (keep) {
      instruction += `\nThe ONLY items allowed to remain are exactly these: ${keepInstruction.trim()}. Anything else (including chairs, cabinets, sofas, tables, shelves, rugs, and all other furniture/decor) is a leftover that should have been removed.`;
    } else {
      instruction += `\nNo furniture or decor at all should remain.`;
    }
    instruction += `\nIgnore the room's own walls, floor, ceiling, windows, doors, trim, and permanently built-in structural fixtures${keep ? ', and ignore the allowed items listed above' : ''}. List every other leftover furniture/decor/movable item you can still see.\nReply on ONE line in EXACTLY this format: "CLEAN: true" if nothing remains, or "CLEAN: false | <comma-separated leftover items>" if items remain. Output nothing else.`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 80,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    if (/CLEAN:\s*true/i.test(raw)) return { empty: true, remaining: '' };
    const parts = raw.split('|');
    const remaining = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
    return { empty: false, remaining };
  } catch (error) {
    console.error('[Erase] verification failed, accepting current erase:', error.message);
    return { empty: true, remaining: '' };
  }
}

// Two-stage removal — stage 1. Erase furniture with a verify-and-retry gate:
// a cheap 2.5-flash attempt, a GPT-vision check that the room is truly empty
// (only kept items remain), and up to 3 total attempts that call out whatever was
// left behind. Every attempt stays on the cheap 2.5-flash model (no escalation).
// Returns the best { dataUrl, buffer } or null so callers can fall back to
// single-pass staging.
const ERASE_MAX_ATTEMPTS = 3;
const ERASE_MODEL = 'gemini-2.5-flash-image';

async function eraseFurniture(imageBuffer, req, keepInstruction = '') {
  if (!genAI) return null;
  try {
    const processedImageBuffer = await downscaleImage(imageBuffer);
    const base64Image = processedImageBuffer.toString('base64');
    const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
    const keepText = buildKeepExceptionText(keepInstruction);
    if (keepText && DEBUG_MODE) {
      console.log(`[Erase] keeping user-specified items: ${keepInstruction.trim()}`);
    }

    const buildPrompt = (extraNote) => {
      let eraseText = FURNITURE_ERASE_PROMPT + keepText;
      if (extraNote) eraseText += `\n\n${extraNote}`;
      return [
        { text: eraseText },
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
      ];
    };

    let bestBuffer = null;
    let extraNote = '';
    for (let attempt = 1; attempt <= ERASE_MAX_ATTEMPTS; attempt++) {
      const isFinal = attempt === ERASE_MAX_ATTEMPTS;
      if (DEBUG_MODE) {
        console.log(`[Erase] attempt ${attempt}/${ERASE_MAX_ATTEMPTS} on ${ERASE_MODEL}`);
      }

      let outBuffer;
      try {
        const model = genAI.getGenerativeModel({ model: ERASE_MODEL });
        const result = await model.generateContent(buildPrompt(extraNote));
        const response = await result.response;
        if (!response || !response.candidates || response.candidates.length === 0) {
          throw new Error('no candidates in erase response');
        }
        const part = response.candidates[0].content.parts.find((p) => p.inlineData);
        if (!part) throw new Error('no image data in erase response');
        outBuffer = Buffer.from(part.inlineData.data, 'base64');
      } catch (genErr) {
        console.error(`[Erase] attempt ${attempt} generation failed:`, genErr.message);
        if (bestBuffer) break; // keep the best earlier result
        if (isFinal) return null;
        continue;
      }

      // Lock the emptied room to the source aspect ratio before staging/verification.
      if (srcMeta && srcMeta.width && srcMeta.height) {
        outBuffer = await enforceAspectRatio(outBuffer, srcMeta.width, srcMeta.height);
      }
      bestBuffer = outBuffer; // latest attempt is our current best

      if (isFinal) break; // no retry after the last attempt — take it

      const check = await verifyRoomEmptied(outBuffer, keepInstruction);
      if (check.empty) {
        if (DEBUG_MODE) console.log(`[Erase] verified clean on attempt ${attempt}`);
        break;
      }
      if (DEBUG_MODE) {
        console.log(`[Erase] attempt ${attempt} left items behind: ${check.remaining || 'unspecified'} — retrying`);
      }
      extraNote = `IMPORTANT: A previous removal attempt FAILED — it left these items in the room that you MUST now remove completely: ${check.remaining || 'all remaining furniture and decor'}. Erase them entirely and realistically reconstruct the floor and wall behind them.`;
      if (keepInstruction && keepInstruction.trim()) {
        extraNote += ` Still keep ONLY: ${keepInstruction.trim()} — remove everything else, including the leftover items just listed.`;
      }
    }

    if (!bestBuffer) return null;
    return {
      dataUrl: `data:image/png;base64,${bestBuffer.toString('base64')}`,
      buffer: bestBuffer,
    };
  } catch (error) {
    console.error('[Erase] furniture removal failed, falling back to single-pass staging:', error.message);
    return null;
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
const HOSTED_IMAGE_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function getHostedImagesDir() {
  const dir = path.join(getDataLogDir(), 'hosted-images');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error('[host-image] failed to create dir', e);
    }
  }
  return dir;
}

function getHostedImagesManifestPath() {
  return path.join(getHostedImagesDir(), 'index.json');
}

function readHostedImagesManifest() {
  try {
    const p = getHostedImagesManifestPath();
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[host-image] manifest read failed', e);
    return [];
  }
}

function writeHostedImagesManifest(arr) {
  try {
    fs.writeFileSync(getHostedImagesManifestPath(), JSON.stringify(arr, null, 2));
    return true;
  } catch (e) {
    console.error('[host-image] manifest write failed', e);
    return false;
  }
}

// Dedicated multer instance: safe raster types only (deliberately no SVG — it
// can carry script and would execute on our own origin), 25 MB cap to protect
// the persistent disk.
const hostImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (HOSTED_IMAGE_MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Only PNG, JPG, WebP, and GIF images can be hosted'));
  },
}).single('image');

// Tracked logo for broker outreach emails — ?email=broker@example.com
// NOTE: the multer upload-error handler lives AFTER the routers (see below), because
// all multer middleware runs inside routes/*.js and Express only reaches an error
// handler registered after the throwing route.

/** Public client id for Google Identity Services (Sign In With Google button). */
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
const healthHandler = (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    aiConfigured: !!genAI,
  });
};
// Uptime/status data for the public /status page. Computed from the heartbeat
// state on the persistent disk; no auth (it exposes only aggregate up/down).
// Prompt count endpoint (Rooms Staged)
// Contact count endpoint (Users Served = contact submissions + registered accounts)
// PDF Processing Proxy Endpoints
// Health check proxy
// PDF processing proxy endpoint
// Middleware to protect logs endpoints with password
function protectLogs(req, res, next) {
  setSensitiveHeaders(res);
  if (!LOGS_ACCESS_KEY) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Logs access key not configured'
    });
  }

  // Read the key from a header only — never the query string. A key in the URL
  // leaks via access logs, reverse-proxy logs, browser history, and Referer.
  const accessKey = req.get('X-Stagify-Endpoint-Key');
  if (accessKey && endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
    return next();
  }
  return res.status(403).json({
    error: 'Access denied',
    message: 'Valid access key required in the X-Stagify-Endpoint-Key header'
  });
}

/** Same `LOGS_ACCESS_KEY` as `/promptlogs`, `/api/send-email`, etc. */
function stagingEndpointKeyGuard(req, res, next) {
  if (!LOGS_ACCESS_KEY) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Endpoint access key not configured',
    });
  }
  const q = req.query && req.query.key;
  const h = req.headers['x-stagify-endpoint-key'];
  const k = (typeof q === 'string' && q) || (typeof h === 'string' && h.trim());
  if (k && k === LOGS_ACCESS_KEY) {
    return next();
  }
  return res.status(403).json({
    error: 'Access denied',
    message: 'Valid endpoint key required (?key= on URL or X-Stagify-Endpoint-Key header)',
  });
}

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
app.use(createAdminRouter({ authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, getMemoriesFile, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT }));

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
