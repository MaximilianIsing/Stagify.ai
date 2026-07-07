import './load-env.js'; // must be first: populates process.env from .env before any secret is read
import './instrument.js'; // Sentry init — must load before app libraries (no-ops without SENTRY_DSN)
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
import { promptMatrix } from './lib/promptMatrix.js';
import { blueprintTo3D } from './lib/cad-handling.js';
import { createAuthStore } from './lib/auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './lib/stripe-webhooks.js';
import { createEnterpriseStore } from './lib/enterprise-store.js';
import { createUptimeMonitor } from './lib/uptime-monitor.js';
import createBillingRouter from './routes/billing.js';
import { createEmail } from './lib/email.js';
import { createLogging } from './lib/logging.js';
import { createMemory } from './lib/memory.js';
import { createConfig } from './lib/config.js';
import { IMAGE_FRAMING_PRESERVATION_RULES, ADD_FURNITURE_PRESERVATION_SUFFIX, STAGIFY_LAUNCH_DATE, QUALITY_REVIEW_PROMPT, REVIEW_WHY_SUFFIX, MASK_REVIEW_PROMPT, FURNITURE_ERASE_PROMPT, EMPTY_ROOM_CHECK_PROMPT, STAGEABLE_IMAGE_CHECK_PROMPT, DEFAULT_UNSTAGEABLE_REASON } from './lib/prompts.js';
import createPublicRouter from './routes/public.js';
import createChatRouter from './routes/chat.js';
import createStagingRouter from './routes/staging.js';
import createAdminRouter from './routes/admin.js';
import createAuthRouter from './routes/auth.js';

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

/**
 * Headers for any response that carries secrets or PII: keep it out of shared
 * caches and stop the URL/Referer from leaking onward to third parties.
 */
function setSensitiveHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

function getAuthUserFromRequest(req) {
  let token = null;
  const h = req.headers.authorization;
  if (h && typeof h === 'string' && h.startsWith('Bearer ')) {
    token = h.slice(7).trim();
  }
  if (!token && req.body && typeof req.body === 'object' && req.body.authToken) {
    token = String(req.body.authToken).trim();
  }
  // Note: we intentionally do NOT read the session token from req.query — a token
  // in a URL leaks via access logs, browser history, and Referer headers. Use the
  // Authorization: Bearer header (or a POST body) instead.
  const user = authStore.validateSession(token);
  return enhanceUserWithEnterprise(user);
}

function enhanceUserWithEnterprise(user) {
  if (!user) return null;
  if (user.plan === 'pro') return user;
  const domain = user.email ? user.email.split('@')[1]?.toLowerCase() : null;
  if (domain && enterpriseStore.isActiveDomain(domain)) {
    return Object.assign({}, user, { plan: 'pro', enterpriseDomain: domain });
  }
  return user;
}

/** Public user payload for API responses — always reflects enterprise domain access. */
function toPublicAuthUser(user) {
  if (!user) return null;
  return authStore.publicUser(enhanceUserWithEnterprise(user));
}

function enterpriseDomainForUser(user) {
  if (!user) return null;

  // Individual Stagify+ subscribers (own Stripe customer) are not billed to the enterprise domain
  const stored = user.email ? authStore.findUserByEmail(user.email) : null;
  const account = stored || user;
  if (account.plan === 'pro' && account.stripeCustomerId) {
    return null;
  }

  const domain =
    user.enterpriseDomain ||
    (user.email ? user.email.split('@')[1]?.toLowerCase() : null);
  return domain && enterpriseStore.isActiveDomain(domain) ? domain : null;
}

/** Client IP for rate limits (honors X-Forwarded-For when behind a proxy). */
function getStagingClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 128);
  }
  const ip = req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '').slice(0, 128) || 'unknown';
}

/** Heuristic: anonymous mobile browsers may use IP-based free tier instead of signing in. */
function isLikelyMobileStagingRequest(req) {
  const ua = req.headers['user-agent'];
  if (!ua || typeof ua !== 'string') return false;
  return /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

const enterpriseMeterEventName = readEnterpriseMeterEventName();

function reportEnterpriseUsage(domain, quantity = 1) {
  // Always track locally so admin dashboard counts stay accurate (even without Stripe)
  enterpriseStore.recordUsage(domain, quantity);
  if (!stripe) return;
  const entry = enterpriseStore.getDomainEntry(domain);
  if (!entry || !entry.stripeCustomerId) {
    console.warn('[enterprise] Stripe meter skipped — no Stripe customer for domain:', domain);
    return;
  }
  stripe.billing.meterEvents
    .create({
      event_name: enterpriseMeterEventName,
      payload: {
        stripe_customer_id: entry.stripeCustomerId,
        value: String(quantity),
      },
    })
    .then(() => {
      console.log('[enterprise] Usage reported:', quantity, 'generation(s) for', domain);
    })
    .catch((err) => {
      console.error('[enterprise] Failed to report usage for', domain, ':', err.message);
    });
}

function requireProAccount(req, res) {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (user.plan !== 'pro') {
    res.status(403).json({ error: 'Stagify+ subscription required', code: 'PRO_REQUIRED' });
    return null;
  }
  return user;
}

// Global variable to track prompt count
let promptCount = 0;

// Global variable to track contact count
let contactCount = 0;

// Live accessors for the runtime counters, passed to route modules via deps so
// extracted routers read/increment the REAL module-scope values (not a stale
// snapshot copied at mount time). Increment uses += 1 (not ++) so a global
// "++" -> "inc" rewrite of the route bodies can never make these self-recurse.
function getPromptCount() { return promptCount; }
function incPromptCount() { promptCount += 1; }
function getContactCount() { return contactCount; }
function incContactCount() { contactCount += 1; }

// Function to initialize prompt count from CSV file
function initializePromptCount() {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      
      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      promptCount = matches ? matches.length : 0;
      if (DEBUG_MODE) {
        console.log('Prompt count successfully initialized from file:', promptCount);
      }
    } else {
      if (DEBUG_MODE) {
        console.log('No prompt log file found, starting with count 0');
      }
      promptCount = 0;
    }
  } catch (error) {
    console.error('Error initializing prompt count:', error);
    promptCount = 0;
  }
}

// Function to initialize contact count from CSV file
function initializeContactCount() {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      
      // Count rows that start with a timestamp (ISO format)
      // Each valid CSV row starts with a timestamp like "2024-01-01T12:34:56"
      const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gm;
      const matches = fileContent.match(timestampPattern);
      contactCount = matches ? matches.length : 0;
      if (DEBUG_MODE) {
        console.log('Contact count successfully initialized from file:', contactCount);
      }
    } else {
      if (DEBUG_MODE) {
        console.log('No contact log file found, starting with count 0');
      }
      contactCount = 0;
    }
  } catch (error) {
    console.error('Error initializing contact count:', error);
    contactCount = 0;
  }
}

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

app.use(express.json({ limit: '50mb' })); // Increased limit to handle conversation history with images
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
  limits: {
    fileSize: 100 * 1024 * 1024,
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
    fileSize: 100 * 1024 * 1024, // 100MB limit
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
    fileSize: 50 * 1024 * 1024, // 50MB limit per file
    fieldSize: 50 * 1024 * 1024, // 50MB limit for form fields (for conversation history with base64 images)
  },
  fileFilter: (req, file, cb) => {
    // Allow all files - let the AI handle unsupported file types
    cb(null, true);
  }
});

// External PDF processing server URL
const PDF_PROCESSING_SERVER = 'https://stagify-project-imagination.onrender.com';

// Debug mode - check environment variable first, then fall back to debug.txt
let DEBUG_MODE = false;
try {
  // Try environment variable first (Render), then fall back to local file
  let debugValue = process.env.DEBUG;
  if (debugValue === undefined) {
    const debugFile = path.join(__dirname, 'debug.txt');
    if (fs.existsSync(debugFile)) {
      debugValue = fs.readFileSync(debugFile, 'utf8').trim();
    }
  }
  if (debugValue !== undefined) {
    DEBUG_MODE = debugValue.toLowerCase() === 'true';
    if (DEBUG_MODE) {
      console.log(`Debug mode: ${DEBUG_MODE ? 'ENABLED' : 'DISABLED'}`);
    }
  }
} catch (error) {
  console.error('Error reading debug configuration:', error.message);
  DEBUG_MODE = false;
}

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

// Email debug mode - if true, redirect all outbound mail to DEBUG_EMAIL (for local/staging only).
// Default false so password reset and other mail reach the real recipient.
let EMAIL_DEBUG_MODE = false;
const DEBUG_EMAIL = 'maximilianbising@gmail.com';
try {
  let emailDebugValue = process.env.EMAIL_DEBUG;
  if (emailDebugValue === undefined) {
    const emailDebugFile = path.join(__dirname, 'emaildebug.txt');
    if (fs.existsSync(emailDebugFile)) {
      emailDebugValue = fs.readFileSync(emailDebugFile, 'utf8').trim();
    }
  }
  if (emailDebugValue !== undefined) {
    EMAIL_DEBUG_MODE = emailDebugValue.toLowerCase() === 'true';
  }
  if (EMAIL_DEBUG_MODE) {
    console.log(`Email debug mode: ENABLED - All emails will be sent to ${DEBUG_EMAIL}`);
  } else {
    console.log('Email debug mode: DISABLED - Emails go to actual recipients');
  }
} catch (error) {
  console.error('Error reading email debug configuration:', error.message);
  EMAIL_DEBUG_MODE = false;
  console.log('Email debug mode: DISABLED (default after error)');
}

// Helper function to get appropriate temperature for a model
// gpt-5-mini only supports temperature 1 (default), other models can use 0.7
function getTemperatureForModel(model) {
  if (model && model.includes('gpt-5')) {
    return 1; // gpt-5-mini only supports default temperature (1)
  }
  return 0.7; // Default for other models
}

// Helper function to map GPT model selection to Gemini image model
// Fast (gpt-4o-mini) → gemini-2.5-flash-image
// Pro/Stagify+ (gpt-5-mini) → gemini-3.1-flash-image (Nano Banana 2)
// Note: CAD floor-plan staging uses gemini-3-pro-image directly (see cad-handling.js)
function getGeminiImageModel(gptModel) {
  if (gptModel && gptModel.includes('gpt-5')) {
    return 'gemini-3.1-flash-image'; // Stagify+ quality
  }
  return 'gemini-2.5-flash-image'; // Fast model (default)
}

function getUserIdentifier(req) {
  // Try to get userId from request body
  if (req.body && req.body.userId) {
    return req.body.userId;
  }
  
  // Try to get email from request body
  if (req.body && req.body.userEmail && req.body.userEmail !== 'unknown') {
    return req.body.userEmail;
  }
  
  // Generate a user ID based on IP address (for anonymous users)
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Create a simple hash-like identifier from IP
  return `user_${ip.replace(/\./g, '_').replace(/:/g, '_')}`;
}

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

/**
 * Downscales an image to fit within 1920x1080 while maintaining aspect ratio
 */
async function downscaleImage(imageBuffer) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
      
    // Check if downscaling is needed
    if (metadata.width <= 1920 && metadata.height <= 1080) {
      return imageBuffer;
    }
    
    // Calculate the scaling factor to fit within 1920x1080 while maintaining aspect ratio
    const scaleWidth = 1920 / metadata.width;
    const scaleHeight = 1080 / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    const processedBuffer = await image
      .resize(newWidth, newHeight, {
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: true
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return processedBuffer;
  } catch (error) {
    console.error("Error downscaling image:", error);
    throw error;
  }
}

// Gemini image models don't strictly honor the input aspect ratio — they tend to
// "square up" wide/short rooms and return an image that's slightly taller (or
// wider) than the source. We correct this with a GENTLE non-uniform resize back
// to the source ratio (keep width, nudge height) — NOT a crop, so no content is
// lost and the result never looks zoomed-in. The correction is only applied when
// the drift is small enough to be imperceptible; larger drifts are left untouched
// (stretching them would distort the room more than the wrong ratio does, and
// they're better handled by regeneration). Fails open on any error.
const AR_NOOP_TOLERANCE = 0.01; // within 1% of source ratio — already fine, skip re-encode
const AR_MAX_CORRECTION = 0.08; // correct drifts up to 8%; beyond that, leave as-is
async function enforceAspectRatio(outputBuffer, targetWidth, targetHeight) {
  try {
    if (!targetWidth || !targetHeight) return outputBuffer;
    const targetRatio = targetWidth / targetHeight;
    const meta = await sharp(outputBuffer).metadata();
    if (!meta.width || !meta.height) return outputBuffer;
    const outRatio = meta.width / meta.height;
    const drift = Math.abs(outRatio - targetRatio) / targetRatio;
    if (drift < AR_NOOP_TOLERANCE) return outputBuffer; // close enough already
    if (drift > AR_MAX_CORRECTION) {
      if (DEBUG_MODE) {
        console.log(`[AspectRatio] drift ${(drift * 100).toFixed(1)}% exceeds ${AR_MAX_CORRECTION * 100}% cap — leaving output as-is (no zoom/distortion).`);
      }
      return outputBuffer;
    }
    // Keep the full width, adjust only the height to hit the source ratio. This is
    // a small stretch/squash — no cropping, no padding, all content preserved.
    const newHeight = Math.max(1, Math.round(meta.width / targetRatio));
    if (DEBUG_MODE) {
      console.log(`[AspectRatio] correcting ${(drift * 100).toFixed(1)}% drift: ${meta.width}x${meta.height} -> ${meta.width}x${newHeight}.`);
    }
    return await sharp(outputBuffer)
      .resize(meta.width, newHeight, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[AspectRatio] enforcement failed, returning model output as-is:', error.message);
    return outputBuffer;
  }
}

// Pad a reference/extra image with TRANSPARENT margins so its aspect ratio matches
// `targetAR` (room width / height). This stops Gemini from leaking the reference's
// own aspect ratio into the generated output. Only the short side grows — the
// subject is never scaled, stretched, or cropped, just framed in a room-shaped
// canvas. Returns { buffer, padded }; when padded the buffer is PNG (transparent
// alpha needs PNG). Pads only when the AR differs by more than `tol` (0 = any diff).
async function padBufferToAspectRatio(buffer, targetAR, tol = 0) {
  if (!targetAR || !isFinite(targetAR)) return { buffer, padded: false };
  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  if (!w || !h) return { buffer, padded: false };
  const ar = w / h;
  if (Math.abs(ar - targetAR) / targetAR <= tol) return { buffer, padded: false };
  let tw = w, th = h;
  if (ar > targetAR) th = Math.round(w / targetAR);       // too wide → grow height
  else if (ar < targetAR) tw = Math.round(h * targetAR);  // too tall → grow width
  if (tw === w && th === h) return { buffer, padded: false };
  const out = await sharp(buffer)
    .resize(tw, th, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { buffer: out, padded: true };
}

// Build a "locator" image for mask editing: the room with the brushed region's
// BORDER drawn as a bright magenta outline (NOT a fill — a fill tempts the model
// to reproduce it as a colored splotch in the output). The model generates from
// the CLEAN room and reads this copy only to see WHERE to edit, so the magenta
// never needs to appear in the result. Magenta is used because it is almost never
// a real room/furniture color, so "ignore it" is unambiguous. Throws on failure so
// the caller can fall back to the plain mask.
async function buildMarkedRoomImage(roomBuffer, maskBuffer, width, height) {
  const W = width, H = height;
  const THICK = Math.max(3, Math.round(Math.min(W, H) * 0.006)); // outline thickness, px
  const maskAlpha = await sharp(maskBuffer)
    .resize(W, H, { fit: 'fill' })
    .extractChannel(0) // white (255) inside the brushed area, 0 outside
    .raw()
    .toBuffer();
  const inside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inside[i] = maskAlpha[i] >= 128 ? 1 : 0;
  // Erode `inside` by THICK with a separable min-filter (O(W*H*THICK)); the outline
  // is the band that is inside but NOT in the eroded core — a clean border, no fill.
  const horiz = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let keep = 1;
      for (let dx = -THICK; dx <= THICK; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= W || !inside[row + nx]) { keep = 0; break; }
      }
      horiz[row + x] = keep;
    }
  }
  const rgba = Buffer.alloc(W * H * 4); // zero-filled → fully transparent by default
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const idx = y * W + x;
      if (!inside[idx]) continue;
      let eroded = 1;
      for (let dy = -THICK; dy <= THICK; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H || !horiz[ny * W + x]) { eroded = 0; break; }
      }
      if (!eroded) { // inside but on the border band → magenta outline
        rgba[idx * 4] = 255;     // R
        rgba[idx * 4 + 1] = 0;   // G
        rgba[idx * 4 + 2] = 255; // B
        rgba[idx * 4 + 3] = 255; // A (opaque)
      }
    }
  }
  const overlay = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return await sharp(roomBuffer)
    .resize(W, H, { fit: 'fill' })
    .composite([{ input: overlay, blend: 'over' }])
    .png()
    .toBuffer();
}

// Lock a mask-edit output back to the room's aspect ratio. Gemini "squares up" the
// AR, and the client composites by stretching the result onto the original canvas
// — so a drifted AR would warp the edit out of alignment with the untouched
// surroundings. A centered cover-crop restores the room ratio WITHOUT stretching
// (Gemini usually just adds ceiling/floor bands, so cropping them re-aligns the
// real content). Only acts when the AR actually drifted; fails open to the raw
// output. Returns a PNG data URL.
async function normalizeMaskOutputToRoom(base64Png, roomW, roomH) {
  try {
    const buf = Buffer.from(base64Png, 'base64');
    const meta = await sharp(buf).metadata();
    if (meta.width && meta.height && roomW && roomH) {
      const roomAR = roomW / roomH;
      const outAR = meta.width / meta.height;
      if (Math.abs(outAR - roomAR) / roomAR > 0.01) {
        const fixed = await sharp(buf).resize(roomW, roomH, { fit: 'cover' }).png().toBuffer();
        if (DEBUG_MODE) console.log(`[Mask Edit] AR drift corrected ${meta.width}×${meta.height} → ${roomW}×${roomH} (cover crop)`);
        return `data:image/png;base64,${fixed.toString('base64')}`;
      }
    }
  } catch (e) {
    console.warn('[Mask Edit] output AR normalization failed; returning raw output:', e.message);
  }
  return `data:image/png;base64,${base64Png}`;
}

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

async function downscaleImageForGPT(dataUrl) {
  try {
    // Extract base64 data and MIME type
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      if (DEBUG_MODE) {
        console.log('[Image Downscale] Invalid data URL format, returning original');
      }
      return dataUrl;
    }
    
    const mimeType = matches[1];
    const base64Data = matches[2];
    
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Get image metadata
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // OpenAI recommends max 2048x2048, but 1024x1024 is better for performance
    const maxDimension = 1024;
    
    // Check if downscaling is needed
    if (metadata.width <= maxDimension && metadata.height <= maxDimension) {
      if (DEBUG_MODE) {
        console.log(`[Image Downscale] Image ${metadata.width}x${metadata.height} is within limits, no downscaling needed`);
      }
      return dataUrl;
    }
    
    if (DEBUG_MODE) {
      console.log(`[Image Downscale] Downscaling image from ${metadata.width}x${metadata.height} to fit within ${maxDimension}x${maxDimension}`);
    }
    
    // Calculate the scaling factor to fit within maxDimension while maintaining aspect ratio
    const scaleWidth = maxDimension / metadata.width;
    const scaleHeight = maxDimension / metadata.height;
    const scale = Math.min(scaleWidth, scaleHeight);
    
    const newWidth = Math.floor(metadata.width * scale);
    const newHeight = Math.floor(metadata.height * scale);
    
    // Resize and convert to JPEG for smaller size (or keep original format if it's already JPEG)
    let processedBuffer;
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      // For other formats, convert to JPEG
      processedBuffer = await image
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
    
    // Convert back to base64 data URL
    const newBase64 = processedBuffer.toString('base64');
    const newDataUrl = `data:image/jpeg;base64,${newBase64}`;
    
    const originalSize = Buffer.byteLength(dataUrl, 'utf8');
    const newSize = Buffer.byteLength(newDataUrl, 'utf8');
    const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);
    
    if (DEBUG_MODE) {
      console.log(`[Image Downscale] Downscaled to ${newWidth}x${newHeight}, size reduced by ${reduction}%`);
    }
    
    return newDataUrl;
  } catch (error) {
    console.error('[Image Downscale] Error downscaling image:', error);
    // Return original if downscaling fails
    return dataUrl;
  }
}

/**
 * Appended to image-to-image staging/CAD prompts so outputs match input framing.
 */

/**
 * Generate styling prompt based on user preferences using a matrix system
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture) {

  // Add furniture removal instruction if requested. Callers pass a real boolean
  // (removeBool) in the live flow; older/string callers pass 'true' — accept both.
  removeFurniture = removeFurniture === true || removeFurniture === 'true';
  const furnitureRemovalText = removeFurniture
    ? "First, remove all existing furniture and decor from the room. Then, "
    : "CRITICAL — KEEP EXISTING FURNITURE: If the room already contains furniture or decor, you MUST preserve every existing piece exactly as it appears — do NOT remove, replace, delete, or relocate any furniture, decor, or belongings already in the photo. Keep their position, style, and appearance unchanged, and only add or rearrange NEW furnishings around what is already there to complete a professional staging. (If, and only if, the room is completely empty, stage it from scratch as normal.) ";
  
  // Build the base prompt
  let basePrompt = `Stage this ${roomType} professionally.`;
  
  // If custom style with additional prompt, use the additional prompt as the main instruction
  if (furnitureStyle === 'custom' && additionalPrompt && additionalPrompt.trim()) {
    basePrompt = additionalPrompt.trim();
  } else {
    // Get the specific prompt for this room type and style combination (fallback)
    basePrompt = promptMatrix[roomType]?.[furnitureStyle] || promptMatrix[roomType]?.['standard'] || basePrompt;
  }
  
  // Build the complete prompt
  let prompt = `${furnitureRemovalText}${basePrompt} 

CRITICAL ARCHITECTURAL PRESERVATION RULES:
- DO NOT alter, remove, modify, or change ANY architectural elements including: walls, windows, doors, door frames, window frames, ceilings, floors, floor patterns, room shape, room dimensions, structural elements, columns, beams, moldings, baseboards, trim, or any permanent fixtures
- DO NOT add, remove, or modify windows, doors, or any openings
- DO NOT change wall colors, textures, or materials unless explicitly requested by the user
- DO NOT alter the room's structure, layout, or architectural integrity
- PRESERVE all existing architectural features exactly as they appear in the original image

CRITICAL IMAGE FORMAT RULES:
${IMAGE_FRAMING_PRESERVATION_RULES}

TARGETED-EDIT RULE (when the user is refining an already-staged image):
- If the request is a specific change (e.g. "make the sofa leather", "warmer lighting", "swap the rug"), apply ONLY that change and keep EVERYTHING else identical — same furniture, decor, placement, colors, camera angle, and lighting as the input image. Do not re-stage the room from scratch or move/replace items that were not mentioned.

The architecture must remain completely unchanged. Ensure the result looks realistic and professionally staged with high quality, sharp focus, detailed textures, professional photography lighting, and ultra-realistic rendering.`;
  
  // If not custom or if custom but we want to emphasize the additional details
  if (furnitureStyle !== 'custom' && additionalPrompt && additionalPrompt.trim()) {
    prompt += ` Prioritize the following above everything else: ${additionalPrompt.trim()}`;
  }
  
  return prompt;
}

/**
 * Middleman filter to remove unsupported file types from content before sending to OpenAI
 * This ensures AVIF and other unsupported formats never reach GPT
 */
function filterUnsupportedFiles(content, files = []) {
  if (!Array.isArray(content)) {
    return content; // If not an array, return as-is
  }
  
  const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  const filteredContent = [];
  const unsupportedFiles = [];
  
  for (const item of content) {
    if (item.type === 'image_url' && item.image_url && item.image_url.url) {
      const url = item.image_url.url;
      
      // Check for AVIF in the data URL - only check MIME type, not filename
      const isAVIF = url.includes('data:image/avif') || 
                     url.includes('image/avif;');
      
      // Extract MIME type from data URL (format: data:image/jpeg;base64,...)
      const mimeMatch = url.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : '';
      
      // Check if MIME type is unsupported
      const isUnsupported = isAVIF || 
                           (mimeType.startsWith('image/') && !supportedImageTypes.includes(mimeType));
      
      if (isUnsupported) {
        // Find the corresponding file to get its name
        let fileName = 'the file';
        if (files && files.length > 0) {
          // Try to match by base64 data
          const base64Data = url.split(',')[1];
          if (base64Data) {
            const matchingFile = files.find(f => {
              try {
                const fileBase64 = f.buffer.toString('base64');
                return fileBase64.substring(0, 100) === base64Data.substring(0, 100);
              } catch {
                return false;
              }
            });
            if (matchingFile) {
              fileName = matchingFile.originalname;
            }
          }
        }
        
        const fileType = isAVIF ? 'AVIF' : (mimeType.split('/')[1]?.toUpperCase() || 'unsupported format');
        unsupportedFiles.push({ name: fileName, type: fileType });
        
        // Convert to text instead of image
        filteredContent.push({
          type: 'text',
          text: `I uploaded "${fileName}" but it is in ${fileType} format which is not supported.`
        });
      } else {
        // Supported image - keep it
        filteredContent.push(item);
      }
    } else {
      // Not an image - keep as-is
      filteredContent.push(item);
    }
  }
  
  return { filteredContent, unsupportedFiles };
}

/**
 * Filters unsupported files from conversation history messages
 */
// Deduplicate messages based on role and content
function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  
  const seen = new Set();
  const deduplicated = [];
  
  for (const msg of messages) {
    // Skip invalid messages
    if (!msg || !msg.role) {
      continue;
    }
    
    // Create a unique key based on role and content
    let key;
    if (Array.isArray(msg.content)) {
      // For array content, stringify the structure (without base64 data for images)
      const simplifiedContent = msg.content.map(item => {
        if (item.type === 'image_url' && item.image_url && item.image_url.url) {
          // For images, use a placeholder to avoid comparing base64 data
          return { type: 'image_url', image_url: { url: '[IMAGE_DATA]' } };
        } else if (item.type === 'text') {
          // Normalize text content (trim whitespace)
          return { type: 'text', text: (item.text || '').trim() };
        }
        return item;
      });
      // Sort array items to ensure consistent ordering
      simplifiedContent.sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        if (a.type === 'text' && b.type === 'text') {
          return (a.text || '').localeCompare(b.text || '');
        }
        return 0;
      });
      key = `${msg.role}:${JSON.stringify(simplifiedContent)}`;
    } else if (typeof msg.content === 'string') {
      // Normalize text content (trim whitespace) for consistent comparison
      key = `${msg.role}:${msg.content.trim()}`;
    } else {
      // Fallback for other content types
      key = `${msg.role}:${JSON.stringify(msg.content)}`;
    }
    
    // Only add if we haven't seen this exact message before
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(msg);
    } else {
      // Log when we skip a duplicate
      if (DEBUG_MODE) {
        const contentPreview = Array.isArray(msg.content) 
          ? `[${msg.content.length} items]` 
          : (typeof msg.content === 'string' ? msg.content.substring(0, 50) : 'non-string');
        console.log(`[Deduplication] Skipping duplicate ${msg.role} message: ${contentPreview}...`);
      }
    }
  }
  
  return deduplicated;
}

function filterConversationHistory(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const { filteredContent } = filterUnsupportedFiles(msg.content);
      return {
        ...msg,
        content: filteredContent
      };
    }
    return msg;
  });
}

/**
 * Strips images from conversation history messages (except current message)
 * This prevents payload size issues while keeping text context
 */
function stripImagesFromHistory(messages, keepCurrentMessageImages = false) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    const shouldKeepImages = keepCurrentMessageImages && isLastMessage && msg.role === 'user';
    
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (shouldKeepImages) {
        // Keep images in current message
        return msg;
      } else {
        // Replace images with filename references, keep text
        const textParts = [];
        let imageCount = 0;
        
        msg.content.forEach(item => {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else if (item.type === 'image_url') {
            imageCount++;
            // Try to extract filename from metadata or use generic name
            const filename = item.filename || item.originalname || (imageCount === 1 ? 'uploaded_image.jpg' : `image_${imageCount}.jpg`);
            const isStaged = item.isStaged || false;
            if (isStaged) {
              textParts.push(`[Staged image from previous message]`);
            } else {
              textParts.push(`[Image: ${filename}]`);
            }
          }
        });
        
        const textContent = textParts.join('\n\n');
        return {
          role: 'user',
          content: textContent || '[Previous message]'
        };
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Replace images with references, keep text
      const textParts = [];
      
      msg.content.forEach(item => {
        if (item.type === 'text') {
          textParts.push(item.text);
        } else if (item.type === 'image_url') {
          textParts.push(`[Staged image from previous message]`);
        }
      });
      
      const textContent = textParts.join('\n\n');
      return {
        role: 'assistant',
        content: textContent || '[Previous response]'
      };
    }
    return msg;
  });
}

/**
 * Collect all images from conversation history (index 0 = most recent).
 */
function collectImagesFromHistory(messages) {
  const imageMessages = [];
  if (!Array.isArray(messages)) return imageMessages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) => item.type === 'image_url' && item.image_url && item.image_url.url
      );
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        imageMessages.push({
          url: imageItem.image_url.url,
          isStaged: false,
          isGenerated: false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null,
        });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) =>
          item.type === 'image_url' &&
          item.image_url &&
          item.image_url.url &&
          (item.isStaged || item.isGenerated)
      );
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        imageMessages.push({
          url: imageItem.image_url.url,
          isStaged: imageItem.isStaged || false,
          isGenerated: imageItem.isGenerated || false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null,
        });
      }
    }
  }
  return imageMessages;
}

/**
 * When the client includes the current upload in conversationHistory, exclude that
 * trailing user message so image context does not count the same file twice.
 */
function getPriorHistoryForImageContext(conversationHistory, currentUploadFilenames) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return conversationHistory || [];
  }
  if (!currentUploadFilenames || currentUploadFilenames.length === 0) {
    return conversationHistory;
  }
  const last = conversationHistory[conversationHistory.length - 1];
  if (last.role !== 'user' || !Array.isArray(last.content)) {
    return conversationHistory;
  }
  const lastImageNames = last.content
    .filter((item) => item.type === 'image_url' && item.image_url && item.image_url.url)
    .map((item) => item.filename || item.originalname)
    .filter(Boolean);
  if (lastImageNames.length === 0) {
    return conversationHistory;
  }
  const currentSet = new Set(currentUploadFilenames);
  const duplicatesCurrentUpload = lastImageNames.every((name) => currentSet.has(name));
  if (duplicatesCurrentUpload) {
    return conversationHistory.slice(0, -1);
  }
  return conversationHistory;
}

function parseBaseImageIndex(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function getBaseImageSelectionContext(baseImageIndex, messages) {
  if (baseImageIndex === null) return '';
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return '';
  const img = images[baseImageIndex];
  const typeLabel = img.isStaged ? 'staged' : img.isGenerated ? 'generated/CAD' : 'uploaded';
  const name = img.filename ? ` (${img.filename})` : '';
  return (
    `\n\nUSER UI SELECTION: The user selected image index ${baseImageIndex} in the thumbnail strip as the base for this request — ${typeLabel} image${name}. ` +
    `For staging or CAD that modifies an existing image in this turn, use index ${baseImageIndex} for usePreviousImage or imageIndex unless they clearly meant a different image or are only doing text-to-image generation. ` +
    `If they are adding, placing, or staging furniture, put it IN THIS selected room (index ${baseImageIndex}). The selected image is the room to modify — not the furniture reference, unless it is clearly only a product photo with no room context.`
  );
}

function applyBaseImageIndexToStagingParams(stagingParams, baseImageIndex, messages, options = {}) {
  if (baseImageIndex === null || !stagingParams) return stagingParams;
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return stagingParams;

  const { userMessage = '', currentMessageHasImage = false } = options;
  const addingFurniture = currentMessageHasImage && userWantsToAddFurnitureToRoom(userMessage);

  if (currentMessageHasImage && !addingFurniture) {
    return stagingParams;
  }

  if (addingFurniture && currentMessageHasImage) {
    return { ...stagingParams, usePreviousImage: baseImageIndex, furnitureImageIndex: null };
  }

  if (addingFurniture) {
    return { ...stagingParams, usePreviousImage: baseImageIndex };
  }

  return { ...stagingParams, usePreviousImage: baseImageIndex };
}

function resolveCadImageIndex(cadRequest, baseImageIndex, messages, currentMessageHasImage = false) {
  const aiIndex = typeof cadRequest.imageIndex === 'number' ? cadRequest.imageIndex : 0;
  if (baseImageIndex === null || currentMessageHasImage) return aiIndex;
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return aiIndex;
  return baseImageIndex;
}

function findMostRecentStagedImageIndex(messages) {
  const imageMessages = collectImagesFromHistory(messages);
  const idx = imageMessages.findIndex((img) => img.isStaged);
  return idx >= 0 ? idx : null;
}

function userWantsToAddFurnitureToRoom(messageText) {
  if (!messageText || typeof messageText !== 'string') return false;
  const m = messageText.toLowerCase();
  if (/\b(this|that|the)\s+(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair)\b/.test(m)) {
    return true;
  }
  if (/\badd (this|the|that|my|a)\b/.test(m) && /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|it)\b/.test(m)) {
    return true;
  }
  return (
    /\b(add|include|put|place|incorporate|insert|use)\b/.test(m) &&
    /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|item|this|it|these|that)\b/.test(m)
  );
}

function isLikelyFurnitureReferenceImage(img) {
  if (!img || img.isStaged || img.isGenerated) return false;
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms = /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture|stool|bench|nightstand|credenza|sideboard|recliner)\b/;
  const roomTerms = /\b(room|living|bedroom|kitchen|bathroom|dining|office|interior|staging|staged|floor plan|blueprint|empty)\b/;
  return furnitureTerms.test(hay) && !roomTerms.test(hay);
}

function isRoomImageForFurniturePlacement(img) {
  if (!img) return false;
  if (img.isStaged || img.isGenerated) return true;
  return !isLikelyFurnitureReferenceImage(img);
}

function classifyUploadImageRole(img) {
  if (!img) return 'unknown';
  if (img.isStaged || img.isGenerated) return 'room';
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms =
    /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture piece|product shot|isolated|white background|dining chair|sectional|nightstand|stool|bench|credenza|sideboard|recliner)\b/;
  const roomTerms =
    /\b(room|living room|bedroom|kitchen|bathroom|dining room|office|interior|empty room|unfurnished|listing photo|real estate|walls|windows|floor|space)\b/;
  const furnitureHit = furnitureTerms.test(hay);
  const roomHit = roomTerms.test(hay);
  if (furnitureHit && !roomHit) return 'furniture';
  if (roomHit && !furnitureHit) return 'room';
  if (isLikelyFurnitureReferenceImage(img)) return 'furniture';
  if (roomHit) return 'room';
  return 'unknown';
}

function partitionDualUploadEntries(entries) {
  const rooms = entries.filter((e) => e.role === 'room');
  const furniture = entries.filter((e) => e.role === 'furniture');
  const unknown = entries.filter((e) => e.role === 'unknown');

  if (rooms.length >= 1 && furniture.length >= 1) {
    return { room: rooms[0], furniture: [...furniture, ...unknown] };
  }
  if (rooms.length === 1 && unknown.length >= 1 && furniture.length === 0) {
    return { room: rooms[0], furniture: unknown };
  }
  if (furniture.length === 1 && unknown.length >= 1 && rooms.length === 0) {
    return { room: unknown[0], furniture };
  }
  if (entries.length === 2 && rooms.length === 0 && furniture.length === 0) {
    // Common upload order: furniture first, room second
    return { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  return null;
}

function resolveDualUploadStaging(files, annotatedUserContent, message) {
  const imageFiles = (files || []).filter((f) => f.mimetype && f.mimetype.startsWith('image/'));
  if (imageFiles.length < 2) return null;

  const entries = imageFiles
    .map((file) => {
      const contentItem = (annotatedUserContent || []).find(
        (item) =>
          item.type === 'image_url' &&
          (item._filename === file.originalname || item.filename === file.originalname)
      );
      const meta = {
        filename: file.originalname,
        annotation: contentItem?._annotation || contentItem?.annotation || null,
      };
      return {
        buffer: file.buffer,
        role: classifyUploadImageRole(meta),
        filename: file.originalname,
      };
    })
    .filter((e) => e.buffer);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  if (DEBUG_MODE) {
    console.log(
      `[Staging] Dual upload split: room="${partition.room.filename}", furniture=[${partition.furniture.map((f) => f.filename).join(', ')}]`
    );
  }

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'current upload (room + furniture)',
  };
}

function resolveDualUploadFromMessageContent(userMessageContent, message) {
  if (!Array.isArray(userMessageContent)) return null;
  const imageItems = userMessageContent.filter(
    (item) => item.type === 'image_url' && item.image_url && item.image_url.url
  );
  if (imageItems.length < 2) return null;

  const entries = imageItems
    .map((item) => {
      const meta = {
        filename: item.filename || item.originalname,
        annotation: item._annotation || item.annotation || null,
      };
      const b64 = item.image_url.url.split(',')[1];
      if (!b64) return null;
      return {
        buffer: Buffer.from(b64, 'base64'),
        role: classifyUploadImageRole(meta),
        filename: meta.filename || 'upload',
      };
    })
    .filter(Boolean);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'message upload (room + furniture)',
  };
}


function resolveTargetRoomImageIndex(messages, options = {}) {
  const { baseImageIndex = null, userMessage = '' } = options;
  const images = collectImagesFromHistory(messages);

  if (baseImageIndex !== null && baseImageIndex < images.length) {
    if (isRoomImageForFurniturePlacement(images[baseImageIndex])) {
      return baseImageIndex;
    }
  }

  const stagedIndex = findMostRecentStagedImageIndex(messages);
  if (stagedIndex !== null) return stagedIndex;

  const roomCandidates = images
    .map((img, index) => ({ img, index }))
    .filter(({ img }) => isRoomImageForFurniturePlacement(img));

  if (roomCandidates.length === 1) {
    return roomCandidates[0].index;
  }

  const m = (userMessage || '').toLowerCase();
  if (/\b(original|first|initial)\b/.test(m) && /\b(room|image|photo)\b/.test(m)) {
    const orig = getOriginalImageIndex(messages);
    if (orig !== null) return orig;
  }

  if (/\b(that|this|the)\s+(room|space|listing|photo)\b/.test(m) || /\bstaged room\b/.test(m)) {
    if (roomCandidates.length > 0) return roomCandidates[0].index;
  }

  return null;
}


/**
 * When the user uploads a furniture reference to add to an existing staged room,
 * force the staged room as the base image and the upload as furniture reference.
 */
function applyAddFurnitureStagingFallback(stagingParams, userMessage, historyMessages, options = {}) {
  const { currentMessageHasImage = false, currentImageBuffer = null, baseImageIndex = null } = options;
  if (!userWantsToAddFurnitureToRoom(userMessage)) {
    return { stagingParams, furnitureFromCurrentUpload: null };
  }

  const roomIndex = resolveTargetRoomImageIndex(historyMessages, { baseImageIndex, userMessage });
  if (roomIndex === null) {
    return { stagingParams, furnitureFromCurrentUpload: null };
  }

  const next = { ...stagingParams, preserveExistingStaging: true };
  if (!next.additionalPrompt || !next.additionalPrompt.includes('already-staged room')) {
    next.additionalPrompt = (next.additionalPrompt || '') + ADD_FURNITURE_PRESERVATION_SUFFIX;
  }

  if (currentMessageHasImage) {
    next.usePreviousImage = roomIndex;
    next.furnitureImageIndex = null;
    if (DEBUG_MODE) {
      console.log(`[Staging] Add-furniture fallback: room index ${roomIndex}, furniture from current upload`);
    }
    return { stagingParams: next, furnitureFromCurrentUpload: currentImageBuffer };
  }

  if (next.usePreviousImage === false || next.usePreviousImage === null) {
    next.usePreviousImage = roomIndex;
  }
  if (DEBUG_MODE) {
    console.log(`[Staging] Add-furniture fallback: modifying room at index ${roomIndex}`);
  }
  return { stagingParams: next, furnitureFromCurrentUpload: null };
}

/**
 * Extracts image from conversation history by index (0 = most recent, 1 = second most recent, etc.)
 * Returns the image data URL or null if not found
 */
function getImageFromHistory(messages, imageIndex = 0) {
  if (!Array.isArray(messages)) {
    if (DEBUG_MODE) {
      console.log(`[getImageFromHistory] Messages is not an array:`, typeof messages);
    }
    return null;
  }

  const imageMessages = collectImagesFromHistory(messages);

  if (DEBUG_MODE) {
    console.log(`[getImageFromHistory] Total images found: ${imageMessages.length}, requested index: ${imageIndex}`);
    imageMessages.forEach((img, idx) => {
      const kind = img.isStaged ? 'staged' : img.isGenerated ? 'generated' : 'user-uploaded';
      console.log(`[getImageFromHistory] Found ${kind} image at index ${idx}, filename: ${img.filename || 'unknown'}`);
    });
  }

  // Return the image at the requested index (0 = most recent)
  if (imageIndex >= 0 && imageIndex < imageMessages.length) {
    return imageMessages[imageIndex];
  }

  // If requested index doesn't exist but we have images, return the most recent (index 0) as fallback
  if (imageMessages.length > 0) {
    if (DEBUG_MODE) {
      console.log(`[getImageFromHistory] Requested index ${imageIndex} not found, returning most recent image (index 0) as fallback`);
    }
    return imageMessages[0];
  }

  return null;
}

/**
 * Builds image context with annotations for GPT system instructions
 * Returns an object with imageContext string and imagesSentToGPT array
 */
function buildImageContext(messages) {
  const imageMessages = [];
  const imagesSentToGPT = []; // Separate list of images that were sent to GPT (for assistant messages)
  
  if (!Array.isArray(messages)) {
    return { imageContext: '', imagesSentToGPT: [], originalImageIndex: null };
  }
  
  // Collect ALL images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Get ALL images from this message
      const imageItems = msg.content.filter(item => item.type === 'image_url' && item.image_url && item.image_url.url);
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({ 
          index: imageMessages.length, 
          type: 'user-uploaded', 
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // User-uploaded images are sent to GPT
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: 'user-uploaded',
          filename: filename,
          annotation: annotation
        });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Get ALL staged and generated images from this message
      const imageItems = msg.content.filter(item => 
        item.type === 'image_url' && 
        item.image_url && 
        item.image_url.url && 
        (item.isStaged || item.isGenerated)
      );
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const imageType = imageItem.isStaged ? 'staged' : 'generated';
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({ 
          index: imageMessages.length, 
          type: imageType, 
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // AI-generated images are also sent to GPT in future messages
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: imageType,
          filename: filename,
          annotation: annotation
        });
      }
    }
  }
  
  // Find the original (first) user-uploaded image
  const userUploadedImages = imageMessages.filter(img => img.type === 'user-uploaded');
  let originalImageIndex = null;
  if (userUploadedImages.length > 0) {
    originalImageIndex = userUploadedImages[userUploadedImages.length - 1].index;
  }
  
  // Build image context string
  let imageContext = '';
  if (imageMessages.length > 0) {
    imageContext = '\n\nAvailable images in conversation history (index 0 = most recent, higher index = older):\n';
    imageMessages.forEach((img, idx) => {
      let description = `${img.type} image`;
      if (img.filename) {
        description += ` (filename: ${img.filename})`;
      }
      if (img.annotation) {
        // Parse CAD classification from annotation
        const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
        const isCAD = cadMatch ? cadMatch[1].toLowerCase() === 'true' : false;
        // Remove CAD classification from description for cleaner display, but show it separately
        const annotationWithoutCAD = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        description += ` - ${annotationWithoutCAD}`;
        description += ` [CAD: ${isCAD ? 'True' : 'False'}]`;
      } else {
        // If no annotation, default to False for CAD
        description += ` [CAD: False]`;
      }
      if (idx === originalImageIndex) {
        description += ' [ORIGINAL/FIRST USER-UPLOADED IMAGE]';
      }
      imageContext += `- Index ${idx}: ${description}\n`;
    });
    if (originalImageIndex !== null) {
      imageContext += `\nIMPORTANT: The "original image" or "first image" is at index ${originalImageIndex}. When the user says "original image", "first image", "initial image", "go back to the original", or "refer back to the original image", use index ${originalImageIndex} in the staging request.`;
    }
    imageContext += `\nIMPORTANT: When multiple images are uploaded in the same message, they are indexed separately. Use the filename and annotation to identify which image the user is referring to (e.g., if user says "add this chair", look for an image with "chair" in the filename or annotation).`;
    imageContext += `\nIMPORTANT: All images in the list above (user-uploaded, staged, generated, and CAD-staging renders) can be recalled using the recall function. Generated and staged images you created are included in this list and can be recalled by their index.`;
    
    // Add separate list of images sent to GPT
    if (imagesSentToGPT.length > 0) {
      imageContext += `\n\nImages sent to GPT in previous messages (for reference when building responses):\n`;
      imagesSentToGPT.forEach((img, idx) => {
        // Parse CAD classification from annotation
        let cadStatus = 'False';
        let annotationText = img.annotation || '';
        if (img.annotation) {
          const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
          cadStatus = cadMatch ? cadMatch[1] : 'False';
          // Remove CAD classification from annotation text for cleaner display
          annotationText = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        }
        let description = `${img.type} image`;
        if (img.filename) {
          description += ` (filename: ${img.filename})`;
        }
        if (annotationText) {
          description += ` - ${annotationText}`;
        }
        description += ` [CAD: ${cadStatus}]`;
        imageContext += `- GPT Image ${idx}: ${description}\n`;
      });
    }
  }
  
  return { imageContext, imagesSentToGPT, originalImageIndex };
}

/**
 * Gets the index of the original (first) user-uploaded image in the conversation history
 * Returns null if no original image is found
 */
function getOriginalImageIndex(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  
  const userUploadedImages = [];
  
  // Collect all user-uploaded images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItem = msg.content.find(item => item.type === 'image_url');
      if (imageItem && imageItem.image_url && imageItem.image_url.url) {
        userUploadedImages.push({
          index: userUploadedImages.length,
          messageIndex: i
        });
      }
    }
  }
  
  // The original image is at the highest index (oldest)
  if (userUploadedImages.length > 0) {
    return userUploadedImages[userUploadedImages.length - 1].index;
  }
  
  return null;
}

/** Shared prompt block: clarify ambiguity before acting; never ask and trigger image actions in the same turn. */


// Self-knowledge: facts about Stagify the AI Designer can draw on when a user
// asks about the product, company, team, pricing, or features. Keep this as the
// single source of truth — update here if any fact changes.

// The model has no idea what today's date is, so left alone it guesses (e.g.
// "today is 2023, so Stagify launches in the future"). Give it the real current
// date plus the already-computed age so it never has to do date math itself.
function getStagifyDateContext() {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  const todayStr = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;

  let ageStr;
  if (now < STAGIFY_LAUNCH_DATE) {
    ageStr = 'Stagify has not launched yet';
  } else {
    let months = (now.getUTCFullYear() - STAGIFY_LAUNCH_DATE.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - STAGIFY_LAUNCH_DATE.getUTCMonth());
    if (now.getUTCDate() < STAGIFY_LAUNCH_DATE.getUTCDate()) months -= 1;
    if (months < 1) {
      ageStr = 'Stagify is less than a month old';
    } else if (months < 12) {
      ageStr = `Stagify is about ${months} month${months === 1 ? '' : 's'} old`;
    } else {
      const years = Math.floor(months / 12);
      const rem = months % 12;
      ageStr = `Stagify is about ${years} year${years === 1 ? '' : 's'}` +
        (rem ? ` and ${rem} month${rem === 1 ? '' : 's'}` : '') + ' old';
    }
  }
  return `\n\nCURRENT DATE (authoritative — use this and do NOT assume any other date): Today is ${todayStr}. ` +
    `Stagify launched on August 22, 2025, so as of today, ${ageStr}. ` +
    `When asked how old Stagify is, state that age; never say it launches in the future.`;
}

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


// Parse a routing completion. Strict mode can return a `refusal` instead of
// `content`; surface that as a plain (non-actionable) reply rather than throwing
// on JSON.parse(null), so a rare refusal degrades gracefully.
function parseDesignerRoutingCompletion(completion) {
  const message = completion?.choices?.[0]?.message;
  if (message && message.refusal) {
    return { response: message.refusal };
  }
  return JSON.parse(message.content);
}

/**
 * True when the assistant response is asking the user for input before acting.
 * Used to suppress staging/generate/cad if the model sets both questions and actions.
 */
function aiResponseDefersImageAction(responseText) {
  if (!responseText || typeof responseText !== 'string') return false;
  const t = responseText.trim().toLowerCase();
  if (/\bhere('s| is)\b.*\b(staged|staging result|your room)\b/.test(t)) return false;
  if (/\bi('ve| have) (staged|created|generated)\b/.test(t)) return false;
  const deferPatterns = [
    /\bcould you (please )?(provide|share|tell|describe|specify|clarify|let me know|confirm)\b/,
    /\bcan you (please )?(provide|share|tell|describe|specify|clarify|let me know|confirm)\b/,
    /\bplease (provide|share|tell|describe|specify|clarify|confirm)\b/,
    /\bwhat (style|color|colour|type|kind|theme|furniture|decor|preference|look|vibe|aesthetic)s?\b/,
    /\bwhich (style|color|colour|theme|look|aesthetic|image|room|option|one)\b/,
    /\bmore (details|information|about|specifics|context)\b/,
    /\bany (preferences|specific|details|requirements)\b/,
    /\bdo you have (specific|any|particular)\b/,
    /\bfor example,?\s*what\b/,
    /\bwould you (like to|prefer to|want to) (share|tell|specify|describe|clarify)\b/,
    /\blet me know (what|which|if|about|your|how)\b/,
    /\bbefore i (stage|generate|create|proceed|start)\b/,
    /\bi('d| would) like to (know|understand|clarify)\b/,
    /\bto make sure\b/,
    /\bnot sure (which|what|if)\b/,
    /\ba few (quick )?questions\b/,
    /\bquick question\b/,
  ];
  if (!deferPatterns.some((p) => p.test(t))) return false;
  return t.includes('?');
}

function wantsStreamedChatResponse(req) {
  const body = req.body || {};
  return (
    body.streamResponse === true ||
    body.streamResponse === 'true' ||
    req.query?.stream === '1' ||
    req.headers['x-stream-response'] === '1'
  );
}

function chatWillProcessSlowImages(stagingReq, generateReq, cadReq) {
  if (stagingReq) {
    const reqs = Array.isArray(stagingReq) ? stagingReq : [stagingReq];
    if (reqs.some((s) => s && s.shouldStage)) return true;
  }
  if (generateReq) {
    const reqs = Array.isArray(generateReq) ? generateReq : [generateReq];
    if (reqs.some((g) => g && g.shouldGenerate && g.prompt)) return true;
  }
  if (cadReq) {
    const reqs = Array.isArray(cadReq) ? cadReq : [cadReq];
    if (reqs.some((c) => c && c.shouldProcessCAD)) return true;
  }
  return false;
}

// Map the AI's decided intent to a loading-status category the client shows
// during the (slow) image phase — language-independent, unlike keyword guessing.
function chatIntentType(stagingReq, generateReq, cadReq) {
  const some = (r, k) => {
    const arr = Array.isArray(r) ? r : [r];
    return arr.some((x) => x && x[k]);
  };
  if (some(cadReq, 'shouldProcessCAD')) return 'staging';
  if (some(stagingReq, 'shouldStage')) return 'staging';
  if (some(generateReq, 'shouldGenerate')) return 'generating';
  return 'general';
}

function initChatSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function writeChatSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractChatImagePayload(fullResponse) {
  const payload = { response: fullResponse.response };
  const keys = [
    'stagedImage',
    'stagedImages',
    'stagingParams',
    'stagedImageAnnotations',
    'generatedImage',
    'generatedImages',
    'generatedImageAnnotations',
    'cadImage',
    'cadImages',
    'cadParams',
    'cadImageAnnotation',
    'cadImageAnnotations',
    'requestedImage',
    'recalledImage',
    'imageAnnotations',
    'files',
  ];
  for (const key of keys) {
    if (fullResponse[key] !== undefined) {
      payload[key] = fullResponse[key];
    }
  }
  return payload;
}

function finishStreamedChatResponse(res, fullResponse) {
  writeChatSseEvent(res, 'images', extractChatImagePayload(fullResponse));
  writeChatSseEvent(res, 'done', {});
  res.end();
}

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

// Composite the model's raw output onto the original through the mask — edited
// pixels only inside the white mask region, original everywhere else — so the QA
// reviewer judges the COMBINED result the user actually receives (not raw output
// that may have drifted outside the mask). Falls back to the raw output on error.
async function compositeForReview(originalBuf, maskBuf, editedDataUrl, width, height) {
  try {
    const editedBuf = Buffer.from(editedDataUrl.split(',')[1], 'base64');
    // Mask's red channel = blend weight (white inside the brushed area).
    const maskAlpha = await sharp(maskBuf)
      .resize(width, height, { fit: 'fill' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    const editedRaw = await sharp(editedBuf)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 0; i < width * height; i++) {
      editedRaw[i * 4 + 3] = maskAlpha[i]; // keep edited only where the mask is white
    }
    const editedPng = await sharp(editedRaw, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const composite = await sharp(originalBuf)
      .resize(width, height, { fit: 'fill' })
      .composite([{ input: editedPng, blend: 'over' }])
      .png()
      .toBuffer();
    return `data:image/png;base64,${composite.toString('base64')}`;
  } catch (e) {
    console.error('[Mask QA] composite for review failed, reviewing raw output:', e.message);
    return editedDataUrl;
  }
}

// Run an image-producing function up to QUALITY_MAX_ATTEMPTS times, returning the
// first "perfect" result or, failing that, the highest-scoring one.
// `generateOnce(attempt)` must resolve to a data-URL string (or throw).
// `onImageProduced(attempt)` (optional) fires once for every attempt that
// actually yields an image — used to meter billing per generation attempt
// (including quality-gate retries).
async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null, reviewFn = null, maxAttempts = QUALITY_MAX_ATTEMPTS) {
  let best = null; // { url, score }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let url;
    try {
      url = await generateOnce(attempt);
    } catch (error) {
      lastError = error;
      if (DEBUG_MODE && attempt < maxAttempts) {
        console.log(`[Quality] ${label}: regenerating — attempt ${attempt}/${maxAttempts} failed to produce an image (${error.message}).`);
      }
      continue; // try again; if all fail we rethrow below
    }
    if (!url) continue;
    if (typeof onImageProduced === 'function') onImageProduced(attempt);
    const { perfect, score } = await (reviewFn ? reviewFn(url) : reviewImageQuality(url));
    if (DEBUG_MODE) {
      console.log(`[Quality] ${label} attempt ${attempt}/${maxAttempts}: ${perfect ? 'perfect — accepted' : `not perfect (score ${score})`}`);
    }
    if (perfect) return url;
    if (!best || score > best.score) best = { url, score };
    // A regeneration is about to happen (unless this was the last allowed attempt).
    if (DEBUG_MODE && attempt < maxAttempts) {
      console.log(`[Quality] ${label}: regenerating — attempt ${attempt} was not perfect (quality score ${score}).`);
    }
  }
  if (best) {
    if (DEBUG_MODE) {
      console.log(`[Quality] ${label}: no attempt was perfect; returning best (score ${best.score}).`);
    }
    return best.url;
  }
  // Never produced an image at all — surface the last generation error.
  throw lastError || new Error('Image generation failed');
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

function normalizeFurnitureBuffers(furnitureImageInput) {
  if (!furnitureImageInput) return [];
  const raw = Array.isArray(furnitureImageInput) ? furnitureImageInput : [furnitureImageInput];
  return raw.filter((b) => b && Buffer.isBuffer(b)).slice(0, 5);
}

// When the extra image(s) are an aesthetic/style reference rather than specific
// furniture to place, instruct the model to emulate the look — not copy objects.
function styleReferencePromptSuffix(count) {
  if (count <= 0) return '';
  const listText =
    count === 1
      ? 'The second image is'
      : 'The additional images after the room photo are';
  return `\n\nIMPORTANT: ${listText} a STYLE REFERENCE, not furniture to copy. Match its overall aesthetic — color palette, materials, mood, and design style — when staging the room. Do NOT copy its exact objects, layout, room, or camera angle. The first image is the room to stage; keep that room's architecture, dimensions, windows, and viewpoint unchanged.`;
}

function maskReferencePromptSuffix() {
  return '\n\nIMPORTANT — REFERENCE IMAGE: A final reference image is provided as the LAST image (after the room photo and the highlighted room). Treat it as the visual source for the user\'s instruction above — typically the specific furniture, decor, object, fixture, material, or finish they want applied inside the white masked region. Recreate the referenced subject so it is clearly the SAME item — keep its design, colors, materials, textures, proportions, and distinctive details. Its IDENTITY is what must stay faithful, NOT its camera angle or orientation: you SHOULD and MUST freely ROTATE, turn, and re-angle the subject — even showing it from a completely different side than the reference photo — whenever that is needed to fit the masked area and sit naturally in the room. Re-orient it to match the room\'s perspective and vanishing lines and to rest correctly on the floor, surface, or along the wall the user indicates (for example, turn a sofa shown head-on in the reference so it runs ALONG the wall in proper receding perspective, rather than facing the camera). Never refuse to rotate or re-angle the object just to keep the reference\'s original viewpoint — preserving the reference camera angle at the cost of a natural fit is WRONG. Then adapt it to the scene so it looks naturally photographed in place — match the masked area\'s perspective, scale, lighting direction, shadows, and reflections, ground it realistically with correct contact shadows and no floating, and render it as a fully opaque, solid object — never semi-transparent, see-through, or ghosted. Use ONLY the physical object/subject from the reference image — treat it as a clean cut-out and extract just that object. COMPLETELY DISCARD everything in the reference that is not the object itself: its background and backdrop (including any plain white, grey, gradient, or studio backdrop), the floor or surface it stands on in the reference, its own lighting, framing, watermarks, surrounding objects, and any transparent or empty padding. NEVER copy, paint, extend, or bleed the reference\'s background or backdrop into the room — do NOT add a white, pale, or colored patch, panel, slab, rug, or floor area taken from the reference, and do NOT mistake the reference\'s backdrop for floor, wall, or surface. The object must sit directly on the room\'s OWN existing floor or surface, surrounded only by the room\'s existing content, with fresh contact shadows that match the room\'s lighting. Apply the result strictly within the white masked region and blend its edges seamlessly with the surroundings. Size the referenced subject so the WHOLE of it — including any legs, overhang, and contact shadow — fits completely inside the white masked region with a small margin from the edge; scale it down as needed and never let any part reach, touch, or cross the white boundary, or it will be cut off. Do not change anything outside the mask. The OUTPUT image MUST keep the EXACT same width, height, and aspect ratio as the FIRST (room) image — never resize, crop, stretch, or reshape the output to match the reference image\'s dimensions.';
}

function furnitureReferencePromptSuffix(count, preserveExistingStaging = false) {
  if (count <= 0) return '';
  const listText =
    count === 1
      ? 'The second image'
      : count === 2
        ? 'The second and third images'
        : 'The second, third, and fourth images';
  const pieceWord = count === 1 ? 'piece' : 'pieces';
  let suffix = `\n\nIMPORTANT: ${listText} provided after the room photo ${count === 1 ? 'is' : 'are'} reference furniture ${pieceWord} that the user wants incorporated into the staged room. Match each item's style, color, and appearance as closely as possible. Use all reference images as guidance for what to place in the space. Use ONLY the furniture object(s) themselves — treat each reference as a clean cut-out. COMPLETELY DISCARD everything in the reference photos that is not the furniture: any plain white, grey, gradient, or studio backdrop, the floor or surface the item sits on in the reference, its own lighting, framing, watermarks, and surrounding objects. NEVER copy, paint, or bleed a reference's background into the room — do NOT add a white, pale, or colored patch, panel, slab, rug, or floor area from it, and do NOT mistake a reference's backdrop for floor, wall, or surface. Place each piece directly onto the room's own existing floor or surface, with fresh contact shadows that match the room's lighting.`;
  if (preserveExistingStaging) {
    suffix +=
      '\n\nCRITICAL: The first image is an ALREADY-STAGED ROOM. Keep every existing element in that photo exactly as shown — same walls, windows, layout, camera angle, lighting, and all furniture/decor already present. ONLY add the reference furniture piece(s). Do not generate a different room. Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the original photo.';
  }
  return suffix;
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
// Error handling middleware for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: 'File too large', 
        message: 'Please upload an image smaller than 100MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    return res.status(400).json({ 
      error: 'Upload error', 
      message: err.message,
      code: err.code 
    });
  }
  next(err);
});

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

// Virtual staging for server-side integrations (no user session; no daily cap on account)
// Auth store JSON (users, sessions, etc.) — same access key as log exports
// Prompt logs endpoint - serves the prompt logs CSV file (protected)
// Welcome message endpoint - returns personalized or generic welcome message
// Chat endpoints
// Text chat endpoint
// Chat with file upload endpoint (multiple files)
// Contact logs endpoint - serves the contact logs CSV file (protected)
// Email open logs endpoint - serves broker outreach open tracking CSV (protected)
// Memories endpoint - serves the memories JSON file (protected)
// Reset memories endpoint - empties the memories JSON file (protected)
// Chat logs endpoint - serves the chat logs CSV file (protected)
// Bug reports endpoint - serves the bug reports CSV file (protected)
// Bug report endpoint
const MAX_MASK_PROMPT_LENGTH = 1000;

// Mask editing endpoint - uses Gemini API for better image editing
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
app.use(createAdminRouter({ authStore, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, getMemoriesFile, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT }));

// staging routes (routes/staging.js)
app.use(createStagingRouter({ genAI, openai, genLimiter, stagingProcessUpload, pdfUpload, PDF_PROCESSING_SERVER, DEBUG_MODE, MAX_MASK_PROMPT_LENGTH, MAX_SEGMENT_QUERY_LENGTH, QUALITY_MAX_ATTEMPTS, setSensitiveHeaders, getAuthUserFromRequest, enterpriseDomainForUser, getStagingClientIp, isLikelyMobileStagingRequest, reportEnterpriseUsage, requireProAccount, logMaskEditToFile, getUserIdentifier, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage, normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview, generateWithQualityRetry, maskReferencePromptSuffix, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard }));

// chat routes (routes/chat.js)
app.use(createChatRouter({ openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, getUserIdentifier, annotateImage, downscaleImageForGPT, filterUnsupportedFiles, deduplicateMessages, filterConversationHistory, stripImagesFromHistory, collectImagesFromHistory, getPriorHistoryForImageContext, parseBaseImageIndex, getBaseImageSelectionContext, applyBaseImageIndexToStagingParams, resolveCadImageIndex, findMostRecentStagedImageIndex, userWantsToAddFurnitureToRoom, resolveDualUploadStaging, resolveDualUploadFromMessageContent, applyAddFurnitureStagingFallback, getImageFromHistory, buildImageContext, getOriginalImageIndex, getStagifyDateContext, parseDesignerRoutingCompletion, aiResponseDefersImageAction, wantsStreamedChatResponse, chatWillProcessSlowImages, chatIntentType, initChatSse, writeChatSseEvent, finishStreamedChatResponse, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount }));

// public routes (routes/public.js)
app.use(createPublicRouter({ authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY, emailLimiter, PDF_PROCESSING_SERVER, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getHostedImagesDir, readHostedImagesManifest, logEmailOpenToFile, isConfirmedEmailClientOpen, healthHandler, getPromptCount, getContactCount, incContactCount , __dirname }));

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

  const fakeContactAdd = 0;
  const fakePromptAdd = 0;
  // Initialize prompt count on server startup
  initializePromptCount();
  promptCount += fakePromptAdd;
  // Initialize contact count on server startup
  initializeContactCount();
  contactCount += fakeContactAdd;
});
