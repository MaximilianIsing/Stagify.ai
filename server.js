import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import FormData from 'form-data';
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from 'openai';
import sharp from "sharp";
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Resend } from 'resend';
import { promptMatrix } from './promptMatrix.js';
import { blueprintTo3D } from './cad-handling.js';
import { createAuthStore } from './auth-store.js';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { handleStripeEvent } from './stripe-webhooks.js';
import { createEnterpriseStore } from './enterprise-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const authStore = createAuthStore(__dirname);
const enterpriseStore = createEnterpriseStore(__dirname);
setInterval(() => authStore.pruneSessions(), 6 * 60 * 60 * 1000).unref?.();

/**
 * Directories to look for stripe_*.txt (first match wins).
 * Many hosts mount secret files at /etc/secrets/ or the process cwd, not next to bundled server.js.
 */
function stripeSecretSearchDirs() {
  const dirs = [];
  const envDir = process.env.STRIPE_SECRETS_DIR;
  if (envDir && String(envDir).trim()) {
    dirs.push(path.resolve(String(envDir).trim()));
  }
  dirs.push(__dirname);
  dirs.push(process.cwd());
  dirs.push('/etc/secrets');
  const seen = new Set();
  return dirs.filter((p) => {
    const n = path.resolve(p);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function readFirstStripeFile(name, validate) {
  for (const dir of stripeSecretSearchDirs()) {
    const filePath = path.join(dir, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8').trim().replace(/^\uFEFF/, '');
      const v = validate(raw);
      if (v) return v;
    } catch (e) {
      console.warn(`[stripe] Could not read ${name} in ${dir}:`, e.message);
    }
  }
  return null;
}

function readStripeSecretKey() {
  const fromFile = readFirstStripeFile('stripe_secret_key.txt', (raw) => {
    if (raw.startsWith('sk_')) return raw;
    if (raw) console.warn('[stripe] stripe_secret_key.txt must start with sk_ — ignored');
    return null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.STRIPE_SECRET_KEY;
  if (fromEnv && String(fromEnv).trim().startsWith('sk_')) {
    return String(fromEnv).trim();
  }
  return '';
}

const stripeSecretKey = readStripeSecretKey();
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

function readStripeWebhookSecret() {
  const fromFile = readFirstStripeFile('stripe_webhook_secret.txt', (raw) => {
    if (raw.startsWith('whsec_')) return raw;
    if (raw) console.warn('[stripe] stripe_webhook_secret.txt must start with whsec_ — ignored');
    return null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.STRIPE_WEBHOOK_SECRET;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).trim();
  }
  return '';
}

const stripeWebhookSecret = readStripeWebhookSecret();

function readStripePublishableKey() {
  const fromFile = readFirstStripeFile('stripe_publishable.txt', (raw) => {
    if (raw.startsWith('pk_')) return raw;
    if (raw) console.warn('[stripe] stripe_publishable.txt must start with pk_ — ignored');
    return null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.STRIPE_PUBLISHABLE_KEY;
  if (fromEnv && String(fromEnv).trim().startsWith('pk_')) return String(fromEnv).trim();
  return '';
}

const stripePublishableKey = readStripePublishableKey();

function readEnterprisePriceId() {
  const fromFile = readFirstStripeFile('priceid.txt', (raw) => {
    const cleaned = raw.replace(/^["'\s]*"?id"?\s*:\s*"?/i, '').replace(/["'\s]+$/g, '').trim();
    if (cleaned.startsWith('price_')) return cleaned;
    if (raw.startsWith('price_')) return raw;
    if (raw) console.warn('[stripe] priceid.txt must contain a price_ id — ignored');
    return null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.ENTERPRISE_PRICE_ID;
  if (fromEnv && String(fromEnv).trim().startsWith('price_')) return String(fromEnv).trim();
  return '';
}

const enterprisePriceId = readEnterprisePriceId();

function readGoogleClientId() {
  const fromFile = readFirstStripeFile('googleclientID.txt', (raw) => {
    const s = String(raw).trim();
    if (!s) return null;
    if (s.includes('.apps.googleusercontent.com')) return s;
    if (/^[0-9a-zA-Z._-]{20,}$/.test(s)) return s;
    if (raw) console.warn('[google] googleclientID.txt does not look like a Google OAuth client id — ignored');
    return null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.GOOGLE_CLIENT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return '';
}

/** Optional. Sign-In With Google (ID token) only needs the client id; secret is for other OAuth flows. */
function readGoogleClientSecret() {
  const fromFile = readFirstStripeFile('googlesecret.txt', (raw) => {
    const s = String(raw).trim();
    return s || null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.GOOGLE_CLIENT_SECRET;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return '';
}

const googleClientId = readGoogleClientId();
const googleClientSecret = readGoogleClientSecret();
const googleOAuthClient = googleClientId
  ? new OAuth2Client(googleClientId, googleClientSecret || undefined)
  : null;
if (googleClientId) {
  console.log('[google] OAuth client id loaded (Sign-In with Google enabled)');
}

function readEndpointAccessKey() {
  const fromFile = readFirstStripeFile('endpointkey.txt', (raw) => {
    const s = String(raw).trim();
    return s || null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.endpoint_key;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return '';
}

const LOGS_ACCESS_KEY = readEndpointAccessKey();
if (LOGS_ACCESS_KEY) {
  console.log('Endpoint access key successfully loaded');
} else {
  console.error('Error: No endpoint access key found in file or environment variable');
}

function endpointKeyMatches(received, expected) {
  if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
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
  if (!token && req.query && req.query.authToken) {
    token = String(req.query.authToken).trim();
  }
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

function readEnterpriseMeterEventName() {
  const fromFile = readFirstStripeFile('enterprise_meter_event.txt', (raw) => {
    const s = String(raw).trim();
    return s || null;
  });
  if (fromFile) return fromFile;
  const fromEnv = process.env.ENTERPRISE_METER_EVENT_NAME;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return 'user_generation';
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

// Function to log prompts to CSV file
function logPromptToFile(promptText, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, userReferralSource, userEmail, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    
    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }
    
    // Create CSV row
    const csvRow = [
      escapeCSVField(timestamp),
      escapeCSVField(roomType),
      escapeCSVField(furnitureStyle),
      escapeCSVField(additionalPrompt || ''),
      escapeCSVField(removeFurniture),
      escapeCSVField(userRole || 'unknown'),
      escapeCSVField(userReferralSource || 'unknown'),
      escapeCSVField(userEmail || 'unknown'),
      escapeCSVField(ipAddress)
    ].join(',') + '\n';
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      if (DEBUG_MODE) {
        console.log('Using Render persistent disk');
      }
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            console.log('Created local data directory successfully');
          }
        } catch (error) {
          if (DEBUG_MODE) {
            console.log('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'prompt_logs.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to prompt log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logPromptToFile:', error);
  }
}

// Function to log mask edits to CSV file
function logMaskEditToFile(prompt, model, geminiModel, imageWidth, imageHeight, userId, req) {
  try {
    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req ? (req.get('user-agent') || 'unknown') : 'unknown';
    
    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }
    
    // Create CSV row
    const csvRow = [
      escapeCSVField(timestamp),
      escapeCSVField(prompt || ''),
      escapeCSVField(model || 'unknown'),
      escapeCSVField(geminiModel || 'unknown'),
      escapeCSVField(imageWidth || ''),
      escapeCSVField(imageHeight || ''),
      escapeCSVField(userId || 'unknown'),
      escapeCSVField(ipAddress),
      escapeCSVField(userAgent)
    ].join(',') + '\n';
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
        } catch (error) {
          console.log('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'mask_logs.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to mask log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logMaskEditToFile:', error);
  }
}

// Global variable to track prompt count
let promptCount = 0;

// Global variable to track contact count
let contactCount = 0;

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
// parties it loads (Google sign-in, Stripe, Supademo + Instagram embeds).
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
    'https://accounts.google.com',
    'https://apis.google.com',
    'https://www.gstatic.com',
    'https://*.stripe.com',
  ],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", 'https:'],
  frameSrc: [
    "'self'",
    'https://app.supademo.com',
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

// Stripe webhooks must use the raw body for signature verification (register before express.json)
app.post('/api/billing/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) {
    console.warn(
      '[stripe] Webhook ignored: add stripe_secret_key.txt + stripe_webhook_secret.txt (searched: STRIPE_SECRETS_DIR, server dir, cwd, /etc/secrets) or set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET',
    );
    return res.status(503).send('Stripe billing not configured');
  }
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).send('Missing stripe-signature');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    const out = await handleStripeEvent(event, authStore, { stripe, enterpriseStore });
    if (!out.handled) {
      console.log('[stripe] Unhandled event type (ok):', event.type);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[stripe] Webhook handler error:', e);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

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
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

/**
 * Grant Stagify+ to the signed-in account when ?key= matches endpointkey.txt (or endpoint_key env).
 * If the browser has no Authorization header, returns a tiny page that re-opens this URL with
 * ?authToken= from localStorage (same pattern as other auth flows).
 */
app.get('/getpro', (req, res) => {
  try {
    if (!LOGS_ACCESS_KEY) {
      return res.status(503).type('text/plain').send('Not configured');
    }
    const keyParam = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    if (!keyParam || !endpointKeyMatches(keyParam, LOGS_ACCESS_KEY)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const user = getAuthUserFromRequest(req);
    if (!user) {
      const html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stagify+</title></head><body>' +
        '<p id="m">Checking sign-in…</p><script>' +
        '(function(){var k=' +
        JSON.stringify(keyParam) +
        ';try{var t=localStorage.getItem("stagifyAuthToken");if(t){var u=new URL(location.pathname,location.origin);u.searchParams.set("key",k);u.searchParams.set("authToken",t);location.replace(u.toString());return;}}catch(e){}' +
        'document.getElementById("m").textContent="Sign in on this site first, then open this link again.";' +
        '})();</script></body></html>';
      return res.type('html').send(html);
    }
    const result = authStore.grantProWithPass(user.id);
    if (!result.ok) {
      return res.status(400).type('text/plain').send(result.error || 'Failed');
    }
    console.log('[getpro] granted pro for user', user.id);
    const okHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stagify+</title></head><body>' +
      '<p>Your account now has <strong>Stagify+</strong>.</p><p><a href="/">Home</a> · <a href="/stagify-plus.html">Stagify+</a></p>' +
      '<script>try{history.replaceState({}, "", "/");}catch(e){}</script></body></html>';
    return res.type('html').send(okHtml);
  } catch (e) {
    console.error('[getpro]', e);
    return res.status(500).type('text/plain').send('Error');
  }
});

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

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: imageFileFilter
});

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

// Memory storage for AI chat - per user
function getMemoriesFile() {
  const logDir = process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
  return path.join(logDir, 'memories.json');
}

function loadAllMemories() {
  try {
    const file = getMemoriesFile();
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf8').trim();
      // If file is empty or only whitespace, initialize it
      if (!data || data === '') {
        const initialized = {};
        fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
        return initialized;
      }
      return JSON.parse(data);
    } else {
      // File doesn't exist, create it with empty object
      const logDir = path.dirname(file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const initialized = {};
      fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
      return initialized;
    }
  } catch (error) {
    console.error('Error loading memories:', error);
    // If JSON is invalid, reinitialize the file
    try {
      const file = getMemoriesFile();
      const logDir = path.dirname(file);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const initialized = {};
      fs.writeFileSync(file, JSON.stringify(initialized, null, 2));
      return initialized;
    } catch (initError) {
      console.error('Error initializing memories file:', initError);
      return {};
    }
  }
}

function loadMemories(userId) {
  const allMemories = loadAllMemories();
  return allMemories[userId] || [];
}

function saveMemories(userId, memories) {
  try {
    const file = getMemoriesFile();
    const logDir = path.dirname(file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const allMemories = loadAllMemories();
    allMemories[userId] = memories;
    fs.writeFileSync(file, JSON.stringify(allMemories, null, 2));
    if (DEBUG_MODE) {
      console.log(`✓ Successfully saved ${memories.length} memories for user: ${userId} to ${file}`);
    }
    
    if (DEBUG_MODE) {
      console.log('All memories structure:', JSON.stringify(allMemories, null, 2));
    }
  } catch (error) {
    console.error('✗ Error saving memories:', error);
    console.error('Error details:', error.stack);
    console.error('File path:', getMemoriesFile());
    console.error('User ID:', userId);
    console.error('Memories to save:', JSON.stringify(memories, null, 2));
  }
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

async function evaluateMemoryActions(userMessage, aiResponse, currentMemories, model = 'gpt-4o-mini') {
  try {
    if (!openai) {
      console.error('OpenAI not initialized, cannot evaluate memory actions');
      return { stores: [], forgets: [] };
    }
    
    // Build current memories list for context
    let memoriesContext = '';
    if (currentMemories && currentMemories.length > 0) {
      memoriesContext = '\n\nCurrent stored memories:\n';
      currentMemories.forEach((memory, index) => {
        memoriesContext += `${index + 1}. [ID: ${memory.id}] ${memory.content}\n`;
      });
    }
    
    const prompt = `You are a memory management system. Analyze the following conversation and determine if any memory actions should be taken.

User message: "${userMessage}"
AI response: "${aiResponse}"${memoriesContext}

You can perform two types of actions:
1. STORE: Store new important information as a permanent memory (you can store MULTIPLE memories from one message)
2. FORGET: Delete an existing memory that is no longer relevant, incorrect, or the user wants forgotten

CRITICAL RULES - Only store GENERAL, LONG-TERM preferences that apply to ALL future conversations:

✅ DO store ONLY:
- User's profession/role (e.g., "User is a real estate agent", "User works in interior design")
- User's personal name or identity information
- General design philosophy or approach (e.g., "User prefers sustainable/eco-friendly design", "User focuses on accessibility")
- Long-term business context (e.g., "User runs a staging company", "User specializes in luxury properties")

❌ DO NOT store (these are generation-specific and should NEVER be saved):
- ANY room-specific requests (e.g., "stage this bedroom", "this living room", "this kitchen")
- ANY image-specific requests (e.g., "stage this image", "this photo", "this room")
- ANY styling requests for a specific generation (e.g., "coastal theme", "modern style", "luxury furniture" - these are for ONE image, not a general preference)
- ANY furniture or decor preferences mentioned in context of a specific image
- ANY color, material, or design choices for a specific room/image
- Temporary requests or one-time instructions
- Context about uploaded images, staging requests, or generation tasks
- Any request that includes words like "this", "that", "the image", "the room", "stage", "generate", "create"

When in doubt, DO NOT store. Only store information that:
1. Applies to ALL future conversations regardless of what the user is working on
2. Is about the USER themselves, not about their work or requests
3. Would be useful even if the user never mentions images, staging, or design again
4. Is explicitly stated as a general preference (e.g., "I always prefer modern design" vs "make this modern")

Consider forgetting a memory if:
- The user explicitly asks to forget something
- A stored memory is incorrect or outdated
- The user contradicts a previous memory
- The memory is no longer relevant
- The memory is actually generation-specific (clean up old mistakes)

You can perform MULTIPLE actions in one response. For example, you can forget an old memory AND store a new one, or store multiple new memories.

Respond with a JSON object in this exact format:
{
  "stores": ["memory description 1", "memory description 2", ...],
  "forgets": ["memory ID 1", "memory ID 2", ...]
}

If no actions are needed, return: {"stores": [], "forgets": []}
If storing memories, include brief descriptions in the "stores" array.
If forgetting memories, include the memory IDs from the current memories list in the "forgets" array.
If the user wants to forget ALL memories, use "forgets": ["all"] - this will clear all stored memories for the user.

Be EXTREMELY selective. The default should be to NOT store anything. Only store if you are 100% certain it is a general, long-term preference about the user themselves, not about their work or specific requests.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a memory management system. Always respond with valid JSON only, no other text." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: "json_object" }
    });
    
    const responseText = completion.choices[0].message.content.trim();
    
    if (DEBUG_MODE) {
      console.log('Memory evaluation response:', responseText);
    }
    
    try {
      const result = JSON.parse(responseText);
      const stores = Array.isArray(result.stores) ? result.stores : [];
      const forgets = Array.isArray(result.forgets) ? result.forgets : [];
      
      if (DEBUG_MODE) {
        console.log('Memory actions parsed - Stores:', stores.length, 'Forgets:', forgets.length);
      }
      
      return { stores, forgets };
    } catch (parseError) {
      console.error('Error parsing memory actions JSON:', parseError);
      console.error('Response was:', responseText);
      return { stores: [], forgets: [] };
    }
  } catch (error) {
    console.error('Error evaluating memory actions:', error);
    console.error('Error details:', error.stack);
    return { stores: [], forgets: [] };
  }
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
const IMAGE_FRAMING_PRESERVATION_RULES = `
CRITICAL FRAMING & ASPECT RATIO RULES:
- Preserve the EXACT aspect ratio, orientation, and canvas dimensions of the input image
- Show the FULL scene visible in the input photo — do not crop, cut off, or reframe any edges
- Keep the entire ceiling line, floor line, and all walls/edges that appear in the original frame
- Do NOT zoom in, zoom out, or change the camera field of view unless the user explicitly asked for a closer or different crop
- Do NOT stretch, squash, letterbox, pad, or distort the image
- Fit all staging changes WITHIN the existing frame; never remove parts of the room to fit new content
- If adding furniture, scale and place it so nothing important from the original photo is cropped out or pushed out of frame`;

/**
 * Generate styling prompt based on user preferences using a matrix system
 */
function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture) {

  // Add furniture removal instruction if requested
  removeFurniture = removeFurniture === 'true' ? true : false;
  const furnitureRemovalText = removeFurniture 
    ? "First, remove all existing furniture and decor from the room. Then, " 
    : "Try not to remove existing furniture, if there is any. ";
  
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
      let imageCount = 0;
      
      msg.content.forEach(item => {
        if (item.type === 'text') {
          textParts.push(item.text);
        } else if (item.type === 'image_url') {
          imageCount++;
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

function getImageFromHistoryExact(messages, imageIndex = 0) {
  const imageMessages = collectImagesFromHistory(messages);
  if (imageIndex >= 0 && imageIndex < imageMessages.length) {
    return imageMessages[imageIndex];
  }
  return null;
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

const DUAL_UPLOAD_ROOM_PROMPT_SUFFIX =
  ' CRITICAL: The first image is the user\'s actual room photo — preserve its exact architecture, walls, windows, doors, camera angle, lighting, and proportions. Place the furniture from the reference image(s) into THIS room only. Do not invent or substitute a different space. Preserve the full frame — do not crop or zoom.';

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

const ADD_FURNITURE_PRESERVATION_SUFFIX =
  ' CRITICAL: The base photo is an already-staged room. Preserve this EXACT room — same architecture, walls, windows, camera angle, lighting, and all existing furniture and decor already visible. ONLY add the referenced furniture piece(s). Do not redesign the room or replace existing contents. Preserve the exact aspect ratio and full frame — do not crop or zoom.';

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
const AI_DESIGNER_RESPONSE_ACTION_RULES =
  '\n\nCLARIFICATION RULES (CRITICAL — read before staging/generating/CAD):' +
  '\n- When ANY important detail is missing, unclear, or ambiguous, ask clarifying questions FIRST. Prefer asking over guessing or assuming.' +
  '\n- Always ask when it is unclear: which image to use (only when multiple room images exist AND the user did not select a base image in the thumbnail strip AND conversation does not make the target room obvious), style/theme/aesthetic, color palette, room type, furniture or decor preferences, what the user means by vague words ("better", "nicer", "fix it", "something different"), placement or layout, whether to remove existing furniture, target audience (rental vs luxury listing), or what should change vs stay the same.' +
  '\n- Do NOT ask which room to use if the user selected a base image in the thumbnail strip, if only one room image exists, or if they clearly mean the room they just staged or discussed.' +
  '\n- Ask 1–3 focused questions per turn. Be friendly and specific — e.g. "Which style are you going for: modern, farmhouse, or something else?" not a long questionnaire.' +
  '\n- If you cannot confidently choose staging vs generation vs CAD, or which previous image to modify (and no thumbnail selection or obvious room context), ask before acting.' +
  '\n\nRESPONSE vs ACTION RULES (CRITICAL):' +
  '\n- Never ask clarifying questions AND trigger staging/generation/CAD in the same response. These are mutually exclusive.' +
  '\n- If you need more information, write ONLY your questions in "response" and set shouldStage/shouldGenerate/shouldProcessCAD to false (or omit staging/generate/cad).' +
  '\n- EXCEPTION — proceed without asking ONLY when: (1) the user uploaded a room or blueprint photo AND clearly wants it processed ("stage this", "here\'s the room", "stage for my client", "process this blueprint"), OR (2) the user already gave enough specific detail that a professional designer would not need to ask (e.g. "stage this living room mid-century modern with warm wood and a green velvet sofa"). In case (1), use tasteful defaults (modern, broadly appealing, neutral palette) and briefly mention them in "response".' +
  '\n- Pick ONE mode per turn: (A) QUESTIONS ONLY — no image actions, OR (B) ACTION — stage/generate with a short confirmation, not a list of questions.' +
  '\n\nADD FURNITURE TO ROOM (CRITICAL):' +
  '\n- When the user asks to add/include/place a chair, sofa, or other furniture item into a room, you MUST use "staging" — NEVER "generate".' +
  '\n- TARGET ROOM (use in this order): (1) the image the user selected in the thumbnail strip ("Base image for next message") — that IS the room to modify; (2) if obvious from conversation (they just staged or discussed one room, only one room image exists, or they say "that room"/"this staged room"), use that room\'s index; (3) the most recent staged room; (4) only if still unclear among multiple rooms AND no thumbnail selection, ask which room first — do not stage until clarified.' +
  '\n- Set "usePreviousImage" to the TARGET ROOM index (staged or uploaded room photo — NOT the furniture product photo).' +
  '\n- Furniture reference: if uploaded in the CURRENT message, set "furnitureImageIndex" to null (the system attaches the upload automatically). If referencing furniture from a prior message, set "furnitureImageIndex" to that piece\'s index.' +
  '\n- In "additionalPrompt", emphasize preserving the exact existing room and only adding the referenced furniture.' +
  '\n- If placement or scale is ambiguous, you may ask — but do not ask which room when the thumbnail strip or conversation already makes it clear.' +
  '\n\nMODIFY / REMOVE / SWAP EXISTING ITEMS (CRITICAL):' +
  '\n- When the user asks to change, remove, or swap something already in a staged or uploaded room (e.g. "remove the lamp", "make the sofa leather", "swap the rug for a darker one", "take out the plant in the corner"), use "staging" — NEVER "generate".' +
  '\n- Set "usePreviousImage" to the room being edited (thumbnail selection first, otherwise the most recent staged room).' +
  '\n- In "additionalPrompt", describe ONLY the specific change and explicitly say to keep everything else in the photo identical (same furniture, decor, layout, camera angle, and lighting). Do not re-stage the whole room.' +
  '\n- These targeted edits usually do NOT need a furniture reference image — leave "furnitureImageIndex" null unless the user supplied a specific product photo.' +
  '\n\nSTYLE REFERENCE IMAGE (CRITICAL):' +
  '\n- If the user provides an image as an aesthetic/mood reference ("stage it like this", "match this style", "use this vibe") rather than a specific furniture product to place, set "styleReference" to true.' +
  '\n- In that case "usePreviousImage" is still the ROOM to stage (the selected/most-recent room photo), and the reference image is the style guide — do NOT treat the reference as the room and do NOT copy its exact objects or layout.' +
  '\n- In "additionalPrompt", say to match the overall style, palette, materials, and mood of the reference while keeping the target room\'s own architecture, dimensions, and camera angle.' +
  '\n- If no separate room is available (the user only gave the reference), ask which room to stage before acting.';

const AI_DESIGNER_IMAGE_FRAMING_RULES =
  '\n\nIMAGE FRAMING (CRITICAL — apply to every staging/CAD additionalPrompt):' +
  '\n- Always tell the image model to preserve the input photo\'s exact aspect ratio, orientation, and full framing.' +
  '\n- Do NOT crop, zoom, reframe, or cut off ceilings, floors, walls, or room edges unless the user explicitly asked for a closer crop or close-up.' +
  '\n- All changes must fit INSIDE the existing frame — never drop content from the original photo or change the camera field of view.' +
  '\n- When writing additionalPrompt text, explicitly include instructions to preserve full frame and aspect ratio.';

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
 * Evaluates if staging should be performed and if an old image should be used
 * Similar to evaluateMemoryActions, but for staging requests
 */
async function evaluateStagingRequest(userMessage, aiResponse, hasCurrentImage, conversationHistory, model = 'gpt-4o-mini') {
  try {
    if (!openai) {
      console.error('OpenAI not initialized, cannot evaluate staging request');
      return null;
    }
    
    // Build context about available images in history
    let imageContext = '';
    let originalImageIndex = null;
    if (conversationHistory && Array.isArray(conversationHistory)) {
      const imageMessages = [];
      // Collect ALL images in reverse chronological order (most recent first)
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const msg = conversationHistory[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          // Get ALL images from this message, not just the first one
          const imageItems = msg.content.filter(item => item.type === 'image_url');
          // Process images in reverse order within the message (so first image in message = most recent)
          for (let j = imageItems.length - 1; j >= 0; j--) {
            const imageItem = imageItems[j];
            const filename = imageItem.filename || imageItem.originalname || null;
            imageMessages.push({ 
              index: imageMessages.length, 
              type: 'user-uploaded', 
              messageIndex: i,
              filename: filename
            });
          }
        } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          // Get ALL staged and generated images from this message
          const imageItems = msg.content.filter(item => 
            item.type === 'image_url' && 
            (item.isStaged || item.isGenerated)
          );
          // Process images in reverse order within the message
          for (let j = imageItems.length - 1; j >= 0; j--) {
            const imageItem = imageItems[j];
            const filename = imageItem.filename || imageItem.originalname || null;
            const imageType = imageItem.isStaged ? 'staged' : 'generated';
            imageMessages.push({ 
              index: imageMessages.length, 
              type: imageType, 
              messageIndex: i,
              filename: filename
            });
          }
        }
      }
      
      // Find the original (first) user-uploaded image (it's at the highest index since we're going reverse chronological)
      const userUploadedImages = imageMessages.filter(img => img.type === 'user-uploaded');
      if (userUploadedImages.length > 0) {
        // The last one in the array (highest index) is the original/first uploaded image
        originalImageIndex = userUploadedImages[userUploadedImages.length - 1].index;
      }
      
      if (imageMessages.length > 0) {
        imageContext = `\n\nAvailable images in conversation history (index 0 = most recent, higher index = older):\n`;
        imageMessages.forEach((img, idx) => {
          let description = `${img.type} image (from message ${img.messageIndex})`;
          if (img.filename) {
            description += ` (filename: ${img.filename})`;
          }
          if (idx === originalImageIndex) {
            description += ' [ORIGINAL/FIRST USER-UPLOADED IMAGE]';
          }
          imageContext += `- Index ${idx}: ${description}\n`;
        });
        if (originalImageIndex !== null) {
          imageContext += `\nIMPORTANT: The "original image" or "first image" is at index ${originalImageIndex}. When the user says "original image", "first image", "initial image", "go back to the original", or "refer back to the original image", use index ${originalImageIndex}.`;
        }
        imageContext += `\nIMPORTANT: When multiple images are uploaded in the same message, they are indexed separately. Use the filename to identify which image the user is referring to (e.g., if user says "add this chair" or mentions a specific filename, look for an image with that filename or matching description).`;
      }
    }
    
    const prompt = `You are a staging request evaluator for Stagify.ai. Analyze the following conversation and determine if room staging should be performed.

User message: "${userMessage}"
AI response: "${aiResponse}"
Current message has image: ${hasCurrentImage}${imageContext}

CRITICAL: Staging should be performed if the user wants to:
- Add furniture, decorate, or style a room
- Modify ANY aspect of an image (change colors, walls, furniture, etc.)
- Apply any visual changes to a room image
- "Show me X but with Y" (e.g., "show me the original but with red walls") = STAGING REQUEST
- "Make X red/blue/etc" (e.g., "make the walls red") = STAGING REQUEST
- "Change X to Y" (e.g., "change the color to blue") = STAGING REQUEST
- Even if the user says "I don't want it staged" but then asks to modify the image, it's still a staging request

If the user wants to stage a room or modify an image, respond with a JSON object containing staging parameters:
{
  "shouldStage": true,
  "roomType": "Living room" | "Bedroom" | "Kitchen" | "Bathroom" | "Dining room" | "Office" | "Other",
  "additionalPrompt": "Create a detailed, comprehensive staging prompt based on the user's request. Include specific details about: furniture style, color scheme, mood/atmosphere, specific furniture pieces to add, decor elements, lighting preferences, and any other relevant details. Make it detailed and descriptive, as if you're instructing a professional interior designer. Base this on what the user asked for in their message. IMPORTANT: Emphasize that architecture (walls, windows, doors, room structure) and existing furniture must be preserved exactly as they appear - only add new furniture and decor, do not modify what's already there. CRITICAL: Preserve the exact aspect ratio and full frame of the input photo — do not crop, zoom, or cut off any part of the room unless the user explicitly requested a tighter crop.",
  "removeFurniture": true/false,
  "usePreviousImage": false | 0 | 1 | 2 | ...
}

IMPORTANT: 
- Always set furnitureStyle to "custom" (this will be handled automatically)
- The additionalPrompt should be a comprehensive, detailed description that captures the user's vision
- If the user says something vague like "make it cozy" or "modern style", expand it into a detailed prompt describing what that means
- If the user mentions specific items, colors, or styles, incorporate those into the detailed prompt
- "usePreviousImage": Set to false if using the current message's image, or set to the index (0 = most recent image in history, 1 = second most recent, etc.) if the user wants to modify a previous image. 
  * If the user says "modify the previous staging" or "change the last one", use index 0 (most recent).
  * If the user says "original image", "first image", "initial image", "go back to the original", "the original", or "show me the original", they mean the FIRST user-uploaded image, which is at the HIGHEST index number (oldest image). Look at the image context above to find which index corresponds to the first user-uploaded image.
  * If the user says "the image before that" or "the one before the last one", use index 1 (second most recent).
  * If the user says "show me the original but with X" or "the original but with X", use the original image index.

If staging is NOT needed (user is just asking questions, not requesting image modifications), respond with:
{
  "shouldStage": false
}

Extract the parameters from the user's message and the AI's response.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that evaluates staging requests. Always respond with valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    
    const result = JSON.parse(completion.choices[0].message.content);
    
    if (result.shouldStage) {
      return {
        roomType: result.roomType || 'Living room',
        furnitureStyle: 'custom', // Always use custom
        additionalPrompt: result.additionalPrompt || '',
        removeFurniture: result.removeFurniture || false,
        usePreviousImage: result.usePreviousImage !== undefined ? result.usePreviousImage : false
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error evaluating staging request:', error);
    return null;
  }
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

const QUALITY_REVIEW_PROMPT =
  'You are a strict QA reviewer for AI-generated interior real-estate photos. ' +
  'Inspect this image for obvious problems: warped or melted furniture, impossible ' +
  'geometry, distorted perspective, extra/missing legs, duplicated or garbled ' +
  'objects, unreadable text, smeared textures, or physically impossible lighting. ' +
  'Decide if the image is BASICALLY PERFECT (no obvious issues a real-estate agent ' +
  'would notice) or NOT (at least one clear issue).\n' +
  'Reply on the FIRST line with exactly "PERFECT: true" or "PERFECT: false".\n' +
  'If and only if it is NOT perfect, add a SECOND line "SCORE: <0-100>" rating how ' +
  'close it is despite the issue(s) (higher = fewer/milder issues), then a short reason.';

// Review a single generated image. Returns { perfect, score }.
// Fails OPEN (perfect: true) on any error so a flaky reviewer never blocks
// delivering an image to the user.
async function reviewImageQuality(imageDataUrl) {
  if (!openai) return { perfect: true, score: 100, reason: 'reviewer disabled' };
  try {
    const downscaledUrl = await downscaleImageForGPT(imageDataUrl);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: QUALITY_REVIEW_PROMPT },
            { type: 'image_url', image_url: { url: downscaledUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 80,
    });
    const raw = (completion.choices[0].message.content || '').trim();
    const perfect = /PERFECT:\s*true/i.test(raw);
    if (perfect) return { perfect: true, score: 100, reason: raw };
    const m = raw.match(/SCORE:\s*(\d{1,3})/i);
    // No score on a "not perfect" verdict → treat as a low score for ranking.
    const score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
    return { perfect: false, score, reason: raw };
  } catch (error) {
    console.error('[Quality] review failed, accepting image:', error.message);
    return { perfect: true, score: 100, reason: 'reviewer error' };
  }
}

// Run an image-producing function up to QUALITY_MAX_ATTEMPTS times, returning the
// first "perfect" result or, failing that, the highest-scoring one.
// `generateOnce(attempt)` must resolve to a data-URL string (or throw).
// `onImageProduced(attempt)` (optional) fires once for every attempt that
// actually yields an image — used to meter billing per generation attempt
// (including quality-gate retries).
async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null) {
  let best = null; // { url, score }
  let lastError = null;
  for (let attempt = 1; attempt <= QUALITY_MAX_ATTEMPTS; attempt++) {
    let url;
    try {
      url = await generateOnce(attempt);
    } catch (error) {
      lastError = error;
      if (DEBUG_MODE && attempt < QUALITY_MAX_ATTEMPTS) {
        console.log(`[Quality] ${label}: regenerating — attempt ${attempt}/${QUALITY_MAX_ATTEMPTS} failed to produce an image (${error.message}).`);
      }
      continue; // try again; if all fail we rethrow below
    }
    if (!url) continue;
    if (typeof onImageProduced === 'function') onImageProduced(attempt);
    const { perfect, score } = await reviewImageQuality(url);
    if (DEBUG_MODE) {
      console.log(`[Quality] ${label} attempt ${attempt}/${QUALITY_MAX_ATTEMPTS}: ${perfect ? 'perfect — accepted' : `not perfect (score ${score})`}`);
    }
    if (perfect) return url;
    if (!best || score > best.score) best = { url, score };
    // A regeneration is about to happen (unless this was the last allowed attempt).
    if (DEBUG_MODE && attempt < QUALITY_MAX_ATTEMPTS) {
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

Composition: show the full scene with a natural, uncropped framing. Do not awkwardly crop ceilings, floors, walls, or key subject matter unless the user explicitly requested a tight crop or close-up.`;
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
    }, 'generation');
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

function furnitureReferencePromptSuffix(count, preserveExistingStaging = false) {
  if (count <= 0) return '';
  const listText =
    count === 1
      ? 'The second image'
      : count === 2
        ? 'The second and third images'
        : 'The second, third, and fourth images';
  const pieceWord = count === 1 ? 'piece' : 'pieces';
  let suffix = `\n\nIMPORTANT: ${listText} provided after the room photo ${count === 1 ? 'is' : 'are'} reference furniture ${pieceWord} that the user wants incorporated into the staged room. Match each item's style, color, and appearance as closely as possible. Use all reference images as guidance for what to place in the space.`;
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
const FURNITURE_ERASE_PROMPT = `You are an expert real-estate photo editor. Your ONLY job is to make this interior room completely EMPTY and unfurnished. Remove EVERY single piece of furniture and movable object — leave nothing behind.

REMOVE ALL OF THESE (this list is illustrative, not exhaustive — remove anything like them too):
- Seating: sofas, couches, armchairs, dining chairs, stools, benches, ottomans, bean bags.
- Tables & surfaces: coffee tables, dining tables, side/end tables, desks, console tables, nightstands.
- Storage & casegoods: cabinets, dressers, wardrobes, sideboards, bookshelves, shelving units, TV stands, freestanding shelves — INCLUDING large, heavy, or built-looking pieces that merely sit against a wall.
- Beds and all bedding, headboards, footboards, mattresses.
- Decor & textiles: rugs, curtains, drapes, blinds that aren't fixtures, throw pillows, blankets.
- Wall items: wall art, paintings, posters, mirrors, clocks, shelves with objects.
- Lighting & electronics: floor lamps, table lamps, freestanding TVs, monitors, speakers.
- Plants, vases, books, boxes, clutter, and every other movable or staged object, large or small.

CRITICAL RULES:
- Be thorough and complete. Do NOT leave any item behind because it looks large, expensive, heavy, or hard to remove. If it is furniture, decor, or a movable object, it goes — no exceptions unless explicitly told otherwise below.
- FREESTANDING vs BUILT-IN: Remove every freestanding piece even if it is tall, bulky, or pushed flush against a wall (e.g. a standalone cabinet, wardrobe, bookshelf, or dresser). Keep ONLY true architectural built-ins that are permanently part of the structure — fixed kitchen counters and the cabinetry attached to them, bathroom vanities, fitted alcove shelving that is part of the wall. When unsure whether a cabinet is freestanding or built-in, treat it as freestanding and REMOVE it.
- Keep the room itself perfectly intact: walls, floor, ceiling, windows, doors, door/window frames, moldings, baseboards, trim, and the exact room geometry must stay UNCHANGED.
- Reconstruct the floor and wall areas that were hidden behind furniture so they look clean, continuous, and photorealistic — no ghosting, shadows, smudges, or leftover outlines of the removed items.
- Preserve the exact camera angle, perspective, framing, lighting, and aspect ratio. Do not crop, zoom, or re-frame.
- Do NOT add any new furniture, objects, or decor. The result must be a believable empty room ready to be staged.`;

// Cheap GPT-vision pre-check: if the room is already essentially empty there's
// nothing to erase, so we skip the (more expensive) Gemini removal pass entirely.
// Fails open — on any error or when the reviewer is disabled we DON'T skip, so a
// flaky check never silently turns off furniture removal.
const EMPTY_ROOM_CHECK_PROMPT = `You are looking at a photo of an interior room. Decide whether the room is ALREADY essentially empty of furniture and decor — i.e. a vacant/unfurnished room with at most a few minor leftover items — versus a furnished or staged room containing furniture that would need to be removed.\nReply with EXACTLY "EMPTY: true" if the room is already basically empty, or "EMPTY: false" if it contains furniture/decor worth removing. Output nothing else.`;

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
    for (const buf of furnitureBuffers) {
      const processedFurnitureBuffer = await downscaleImage(buf);
      const base64Furniture = processedFurnitureBuffer.toString("base64");
      prompt.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Furniture,
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

    // Source aspect ratio, so we can lock the output back to it (Gemini drifts).
    const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);

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
    });

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

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/bimi-logo.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'bimi-logo.svg'));
});

app.get('/logo-full.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, 'public', 'Logo Full.png'));
});

function getDataLogDir() {
  if (process.env.RENDER && fs.existsSync('/data')) {
    return '/data';
  }
  const logDir = path.join(__dirname, 'data');
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      return __dirname;
    }
  }
  return logDir;
}

function escapeCsvField(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function logEmailOpenToFile(email, req) {
  try {
    if (hasEmailEverOpened(email)) return;

    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection?.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req ? (req.get('user-agent') || 'unknown') : 'unknown';
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(email),
      escapeCsvField(ipAddress),
      escapeCsvField(userAgent),
    ].join(',') + '\n';

    const logDir = getDataLogDir();
    const logFile = path.join(logDir, 'email_open_logs.csv');
    const header = 'timestamp,email,ipAddress,userAgent\n';
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) console.error('Error writing to email open log:', err);
      });
    }
    markEmailOpened(email, timestamp);
  } catch (error) {
    console.error('Error in logEmailOpenToFile:', error);
  }
}

// Binary open tracking: each email is either opened or not (once ever, no repeat counts).
let emailOpenedAt = new Map();
let emailOpenedLoaded = false;

function getEmailOpenedFile() {
  return path.join(getDataLogDir(), 'email_opened.json');
}

function isStrictEmailClientProxyUa(ua) {
  const s = (ua || '').toLowerCase().trim();
  if (!s || s === 'unknown') return false;

  const botPatterns = [
    'curl/', 'wget/', 'python-', 'go-http-client', 'java/', 'httpclient',
    'proofpoint', 'barracuda', 'mimecast', 'fireeye', 'messagelabs', 'symantec',
    'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
    'bot', 'crawler', 'spider', 'scanner', 'preview', 'fetch',
    'facebookexternalhit', 'slackbot', 'twitterbot', 'linkedinbot',
    'safelinks', 'urldefense', 'atp/', 'emailsecurity', 'cloudflare',
  ];
  if (botPatterns.some((p) => s.includes(p))) return false;

  // Only known email-provider image proxies — reject generic browser UAs.
  if (s.includes('googleimageproxy') || s.includes('ggpht.com')) return true;
  if (s.includes('yahoo! slurp') || s.includes('yahoomailproxy')) return true;
  if (s.includes('microsoft office') || s.includes('ms-office') || s.includes('outlook')) return true;

  return false;
}

function isConfirmedEmailClientOpen(req) {
  return isStrictEmailClientProxyUa(req.get('user-agent'));
}

function loadEmailOpened() {
  if (emailOpenedLoaded) return;
  emailOpenedLoaded = true;
  try {
    const file = getEmailOpenedFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      emailOpenedAt = new Map(Object.entries(data));
      return;
    }
    // Bootstrap from CSV using only strict proxy rows
    const logFile = path.join(getDataLogDir(), 'email_open_logs.csv');
    if (!fs.existsSync(logFile)) return;
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g);
      if (!cols || cols.length < 4) continue;
      const ts = cols[0].replace(/^,/, '');
      const em = cols[1].slice(1).replace(/^"|"$/g, '').replace(/""/g, '"').toLowerCase();
      const ua = cols[3].slice(1).replace(/^"|"$/g, '').replace(/""/g, '"');
      if (!em || !isStrictEmailClientProxyUa(ua)) continue;
      if (!emailOpenedAt.has(em)) emailOpenedAt.set(em, ts);
    }
    if (emailOpenedAt.size) saveEmailOpened();
  } catch (error) {
    console.error('Error loading email opened cache:', error);
    emailOpenedAt = new Map();
  }
}

function saveEmailOpened() {
  try {
    const obj = {};
    emailOpenedAt.forEach((iso, email) => {
      obj[email] = iso;
    });
    fs.writeFileSync(getEmailOpenedFile(), JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error('Error saving email opened cache:', error);
  }
}

function hasEmailEverOpened(email) {
  loadEmailOpened();
  return emailOpenedAt.has(email);
}

function markEmailOpened(email, isoTimestamp) {
  loadEmailOpened();
  if (!emailOpenedAt.has(email)) {
    emailOpenedAt.set(email, isoTimestamp);
    saveEmailOpened();
  }
}

// Tracked logo for broker outreach emails — ?email=broker@example.com
app.get('/email/logo.png', (req, res) => {
  const rawEmail = req.query.email;
  if (typeof rawEmail === 'string') {
    const email = decodeURIComponent(rawEmail.trim().toLowerCase());
    if (email.includes('@') && email.length <= 254 && isConfirmedEmailClientOpen(req)) {
      logEmailOpenToFile(email, req);
    }
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'Logo Full.png'));
});

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

// Auth API (email + password; new accounts require email verification)
async function sendRegistrationVerificationEmail({ toEmail, code }) {
  if (!resend) {
    console.error('[auth] Resend not configured; cannot send registration verification email');
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        error:
          'We could not send a verification email because email delivery is not configured on this server. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED',
      },
    };
  }

  const recipient = EMAIL_DEBUG_MODE ? DEBUG_EMAIL : toEmail;
  const debugNote = EMAIL_DEBUG_MODE ? ` (intended recipient: ${toEmail})` : '';

  const sendResult = await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to: recipient,
    subject: 'Your Stagify verification code',
    html:
      `<p>Hi,</p><p>Your Stagify verification code${debugNote} is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:0.2em;margin:16px 0">${code}</p>` +
      `<p>This code expires in 15 minutes. If you didn’t request this, you can ignore this email.</p>` +
      `<p>— Stagify</p>`,
    text: `Your Stagify verification code${debugNote}: ${code}\n\nExpires in 15 minutes. If you didn't request this, ignore this email.`,
  });

  if (sendResult.error) {
    const errMsg =
      typeof sendResult.error?.message === 'string'
        ? sendResult.error.message
        : JSON.stringify(sendResult.error);
    console.error('[auth] Resend registration verification failed:', errMsg);
    return {
      ok: false,
      status: 502,
      body: {
        ok: false,
        error:
          'We could not send the verification email right now. Please try again in a few minutes. If it keeps failing, contact support.',
        code: 'EMAIL_SEND_FAILED',
      },
    };
  }

  return {
    ok: true,
    body: {
      ok: true,
      needsVerification: true,
      message:
        'We sent a 6-digit verification code to your email. Enter it below to finish creating your account.',
    },
  };
}

app.post('/api/auth/register', authLimiter, express.json(), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.startRegistration(email, password);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const mail = await sendRegistrationVerificationEmail({
      toEmail: result.toEmail,
      code: result.code,
    });
    if (!mail.ok) {
      return res.status(mail.status).json(mail.body);
    }
    res.json(mail.body);
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/register/verify', authLimiter, express.json(), (req, res) => {
  try {
    const { email, code } = req.body || {};
    const result = authStore.completeRegistration(email, code);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('register verify error', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/register/resend', emailLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = authStore.resendRegistrationCode(email);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const mail = await sendRegistrationVerificationEmail({
      toEmail: result.toEmail,
      code: result.code,
    });
    if (!mail.ok) {
      return res.status(mail.status).json(mail.body);
    }
    res.json({
      ok: true,
      message: 'We sent a new verification code to your email.',
    });
  } catch (e) {
    console.error('register resend error', e);
    res.status(500).json({ error: 'Could not resend verification code' });
  }
});

app.post('/api/auth/login', authLimiter, express.json(), (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = authStore.login(email, password);
    if (!result.ok) {
      return res.status(401).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

/** Public client id for Google Identity Services (Sign In With Google button). */
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: googleClientId || null });
});

app.post('/api/auth/google', authLimiter, express.json(), async (req, res) => {
  try {
    if (!googleOAuthClient || !googleClientId) {
      return res.status(503).json({ error: 'Google sign-in is not configured' });
    }
    const credential = req.body && req.body.credential;
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Missing credential' });
    }
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.sub) {
      return res.status(401).json({ error: 'Invalid Google sign-in' });
    }
    if (payload.email_verified === false) {
      return res.status(401).json({ error: 'Google email not verified' });
    }
    const result = authStore.loginWithGoogle({
      email: payload.email,
      googleSub: payload.sub,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    const fullUser = authStore.findUserByEmail(payload.email);
    res.json({ success: true, token: result.token, user: toPublicAuthUser(fullUser) });
  } catch (e) {
    console.error('google auth error', e.message || e);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' });
  }
  res.json({ user: toPublicAuthUser(user) });
});

app.post('/api/billing/customer-portal', express.json(), async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing not configured', code: 'STRIPE_DISABLED' });
    }
    const user = getAuthUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
    }
    if (!user.stripeCustomerId) {
      return res.status(400).json({
        error:
          'No billing profile on this account. If you subscribed with another email, sign in with that address or contact support.',
        code: 'NO_STRIPE_CUSTOMER',
      });
    }
    const baseUrlRaw =
      process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const baseUrl = String(baseUrlRaw).replace(/\/$/, '');
    const returnUrl = `${baseUrl}/stagify-plus.html`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe] customer portal error:', e.message);
    return res.status(500).json({ error: 'Could not open billing portal' });
  }
});

app.get('/api/enterprise/config', (req, res) => {
  res.json({ publishableKey: stripePublishableKey || '' });
});

app.post('/api/enterprise/create-checkout', express.json(), async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Billing not configured', code: 'STRIPE_DISABLED' });
    }
    if (!enterprisePriceId) {
      return res.status(503).json({ error: 'Enterprise pricing not configured' });
    }
    const { domain, companyName, contactEmail, contactPhone } = req.body || {};
    if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
      return res.status(400).json({ error: 'A valid domain is required (e.g. company.com)' });
    }
    const cleanDomain = domain.trim().toLowerCase().replace(/^@/, '');
    if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid contact email is required' });
    }
    if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const existing = enterpriseStore.getDomainEntry(cleanDomain);
    if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
      return res.status(409).json({ error: 'This domain already has an active enterprise plan' });
    }

    const baseUrlRaw =
      process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const baseUrl = String(baseUrlRaw).replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: contactEmail.trim(),
      line_items: [
        {
          price: enterprisePriceId,
        },
      ],
      subscription_data: {
        metadata: {
          enterprise_domain: cleanDomain,
          enterprise_company: companyName.trim(),
          enterprise_contact_email: contactEmail.trim(),
          enterprise_contact_phone: (contactPhone || '').trim(),
        },
      },
      metadata: {
        enterprise_domain: cleanDomain,
        enterprise_company: companyName.trim(),
        enterprise_contact_email: contactEmail.trim(),
        enterprise_contact_phone: (contactPhone || '').trim(),
      },
      success_url: `${baseUrl}/enterprise.html?success=1&domain=${encodeURIComponent(cleanDomain)}`,
      cancel_url: `${baseUrl}/enterprise.html?cancelled=1`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('[enterprise] checkout session error:', e.message);
    return res.status(500).json({ error: 'Could not create checkout session' });
  }
});

app.post('/api/auth/logout', express.json(), (req, res) => {
  const token =
    (req.body && req.body.authToken) ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null);
  if (token) authStore.logout(token);
  res.json({ success: true });
});

app.post('/api/auth/forgot-password', emailLimiter, express.json(), async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const result = authStore.startPasswordReset(email);
    const baseUrlRaw =
      process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const baseUrl = String(baseUrlRaw).replace(/\/$/, '');

    if (!result.token) {
      return res.json({
        ok: true,
        emailSent: false,
        message:
          'There is no Stagify account for that email address. Try signing up, or double-check for typos.',
      });
    }

    if (!resend) {
      console.error('[auth] Resend not configured; cannot send password reset email');
      return res.status(503).json({
        ok: false,
        error:
          'We could not send a reset email because email delivery is not configured on this server. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    const resetUrl = `${baseUrl}/reset-password.html?token=${encodeURIComponent(result.token)}`;
    const recipient = EMAIL_DEBUG_MODE ? DEBUG_EMAIL : result.toEmail;
    const debugNote = EMAIL_DEBUG_MODE ? ` (intended recipient: ${result.toEmail})` : '';

    const sendResult = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject: 'Reset your Stagify password',
      html:
        `<p>Hi,</p><p>We received a request to reset your Stagify password${debugNote}.</p>` +
        `<p><a href="${resetUrl}">Choose a new password</a></p>` +
        `<p>This link expires in one hour. If you didn’t ask for this, you can ignore this email.</p>` +
        `<p>— Stagify</p>`,
      text: `Reset your Stagify password: ${resetUrl}\n\nExpires in one hour. If you didn't request this, ignore this email.`,
    });

    if (sendResult.error) {
      const errMsg =
        typeof sendResult.error?.message === 'string'
          ? sendResult.error.message
          : JSON.stringify(sendResult.error);
      console.error('[auth] Resend password reset failed:', errMsg);
      return res.status(502).json({
        ok: false,
        error:
          'We could not send the reset email right now. Please try again in a few minutes. If it keeps failing, contact support.',
        code: 'EMAIL_SEND_FAILED',
      });
    }

    return res.json({
      ok: true,
      emailSent: true,
      message:
        'We sent a password reset link to your email. It expires in one hour. If you do not see it within a few minutes, check your spam or Promotions folder.',
    });
  } catch (e) {
    console.error('forgot-password error', e);
    res.status(500).json({ error: 'Could not process request' });
  }
});

app.post('/api/auth/reset-password', authLimiter, express.json(), (req, res) => {
  try {
    const token = (req.body && req.body.token) || '';
    const password = (req.body && req.body.password) || '';
    const out = authStore.completePasswordReset(token, password);
    if (!out.ok) {
      return res.status(400).json({ error: out.error });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('reset-password error', e);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

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
    promptCount++;
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

// Image processing endpoint: signed-in users (account limits) OR mobile User-Agent without session (free daily cap per IP, UTC)
app.post('/api/process-image', genLimiter, stagingProcessUpload, async (req, res) => {
  try {
    const sessionUser = getAuthUserFromRequest(req);
    const clientIp = getStagingClientIp(req);
    const mobileAnonymous = !sessionUser && isLikelyMobileStagingRequest(req);

    if (!sessionUser && !mobileAnonymous) {
      return res.status(401).json({
        error: 'Please sign in to stage images',
        code: 'AUTH_REQUIRED',
      });
    }

    await handleVirtualStagingMultipart(req, res, {
      user: sessionUser,
      mobileAnonymous,
      clientIp,
      recordUsage: true,
      treatAsPro: false,
    });
  } catch (error) {
    console.error('Error processing image:', error);
    if (error.code === 'NO_IMAGE_GENERATED') {
      return res.status(422).json({
        error: 'This image couldn\'t be staged. Please try a different photo of an interior room.',
        code: 'NO_IMAGE_GENERATED',
      });
    }
    return res.status(500).json({
      error: 'Image processing failed',
      details: error.message,
    });
  }
});

// Contact logging endpoint
app.post('/api/log-contact', emailLimiter, (req, res) => {
  try {
    const { userRole = 'unknown', referralSource = 'unknown', email = 'unknown', userAgent = 'unknown' } = req.body;
    const timestamp = new Date().toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Create CSV row
    const csvRow = `${timestamp},"${userRole}","${referralSource}","${email}","${userAgent}","${ipAddress}"\n`;
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      if (DEBUG_MODE) {
        console.log('Using Render persistent disk for contact logs');
      }
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            console.log('Created local data directory successfully');
          }
        } catch (error) {
          if (DEBUG_MODE) {
            console.log('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'contact_logs.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,userRole,referralSource,email,userAgent,ipAddress\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to contact log:', err);
        }
      });
    }
    
    // Increment contact count
    contactCount++;
    
    res.json({ success: true, message: 'Contact logged successfully' });
  } catch (error) {
    console.error('Error in contact logging:', error);
    res.status(500).json({ success: false, message: 'Failed to log contact' });
  }
});

// Email sending endpoint - protected with key
app.post('/api/send-email', emailLimiter, async (req, res) => {
  try {
    // Check access key
    if (!LOGS_ACCESS_KEY) {
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'Endpoint access key not configured'
      });
    }
    
    const accessKey = req.query.key || req.body.key;
    if (accessKey !== LOGS_ACCESS_KEY) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Valid access key required'
      });
    }

    // Check if Resend is initialized
    if (!resend) {
      return res.status(500).json({ 
        error: 'Email service not configured',
        message: 'Resend API key not found. Please set RESEND_API_KEY environment variable or create resendkey.txt file'
      });
    }

    const { to, subject, text } = req.body;

    // Validate required fields
    if (!to || !subject || !text) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'All fields "to", "subject", and "text" are required'
      });
    }

    const fromEmail = RESEND_FROM_EMAIL;

    // Use debug email if email debug mode is enabled
    let recipientEmails = Array.isArray(to) ? to : [to];
    if (EMAIL_DEBUG_MODE) {
      recipientEmails = [DEBUG_EMAIL];
    }

    // Send email
    const emailData = {
      from: fromEmail,
      to: recipientEmails,
      subject: subject,
      text: text,
    };

    const result = await resend.emails.send(emailData);

    if (DEBUG_MODE) {
      console.log('Email sent successfully:', result);
    }

    res.json({ 
      success: true, 
      message: 'Email sent successfully',
      id: result.id 
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ 
      error: 'Failed to send email',
      message: error.message || 'An error occurred while sending the email'
    });
  }
});

// Function to log chat messages to CSV file (only user messages, not AI responses)
function logChatToFile(userId, userMessage, aiResponse, files, ipAddress, userAgent) {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            console.log('Created local data directory successfully');
          }
        } catch (error) {
          if (DEBUG_MODE) {
            console.log('Error: Cannot create data directory, using project root');
          }
          logDir = __dirname;
        }
      }
    }

    const logFile = path.join(logDir, 'chat_logs.csv');
    
    const timestamp = new Date().toISOString();
    const fileNames = files && files.length > 0 ? files.map(f => f.name || f.originalname || 'unknown').join('; ') : '';
    const fileTypes = files && files.length > 0 ? files.map(f => f.type || f.mimetype || 'unknown').join('; ') : '';
    
    // Escape commas and quotes in CSV
    const escapeCSV = (str) => {
      if (!str) return '';
      return '"' + String(str).replace(/"/g, '""') + '"';
    };
    
    // Only log user message, not AI response
    const csvRow = `${timestamp},${escapeCSV(userId)},${escapeCSV(userMessage)},${escapeCSV('')},${escapeCSV(fileNames)},${escapeCSV(fileTypes)},${escapeCSV(ipAddress)},${escapeCSV(userAgent)}\n`;
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to chat log:', err);
        }
      });
    }
  } catch (error) {
    console.error('Error in logChatToFile:', error);
  }
}

// Health check endpoints
const healthHandler = (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    aiConfigured: !!genAI,
  });
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Prompt count endpoint
app.get('/api/prompt-count', (req, res) => {
  res.json({ 
    promptCount: promptCount
  });
});

// Contact count endpoint (Users Served = contact submissions + registered accounts)
app.get('/api/contact-count', (req, res) => {
  const userCount = authStore.getUserCount();
  res.json({
    contactCount,
    userCount,
    usersServed: contactCount + userCount,
  });
});

// PDF Processing Proxy Endpoints
// Health check proxy
app.get('/api/pdf-health', async (req, res) => {
  try {
    const response = await fetch(`${PDF_PROCESSING_SERVER}/health`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error checking PDF server health:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to check PDF server health',
      error: error.message 
    });
  }
});

// PDF processing proxy endpoint
app.post('/api/process-pdf', genLimiter, pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided' });
    }

    // Get query parameters from request
    const skip = req.query.skip || '4';
    const concurrency = req.query.concurrency || '2';
    const dpi = req.query.dpi || '110';
    const continueOnError = req.query.continue || 'false';
    const merge = req.query.merge || 'false';
    const filename = req.query.filename || req.file.originalname;

    // Build query parameters for external server
    const params = new URLSearchParams();
    params.append('skip', skip);
    params.append('concurrency', concurrency);
    params.append('dpi', dpi);
    if (continueOnError !== 'false') params.append('continue', continueOnError);
    if (merge !== 'false') params.append('merge', merge);
    if (filename) params.append('filename', filename);

    const urlPath = `/process?${params.toString()}`;
    const targetUrl = new URL(PDF_PROCESSING_SERVER);

    // Create FormData for the external server using form-data package
    const formData = new FormData();
    formData.append('pdf', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    // Forward the request to the external server using https module
    if (DEBUG_MODE) {
      console.log(`Forwarding PDF processing request to ${PDF_PROCESSING_SERVER}${urlPath}`);
    }
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: urlPath,
        method: 'POST',
        headers: formData.getHeaders()
      };

      const proxyReq = https.request(options, (proxyRes) => {
        // Handle errors from proxy response
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          let errorData = '';
          proxyRes.on('data', (chunk) => {
            errorData += chunk.toString();
          });
          proxyRes.on('end', () => {
            try {
              const parsedError = JSON.parse(errorData);
              res.status(proxyRes.statusCode).json({
                error: parsedError.message || parsedError.error || `Server error: ${proxyRes.statusCode}`,
                ...parsedError
              });
            } catch {
              res.status(proxyRes.statusCode).json({ 
                error: errorData || `Server error: ${proxyRes.statusCode}` 
              });
            }
            resolve();
          });
          return;
        }

        // Set status code for successful response
        res.status(proxyRes.statusCode || 200);

        // Copy headers from proxy response (skip problematic ones)
        Object.keys(proxyRes.headers).forEach(key => {
          const lowerKey = key.toLowerCase();
          // Skip headers that shouldn't be forwarded or will be set manually
          if (lowerKey !== 'content-encoding' && 
              lowerKey !== 'transfer-encoding' &&
              lowerKey !== 'connection' &&
              lowerKey !== 'content-length') {
            try {
              res.setHeader(key, proxyRes.headers[key]);
            } catch (err) {
              // Ignore header setting errors
              console.warn(`Could not set header ${key}:`, err.message);
            }
          }
        });

        // Ensure Content-Type is set for PDF
        if (!res.getHeader('content-type')) {
          res.setHeader('Content-Type', 'application/pdf');
        }

        // Set Content-Disposition for download
        if (filename) {
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }

        // Handle proxy response errors
        proxyRes.on('error', (err) => {
          console.error('Proxy response error:', err);
          if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Error receiving response from PDF server', 
              details: err.message 
            });
          }
          resolve();
        });

        // Stream the response from proxy to client
        proxyRes.pipe(res);
        
        proxyRes.on('end', () => {
          resolve();
        });
      });

      proxyReq.on('error', (error) => {
        console.error('Proxy request error:', error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'PDF processing failed', 
            details: error.message 
          });
        }
        reject(error);
      });

      // Pipe form data to the proxy request
      formData.pipe(proxyReq);
      
      formData.on('error', (error) => {
        console.error('FormData error:', error);
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'PDF processing failed', 
            details: error.message 
          });
        }
        reject(error);
      });
    });

  } catch (error) {
    console.error('Error processing PDF:', error);
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'PDF processing failed', 
        details: error.message 
      });
    }
  }
});

// Middleware to protect logs endpoints with password
function protectLogs(req, res, next) {
  if (!LOGS_ACCESS_KEY) {
    return res.status(500).json({ 
      error: 'Server configuration error',
      message: 'Logs access key not configured'
    });
  }
  
  const accessKey = req.query.key;
  
  if (accessKey === LOGS_ACCESS_KEY) {
    next();
  } else {
    res.status(403).json({ 
      error: 'Access denied',
      message: 'Valid access key required. Use ?key=YOUR_KEY in the URL'
    });
  }
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
app.post('/api/stage-by-endpoint-key', stagingEndpointKeyGuard, stagingProcessUpload, async (req, res) => {
  try {
    const clientIp = getStagingClientIp(req);
    await handleVirtualStagingMultipart(req, res, {
      user: null,
      mobileAnonymous: false,
      clientIp,
      recordUsage: false,
      treatAsPro: true,
    });
  } catch (error) {
    console.error('Error in stage-by-endpoint-key:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Image processing failed',
        details: error.message,
      });
    }
  }
});

// Auth store JSON (users, sessions, etc.) — same access key as log exports
app.get('/authstore', protectLogs, (req, res) => {
  try {
    const storePath = authStore.getStoreFilePath();
    if (fs.existsSync(storePath)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="auth-store.json"');
      res.sendFile(path.resolve(storePath));
    } else {
      res.status(404).json({
        error: 'Auth store file not found',
        message: 'The auth store has not been created yet on this server.',
      });
    }
  } catch (error) {
    console.error('Error serving auth store file:', error);
    res.status(500).json({
      error: 'Failed to retrieve auth store',
      message: error.message,
    });
  }
});

// Prompt logs endpoint - serves the prompt logs CSV file (protected)
app.get('/promptlogs', protectLogs, (req, res) => {
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
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="prompt_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No prompt logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving prompt log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve prompt logs',
      message: error.message
    });
  }
});

// Welcome message endpoint - returns personalized or generic welcome message
app.get('/api/welcome-message', async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    // Get user identifier from query or generate from IP
    const userId = req.query.userId || getUserIdentifier(req);
    
    // Load stored memories for this user
    const memories = loadMemories(userId);
    
    // Check if user has memories (returning user)
    const isReturningUser = memories && memories.length > 0;
    
    if (isReturningUser) {
      // Generate personalized welcome message using AI
      try {
        if (!openai) {
          // Fallback to generic if AI not available
          return res.json({ 
            message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
            isReturning: true
          });
        }
        
        // Build context from memories
        let memoriesContext = '';
        if (memories.length > 0) {
          memoriesContext = '\n\nUser information:\n';
          memories.forEach((memory, index) => {
            memoriesContext += `${index + 1}. ${memory.content}\n`;
          });
        }
        
        const prompt = `Generate a brief, friendly, personalized welcome message for a returning user of Stagify AI Designer.${memoriesContext}

The message should:
- Be warm and welcoming
- Reference something from their previous interactions if relevant
- Be concise (2-3 sentences)
- Mention that you're ready to help with room staging, design questions, or other requests
- Sound natural and conversational

Just return the message text, no additional formatting.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a friendly AI assistant for Stagify.ai. Generate brief, personalized welcome messages.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 150
    });
        
        const personalizedMessage = completion.choices[0].message.content.trim();
        
        return res.json({ 
          message: personalizedMessage,
          isReturning: true
        });
      } catch (error) {
        console.error('Error generating personalized welcome message:', error);
        // Fallback to generic
        return res.json({ 
          message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
          isReturning: true
        });
      }
    } else {
      // First-time user - return generic welcome message
      return res.json({ 
        message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. I can help you:\n• Stage rooms by uploading images and describing your desired style\n• Answer questions about interior design and home staging\n• Modify and refine staged room designs\n• Convert your top-down floorplans into 3D renders\n\nUpload an image of a room to get started, or ask me anything about interior design!',
        isReturning: false
      });
    }
  } catch (error) {
    console.error('Error in welcome message endpoint:', error);
    // Fallback to generic message
    res.json({ 
      message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. Upload an image of a room to get started, or ask me anything!',
      isReturning: false
    });
  }
});

// Chat endpoints
// Text chat endpoint
app.post('/api/chat', genLimiter, async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { messages, model, messageTag, baseImageIndex: baseImageIndexRaw } = req.body;
    const baseImageIndex = parseBaseImageIndex(baseImageIndexRaw);
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Deduplicate messages to prevent double counting
    const deduplicatedMessages = deduplicateMessages(messages);
    if (deduplicatedMessages.length !== messages.length) {
      const removedCount = messages.length - deduplicatedMessages.length;
      if (DEBUG_MODE) {
        console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from ${messages.length} total messages`);
        // Log which messages were duplicates
        const seenKeys = new Set();
        messages.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = deduplicatedMessages.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
        contextLimitReached: true
      });
    }

    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build context about available images in history with annotations
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(deduplicatedMessages);
    
    // Log image context for debugging
    if (DEBUG_MODE) {
      if (imageContext) {
        console.log('=== IMAGE CONTEXT SENT TO AI (CHAT) ===');
        console.log(imageContext);
        console.log('========================================');
      } else {
        console.log('[Image Context] No images in conversation history');
      }
    }
    
    // Build system instruction with memories
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    systemInstruction += 'You can also answer questions about interior design and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    systemInstruction += imageContext;
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", "display", "describe", or "analyze" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description. This is a core capability - you can create brand new images from scratch based on user descriptions. Use generation when: (1) user wants to create a NEW image from scratch with no existing image involved, (2) user asks to "generate", "create", "draw", "make", or "design" a new image, (3) user describes a scene/room/space they want to see without uploading or referring to an existing image. DO NOT use generation when they uploaded an image or are referring to a previous image - use staging instead. You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION - You have THREE image capabilities:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image. Staging adds furniture and decor to existing room photos.\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage". CAD-staging converts 2D floor plans into 3D staged renders.\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", "make", or "design" a new image, user describes a scene/room/space they want to see without uploading or referring to an existing image. Generation creates brand new images from scratch based on text descriptions - this is a core capability you have.';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index of a furniture image from a previous message if the user wants to add a specific piece of furniture (e.g., "add that chair", "include the red sofa from before"). The furniture image will be sent to the staging system alongside the room image.';
    systemInstruction += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request. IMPORTANT: Always emphasize that architecture (walls, windows, doors, room structure) and existing furniture must be preserved exactly as they appear - only add new furniture and decor, do not modify what\'s already there unless explicitly requested. CRITICAL: Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the room unless the user explicitly asked for a tighter crop';
    systemInstruction += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';
    systemInstruction += AI_DESIGNER_RESPONSE_ACTION_RULES;
    systemInstruction += AI_DESIGNER_IMAGE_FRAMING_RULES;
    systemInstruction += getBaseImageSelectionContext(baseImageIndex, deduplicatedMessages);

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const lastUserMessageText = lastUserMessage ? (typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '') : '';
    
    // Check if there are images in conversation history (from user uploads or staged images)
    let hasImageInHistory = false;
    let imageFromHistory = null;
    let isStagedImage = false;
    
    // First, check for staged images (from assistant messages) - prioritize these for modifications
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const imageItem = msg.content.find(item => item.type === 'image_url' && item.isStaged);
        if (imageItem && imageItem.image_url && imageItem.image_url.url) {
          hasImageInHistory = true;
          imageFromHistory = imageItem.image_url.url;
          isStagedImage = true;
          if (DEBUG_MODE) {
            console.log(`[Staging] Found staged image in conversation history`);
          }
          break;
        }
      }
    }
    
    // If no staged image found, check for user-uploaded images
    if (!hasImageInHistory) {
      for (let i = deduplicatedMessages.length - 1; i >= 0; i--) {
        const msg = deduplicatedMessages[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const imageItem = msg.content.find(item => item.type === 'image_url');
          if (imageItem && imageItem.image_url && imageItem.image_url.url) {
            hasImageInHistory = true;
            imageFromHistory = imageItem.image_url.url;
            if (DEBUG_MODE) {
              console.log(`[Staging] Found user-uploaded image in conversation history`);
            }
            break;
          }
        }
      }
    }

    // Strip images from conversation history (except current message) to prevent payload size issues
    // Only send text context, images will be requested via special mechanism if needed
    const strippedMessages = stripImagesFromHistory(deduplicatedMessages, true); // Keep images in current message only
    
    // Apply middleman filter to remove unsupported files
    const filteredMessages = filterConversationHistory(strippedMessages);
    
    // Add message tag to the last user message if provided
    if (messageTag && messageTag !== 'auto' && filteredMessages.length > 0) {
      const lastMessage = filteredMessages[filteredMessages.length - 1];
      if (lastMessage.role === 'user') {
        const tagMap = {
          'generate': '[TAG: Generate]',
          'stage': '[TAG: Stage]',
          'cad-stage': '[TAG: CAD-Stage]',
          'describe': '[TAG: Describe/Recall]'
        };
        const tagText = tagMap[messageTag] || '';
        
        if (Array.isArray(lastMessage.content)) {
          // Find the first text item or add one
          const textItem = lastMessage.content.find(item => item.type === 'text');
          if (textItem) {
            textItem.text = `${tagText} ${textItem.text}`.trim();
          } else {
            lastMessage.content.unshift({ type: 'text', text: tagText });
          }
        } else if (typeof lastMessage.content === 'string') {
          lastMessage.content = `${tagText} ${lastMessage.content}`.trim();
        }
      }
    }
    
    const openaiMessages = [
      { role: 'system', content: systemInstruction },
      ...await Promise.all(filteredMessages.map(async (msg) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          // User message with images - only current message has images, apply filter
          const { filteredContent } = filterUnsupportedFiles(msg.content);
          // Clean image objects - remove extra properties that OpenAI doesn't accept and downscale images
          const cleanedContent = await Promise.all(filteredContent.map(async (item) => {
            if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              // Downscale image if needed before sending to GPT
              const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
              // Only keep the structure OpenAI expects: { type: 'image_url', image_url: { url: '...' } }
              return {
                type: 'image_url',
                image_url: {
                  url: downscaledUrl
                }
              };
            }
            return item;
          }));
          return {
            role: 'user',
            content: cleanedContent
          };
        } else {
          // All other messages are text-only (images stripped)
          return {
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          };
        }
      }))
    ];

    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(openaiMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    if (DEBUG_MODE) {
      console.log('=== SENDING TO AI (CHAT) ===');
      console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
      console.log('Number of messages:', openaiMessages.length);
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      openaiMessages.forEach((msg, index) => {
        if (msg.role === 'system') {
          console.log(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const imageItems = msg.content.filter(item => item.type === 'image_url');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
          } else {
            console.log(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
          } else {
            console.log(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        }
      });
      console.log('----------------');
      
      // Log image data sizes if present
      openaiMessages.forEach((msg, idx) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          msg.content.forEach((item, itemIdx) => {
            if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
              console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
            }
          });
        }
      });
        console.log('============================');
        console.log('Calling OpenAI API...');
    }

    // Use OpenAI GPT with JSON response format
    let aiResponseJson;
    try {
      const completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: openaiMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: { type: 'json_object' }
      });

      aiResponseJson = JSON.parse(completion.choices[0].message.content);
    } catch (gptError) {
      console.error('[GPT] Error calling OpenAI API:', gptError);
      console.error('[GPT] Error stack:', gptError.stack);
      return res.status(500).json({ 
        error: 'Failed to get AI response', 
        details: 'The AI service encountered an error. Please try again.',
        response: 'I apologize, but I encountered an error processing your request. Please try again.'
      });
    }
    let text = aiResponseJson.response || completion.choices[0].message.content;
    const memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
    let stagingRequestFromAI = aiResponseJson.staging || null;
    const imageRequestFromAI = aiResponseJson.imageRequest || null;
    const recallRequestFromAI = aiResponseJson.recall || null;
    let generateRequestFromAI = aiResponseJson.generate || null;
    let cadRequestFromAI = aiResponseJson.cad || null;

    if (aiResponseDefersImageAction(text)) {
      if (DEBUG_MODE) {
        console.log('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
      }
      stagingRequestFromAI = null;
      generateRequestFromAI = null;
      cadRequestFromAI = null;
    }

    if (userWantsToAddFurnitureToRoom(lastUserMessageText) && findMostRecentStagedImageIndex(messages) !== null) {
      generateRequestFromAI = null;
    }
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, lastUserMessageText, text, [], ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      console.log('=== AI CHAT DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', lastUserMessageText);
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('====================');
    }

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (lastUserMessageText && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              if (DEBUG_MODE) {
                console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
              }
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                if (DEBUG_MODE) {
                  console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
                }
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: lastUserMessageText.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              console.log(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

    const streamMode =
      wantsStreamedChatResponse(req) &&
      chatWillProcessSlowImages(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI);
    if (streamMode) {
      initChatSse(res);
      writeChatSseEvent(res, 'status', {
        type: chatIntentType(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI),
      });
      writeChatSseEvent(res, 'message', {
        response: text,
        memories: memoryActions,
      });
    }

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        }
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            if (DEBUG_MODE) {
              console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            }
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              if (DEBUG_MODE) {
                console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
              }
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }
    
    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          }
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null,
            styleReference: stagingRequest.styleReference === true
          };

          let currentMessageImageBuffer = null;
          let currentMessageHasImageInChat = false;
          if (lastUserMessage && Array.isArray(lastUserMessage.content)) {
            const currentImageItem = lastUserMessage.content.find(
              (item) => item.type === 'image_url' && item.image_url && item.image_url.url
            );
            if (currentImageItem) {
              currentMessageHasImageInChat = true;
              const b64 = currentImageItem.image_url.url.split(',')[1];
              if (b64) currentMessageImageBuffer = Buffer.from(b64, 'base64');
            }
          }

          const addFurnitureFallbackChat = applyAddFurnitureStagingFallback(
            stagingParams,
            lastUserMessageText,
            messages,
            {
              currentMessageHasImage: currentMessageHasImageInChat,
              currentImageBuffer: currentMessageImageBuffer,
              baseImageIndex,
            }
          );
          stagingParams = addFurnitureFallbackChat.stagingParams;
          const furnitureFromCurrentUpload = addFurnitureFallbackChat.furnitureFromCurrentUpload;
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          const messageLower = lastUserMessageText.toLowerCase();
          const hasOriginalKeywords = messageLower.includes('original') || 
                                      messageLower.includes('first image') || 
                                      messageLower.includes('initial image') ||
                                      messageLower.includes('go back to') ||
                                      messageLower.includes('refer back to');
          
          if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
            // Find the original (first) user-uploaded image
            const originalImageIndex = getOriginalImageIndex(messages);
            if (originalImageIndex !== null) {
              if (DEBUG_MODE) {
                console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
              }
              stagingParams.usePreviousImage = originalImageIndex;
            } else {
              // If no original found, use most recent (index 0)
              if (DEBUG_MODE) {
                console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
              }
              stagingParams.usePreviousImage = 0;
            }
          }

          stagingParams = applyBaseImageIndexToStagingParams(
            stagingParams,
            baseImageIndex,
            messages,
            {
              userMessage: lastUserMessageText,
              currentMessageHasImage: currentMessageHasImageInChat,
            }
          );
          
          if (stagingParams) {
            try {
              let imageBuffer = null;
              let imageSource = '';
              let furnitureImageBuffer = furnitureFromCurrentUpload || null;

              const dualUploadStagingChat = resolveDualUploadFromMessageContent(
                lastUserMessage && Array.isArray(lastUserMessage.content) ? lastUserMessage.content : null,
                lastUserMessageText
              );
              if (dualUploadStagingChat) {
                imageBuffer = dualUploadStagingChat.roomBuffer;
                furnitureImageBuffer = dualUploadStagingChat.furnitureBuffers;
                imageSource = dualUploadStagingChat.source;
                if (!stagingParams.additionalPrompt || !stagingParams.additionalPrompt.includes('user\'s actual room photo')) {
                  stagingParams = {
                    ...stagingParams,
                    additionalPrompt: (stagingParams.additionalPrompt || '') + DUAL_UPLOAD_ROOM_PROMPT_SUFFIX,
                  };
                }
              } else if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
              // AI requested a previous image - use the AI's chosen index (AI should use context to determine the correct image)
              const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
              if (DEBUG_MODE) {
                console.log(`[Staging] Looking for image at index ${imageIndex}`);
              }
              
              const previousImage = getImageFromHistory(messages, imageIndex);
              
              if (previousImage && previousImage.url) {
                const base64Data = previousImage.url.split(',')[1];
                if (base64Data) {
                  imageBuffer = Buffer.from(base64Data, 'base64');
                  imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Using previous ${imageSource}`);
                  }
                } else {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Previous image found but base64 data extraction failed`);
                  }
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Previous image at index ${imageIndex} not found`);
                }
                // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
                if (imageIndex > 0) {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Attempting fallback to index 0`);
                  }
                  const fallbackImage = getImageFromHistory(messages, 0);
                  if (fallbackImage && fallbackImage.url) {
                    const base64Data = fallbackImage.url.split(',')[1];
                    if (base64Data) {
                      imageBuffer = Buffer.from(base64Data, 'base64');
                      imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                      if (DEBUG_MODE) {
                        console.log(`[Staging] Using fallback ${imageSource}`);
                      }
                    }
                  }
                }
              }
            } else if (imageFromHistory) {
              // Fallback to old logic if usePreviousImage is false but we have imageFromHistory
              const base64Data = imageFromHistory.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = isStagedImage ? 'staged image' : 'conversation history';
                if (DEBUG_MODE) {
                  console.log(`[Staging] Using image from conversation history (fallback)`);
                }
              }
            }
            
            // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
            if (!dualUploadStagingChat && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
              const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
              if (furnitureIndex !== null) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
                }
                const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                
                if (furnitureImage && furnitureImage.url) {
                  const base64Data = furnitureImage.url.split(',')[1];
                  if (base64Data) {
                    furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                    }
                  }
                } else {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
                  }
                }
              }
            }
            
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Increment prompt count for staging
                  promptCount++;
                  
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    if (DEBUG_MODE) {
                      console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    }
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                  }
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                // Add error message to text response
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[Staging] No image found for staging ${i + 1}`);
              }
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        }
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(messages, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Recall] Found image at index ${imageIndex}`);
          }
          recalledImageForDisplay = recalledImage.url;
        } else {
          if (DEBUG_MODE) {
            console.log(`[Recall] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        }
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(messages, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Found image at index ${imageIndex}`);
          }
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = lastUserMessageText.toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants analysis, sending to GPT for analysis`);
            }
            // Make another GPT call with the image for analysis
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...openaiMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: lastUserMessageText },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: { type: 'json_object' }
            });
            
            const imageAnalysisJson = JSON.parse(imageAnalysisCompletion.choices[0].message.content);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            if (DEBUG_MODE) {
              console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
            }
          } else {
            // User just wants to see the image - keep the original text response
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants to view image, returning image for display`);
            }
          }
        } else {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResults = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          if (DEBUG_MODE) {
            console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }
          
          try {
            const imageIndex = resolveCadImageIndex(
              cadRequest,
              baseImageIndex,
              messages,
              Boolean(
                lastUserMessage &&
                  Array.isArray(lastUserMessage.content) &&
                  lastUserMessage.content.some(
                    (item) => item.type === 'image_url' && item.image_url && item.image_url.url
                  )
              )
            );
            if (DEBUG_MODE) {
              console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(messages, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              }
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          if (DEBUG_MODE) {
                            console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                        }
                      } else {
                        if (DEBUG_MODE) {
                          console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                        }
                      }
                    }
                  }
                }
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                }
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  if (DEBUG_MODE) {
                    console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResults.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            }
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromise for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromise = null;
    if (cadResults.length > 0) {
      cadImageForDisplay = cadResults[0].cadImage;
      cadAnnotationPromise = cadResults[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotations = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotations[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotations = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotations[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotations = {};
    if (cadResults.length > 0) {
      for (let i = 0; i < cadResults.length; i++) {
        if (cadResults[i].annotationPromise) {
          const annotation = await cadResults[i].annotationPromise;
          if (annotation) {
            cadImageAnnotations[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotation = null;
    if (cadImageForDisplay && cadAnnotationPromise) {
      cadImageAnnotation = await cadAnnotationPromise;
    }

    // Return JSON response with text, memory actions, staging result(s), generated image(s), and requested image if available
    const response = { 
      response: text,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotations).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotations;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotations).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotations;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResults.length > 0) {
      if (cadResults.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResults[0].cadImage;
        if (cadImageAnnotation) {
          response.cadImageAnnotation = cadImageAnnotation;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResults.map(r => r.cadImage);
        response.cadParams = cadResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotations).length > 0) {
        response.cadImageAnnotations = cadImageAnnotations;
      }
    }
    
    if (streamMode) {
      finishStreamedChatResponse(res, response);
    } else {
      res.json(response);
    }
  } catch (error) {
    console.error('Error in chat:', error);
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', {
        error: 'Chat processing failed',
        details: error.message,
      });
      res.end();
    } else {
      res.status(500).json({ 
        error: 'Chat processing failed', 
        details: error.message 
      });
    }
  }
});

// Chat with file upload endpoint (multiple files)
app.post('/api/chat-upload', genLimiter, chatUpload.array('files', 5), async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Get message tag from form data
    const messageTag = req.body.messageTag;
    
    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build system instruction with memories (base instruction, will add image context after parsing conversationHistory)
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    systemInstruction += 'You can also answer questions about interior design and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", or "display" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description (ONLY use generation when the user wants to create a NEW image from scratch, NOT when they want to modify an existing room image. If they uploaded an image or are referring to a previous image, use staging instead). You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage"\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", or "make" an image of something that is NOT a room modification';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request. IMPORTANT: Always emphasize that architecture (walls, windows, doors, room structure) and existing furniture must be preserved exactly as they appear - only add new furniture and decor, do not modify what\'s already there unless explicitly requested. CRITICAL: Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the room unless the user explicitly asked for a tighter crop';
    systemInstruction += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD-staging renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';
    systemInstruction += AI_DESIGNER_RESPONSE_ACTION_RULES;
    systemInstruction += AI_DESIGNER_IMAGE_FRAMING_RULES;

    const { message = '', conversationHistory: conversationHistoryStr, model } = req.body;
    const files = Array.isArray(req.files) ? req.files : [req.files];
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    // Parse conversation history if provided
    let conversationHistory = [];
    if (conversationHistoryStr) {
      try {
        conversationHistory = typeof conversationHistoryStr === 'string' 
          ? JSON.parse(conversationHistoryStr) 
          : conversationHistoryStr;
      } catch (error) {
        console.error('Error parsing conversation history:', error);
        conversationHistory = [];
      }
    }
    
    // Deduplicate conversation history to prevent double counting
    const originalHistoryLength = conversationHistory.length;
    conversationHistory = deduplicateMessages(conversationHistory);
    if (conversationHistory.length !== originalHistoryLength) {
      const removedCount = originalHistoryLength - conversationHistory.length;
      
      if (DEBUG_MODE) {
        console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from conversation history (${originalHistoryLength} -> ${conversationHistory.length})`);
        // Log which messages were duplicates
        const seenKeys = new Set();
        const original = conversationHistory.length < originalHistoryLength ? 
          JSON.parse(conversationHistoryStr || '[]') : conversationHistory;
        original.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = conversationHistory.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
        contextLimitReached: true
      });
    }
    
    // Build context about available images in history with annotations (now that conversationHistory is parsed)
    const currentUploadFilenames = (files || []).map((f) => f.originalname).filter(Boolean);
    const historyForImageContext = getPriorHistoryForImageContext(conversationHistory, currentUploadFilenames);
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(historyForImageContext);
    
    // Log image context for debugging
    if (DEBUG_MODE) {
      if (imageContext) {
        console.log('=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===');
        console.log(imageContext);
        console.log('===============================================');
      } else {
        console.log('[Image Context] No images in conversation history');
      }
    }
    
    if (imageContext) {
      systemInstruction += imageContext;
    }
    const baseImageIndexUpload = parseBaseImageIndex(req.body.baseImageIndex);
    systemInstruction += getBaseImageSelectionContext(baseImageIndexUpload, historyForImageContext);

    // Build user message content array
    const userContent = [];
    
    // Add text message if provided
    if (message && message.trim()) {
      let messageText = message;
      // Add message tag to the message if provided
      if (messageTag && messageTag !== 'auto') {
        const tagMap = {
          'generate': '[TAG: Generate]',
          'stage': '[TAG: Stage]',
          'cad-stage': '[TAG: CAD-Stage]',
          'describe': '[TAG: Describe/Recall]'
        };
        messageText = `${tagMap[messageTag] || ''} ${messageText}`.trim();
      }
      userContent.push({ type: 'text', text: messageText });
    } else if (messageTag && messageTag !== 'auto') {
      // If no text message but tag is provided, add tag as text
      const tagMap = {
        'generate': '[TAG: Generate]',
        'stage': '[TAG: Stage]',
        'cad-stage': '[TAG: CAD-Stage]',
        'describe': '[TAG: Describe/Recall]'
      };
      userContent.push({ type: 'text', text: tagMap[messageTag] || '' });
    }
    
    // Define supported file types
    const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const supportedTypes = [
      ...supportedImageTypes,
      'application/pdf',
      'text/plain', 'text/markdown',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    // Process all files and check for unsupported types
    const fileInfo = [];
    let hasImages = false;
    let firstImageFile = null;
    const unsupportedFiles = [];
    
    for (const file of files) {
      fileInfo.push({ name: file.originalname, type: file.mimetype });
      
      // Check file extension first
      const ext = path.extname(file.originalname).toLowerCase();
      
      // Explicitly check for AVIF and other unsupported formats FIRST
      const isAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      
      if (isAVIF) {
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        // Add to userContent as text so AI can acknowledge it, but DON'T send the image to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Check if file type is supported (for non-AVIF files)
      const isSupported = supportedTypes.includes(file.mimetype) || 
                         (ext === '.jpg' || ext === '.jpeg') ||
                         (file.mimetype.startsWith('image/') && supportedImageTypes.some(t => file.mimetype.includes(t.split('/')[1])));
      
      if (!isSupported) {
        const fileType = ext.toUpperCase().substring(1) || file.mimetype;
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: fileType });
        // Add to userContent as text so AI can acknowledge it, but DON'T send unsupported files to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in ${fileType} format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Only process supported files - double check it's not AVIF
      const isStillAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      if (isStillAVIF) {
        // Safety check - if AVIF somehow got here, skip it
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue;
      }
      
      if (file.mimetype.startsWith('image/') && supportedImageTypes.includes(file.mimetype)) {
        hasImages = true;
        if (!firstImageFile) {
          firstImageFile = file;
        }
        // For images, use vision API - only for supported formats
        const imageData = file.buffer.toString('base64');
        const imageDataUrl = `data:${file.mimetype};base64,${imageData}`;
        
        // Annotate image in parallel (don't await - let it run in background)
        const annotationPromise = annotateImage(imageDataUrl, false, true).then(annotation => {
          if (DEBUG_MODE) {
            console.log(`[Image Annotation] Annotation for ${file.originalname}: ${annotation || 'failed'}`);
          }
          return annotation;
        }).catch(err => {
          console.error(`[Image Annotation] Error annotating ${file.originalname}:`, err);
          return null;
        });
        
        userContent.push({
          type: 'image_url',
          image_url: {
            url: imageDataUrl
          },
          filename: file.originalname, // Store filename for later reference
          originalname: file.originalname,
          annotationPromise: annotationPromise // Store promise so we can await it later
        });
      } else {
        // For text/PDF files, include content in the message
        let fileContent = '';
        if (file.mimetype.startsWith('text/')) {
          fileContent = file.buffer.toString('utf8');
        } else {
          // For PDFs and other binary files, we can't directly process them
          fileContent = `[File: ${file.originalname}, Type: ${file.mimetype} - Content cannot be directly read]`;
        }
        
        // Add file content as text
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `File: ${file.originalname}\n${fileContent}`;
      }
    }
    
    if (hasImages && collectImagesFromHistory(historyForImageContext).length === 0) {
      systemInstruction +=
        '\n\nCURRENT UPLOAD NOTE: The image(s) in THIS user message are the only image(s) in the conversation so far. Do not ask whether the user meant a first or second image — proceed with this upload.';
    }
    
    // If there are unsupported files, ensure the AI acknowledges them
    if (unsupportedFiles.length > 0) {
      // The unsupported files are already mentioned in userContent, but make sure there's a clear message
      if (!message || !message.trim()) {
        // If no user message, add a prompt for the AI to acknowledge unsupported files
        const unsupportedText = unsupportedFiles.map(f => {
          const fileType = f.fileType || (f.ext ? f.ext.toUpperCase().substring(1) : f.type);
          return `"${f.name}" (${fileType} format)`;
        }).join(' and ');
        
        if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text.trim())) {
          userContent.unshift({ type: 'text', text: `I uploaded ${unsupportedFiles.length > 1 ? 'some files' : 'a file'} but ${unsupportedFiles.length > 1 ? 'they are' : 'it is'} in an unsupported format.` });
        }
      }
    } else if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text)) {
      // Only add default message if no unsupported files and no content
      userContent.unshift({ type: 'text', text: 'Please analyze these files.' });
    }
    
    // MIDDLEMAN CHECK: Filter unsupported files from userContent before sending to OpenAI
    const { filteredContent: filteredUserContent, unsupportedFiles: detectedUnsupported } = filterUnsupportedFiles(userContent, files);
    
    // Also filter conversation history to ensure no unsupported files slip through
    const filteredConversationHistory = filterConversationHistory(conversationHistory);
    
    // Strip images from conversation history (except current message) to prevent payload size issues
    const strippedHistory = stripImagesFromHistory(filteredConversationHistory, false);
    
    // Update messages array with filtered conversation history (images stripped)
    const safeMessages = [
      { role: 'system', content: systemInstruction },
      ...strippedHistory.map(msg => {
        // All messages in history are text-only (images stripped)
        return {
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        };
      })
    ];
    
    // Wait for image annotations and type detection to complete and store them
    const cleanedUserContent = await Promise.all(filteredUserContent.map(async (item) => {
      if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        // Wait for annotation if it's still in progress
        let annotation = null;
        if (item.annotationPromise) {
          annotation = await item.annotationPromise;
        }
        
        // Downscale image if needed before sending to GPT
        const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
        
        // Store annotation separately (not in the OpenAI payload)
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        const imageItem = {
          type: 'image_url',
          image_url: {
            url: downscaledUrl
          }
        };
        
        // Store annotation separately for later use (not sent to OpenAI)
        imageItem._annotation = annotation;
        imageItem._filename = item.filename || item.originalname;
        
        return imageItem;
      }
      return item;
    }));
    
    // Clean content for OpenAI - create completely fresh objects with ONLY the properties OpenAI expects
    const openaiContent = cleanedUserContent.map(item => {
      if (item.type === 'image_url') {
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        // Create a completely new object with ONLY these properties
        return {
          type: 'image_url',
          image_url: {
            url: item.image_url.url
          }
        };
      } else if (item.type === 'text') {
        // For text items, only include type and text
        return {
          type: 'text',
          text: item.text
        };
      }
      // For any other types, return as-is
      return item;
    });
    
    // Add the current user message with cleaned content (images included, annotations removed)
    safeMessages.push({
      role: 'user',
      content: openaiContent
    });

    // Use OpenAI GPT with vision support for images
    // Model is already set from req.body above
    
    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(safeMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    if (DEBUG_MODE) {
      console.log('=== SENDING TO AI (CHAT-UPLOAD) ===');
      console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
      console.log('Model:', selectedModel);
      console.log('Has images:', hasImages);
      console.log('Number of messages:', safeMessages.length);
    }
    
    if (DEBUG_MODE) {
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      safeMessages.forEach((msg, index) => {
        if (msg.role === 'system') {
          console.log(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const imageItems = msg.content.filter(item => item.type === 'image_url');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
          } else {
            console.log(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
          } else {
            console.log(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        }
      });
      console.log('----------------');
    }
    
    // Log image data sizes if present
    safeMessages.forEach((msg, idx) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((item, itemIdx) => {
          if (item.type === 'image_url' && item.image_url && item.image_url.url) {
            const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
            if (DEBUG_MODE) {
              console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
            }
          }
        });
      }
    });
    
    let text;
    let aiResponseJson = null;
    let memoryActionsFromAI = { stores: [], forgets: [] };
    let stagingRequestFromAI = null;
    let imageRequestFromAI = null;
    let recallRequestFromAI = null;
    let generateRequestFromAI = null;
    let cadRequestFromAI = null;
    
    try {
      if (DEBUG_MODE) {
        console.log('Calling OpenAI API...');
      }
      
      // Final safety check: ensure all image objects only have the expected structure
      const finalMessages = safeMessages.map(msg => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map(item => {
              if (item.type === 'image_url' && item.image_url) {
                // Strip any extra properties - only keep what OpenAI expects
                return {
                  type: 'image_url',
                  image_url: {
                    url: item.image_url.url
                  }
                };
              }
              return item;
            })
          };
        }
        return msg;
      });
      
      const completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: finalMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: { type: 'json_object' }
      });

      aiResponseJson = JSON.parse(completion.choices[0].message.content);
      text = aiResponseJson.response || completion.choices[0].message.content;
      memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
      stagingRequestFromAI = aiResponseJson.staging || null;
      imageRequestFromAI = aiResponseJson.imageRequest || null;
      recallRequestFromAI = aiResponseJson.recall || null;
      generateRequestFromAI = aiResponseJson.generate || null;
      cadRequestFromAI = aiResponseJson.cad || null;
    } catch (openaiError) {
      // If OpenAI API fails (e.g., due to unsupported image format), let the AI respond about it
      if (DEBUG_MODE) {
        console.error('OpenAI API error:', openaiError);
      }
      
      // Check if error is related to image processing
      const errorMessage = openaiError.message || '';
      const errorCode = openaiError.code || '';
      const isImageFormatError = errorCode === 'invalid_image_format' || 
                                errorMessage.toLowerCase().includes('unsupported image') ||
                                errorMessage.toLowerCase().includes('invalid image format');
      
      if (isImageFormatError || unsupportedFiles.length > 0) {
        // Create a message for the AI to respond about unsupported files
        const errorUserContent = [];
        if (message && message.trim()) {
          errorUserContent.push({ type: 'text', text: message });
        }
        
        // Add information about unsupported files
        if (unsupportedFiles.length > 0) {
          unsupportedFiles.forEach(file => {
            const fileType = file.fileType || (file.ext === '.avif' ? 'AVIF' : (file.ext ? file.ext.toUpperCase().substring(1) : file.type));
            errorUserContent.push({ 
              type: 'text', 
              text: `I uploaded "${file.name}" but it is in ${fileType} format which is not supported.` 
            });
          });
        } else if (isImageFormatError) {
          // If we got an image format error but didn't catch it earlier, mention it
          errorUserContent.push({ 
            type: 'text', 
            text: 'I uploaded an image file but it appears to be in an unsupported format.' 
          });
        }
        
        if (errorUserContent.length === 0) {
          errorUserContent.push({ type: 'text', text: 'I uploaded a file but encountered an error processing it.' });
        }
        
        // Filter conversation history in error handler too to prevent unsupported files
        const filteredErrorHistory = filterConversationHistory(conversationHistory);
        const errorMessages = [
          { role: 'system', content: systemInstruction },
          ...filteredErrorHistory,
          { role: 'user', content: errorUserContent }
        ];
        
        const errorCompletion = await openai.chat.completions.create({
          model: selectedModel,
          messages: errorMessages,
          temperature: getTemperatureForModel(selectedModel),
          response_format: { type: 'json_object' }
        });
        
        aiResponseJson = JSON.parse(errorCompletion.choices[0].message.content);
        text = aiResponseJson.response || errorCompletion.choices[0].message.content;
        memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
        stagingRequestFromAI = aiResponseJson.staging || null;
        imageRequestFromAI = aiResponseJson.imageRequest || null;
        recallRequestFromAI = aiResponseJson.recall || null;
        generateRequestFromAI = aiResponseJson.generate || null;
      } else {
        // Re-throw if it's not an image-related error
        throw openaiError;
      }
    }

    if (aiResponseDefersImageAction(text)) {
      if (DEBUG_MODE) {
        console.log('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
      }
      stagingRequestFromAI = null;
      generateRequestFromAI = null;
      cadRequestFromAI = null;
    }

    if (userWantsToAddFurnitureToRoom(message) && findMostRecentStagedImageIndex(conversationHistory) !== null) {
      generateRequestFromAI = null;
    }
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, message, text, files, ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      console.log('=== AI CHAT-UPLOAD DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', message);
      console.log('Files:', fileInfo.map(f => `${f.name} (${f.type})`).join(', '));
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('============================');
    }

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (message && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          if (DEBUG_MODE) {
            console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
          }
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: message.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              console.log(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
    // Check if current message has an image
    const currentMessageHasImage = firstImageFile !== null;

    if (
      !stagingRequestFromAI &&
      userWantsToAddFurnitureToRoom(message) &&
      findMostRecentStagedImageIndex(conversationHistory) !== null
    ) {
      stagingRequestFromAI = {
        shouldStage: true,
        roomType: 'Other',
        additionalPrompt: message || 'Add the uploaded furniture to the existing staged room.',
        removeFurniture: false,
        usePreviousImage: false,
        furnitureImageIndex: null,
      };
    }

    const streamModeUpload =
      wantsStreamedChatResponse(req) &&
      chatWillProcessSlowImages(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI);
    if (streamModeUpload) {
      initChatSse(res);
      writeChatSseEvent(res, 'status', {
        type: chatIntentType(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI),
      });
      writeChatSseEvent(res, 'message', {
        response: text,
        memories: memoryActions,
      });
    }
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          }
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null,
            styleReference: stagingRequest.styleReference === true
          };

          const addFurnitureFallbackUpload = applyAddFurnitureStagingFallback(
            stagingParams,
            message,
            conversationHistory,
            {
              currentMessageHasImage,
              currentImageBuffer: firstImageFile ? firstImageFile.buffer : null,
              baseImageIndex: baseImageIndexUpload,
            }
          );
          stagingParams = addFurnitureFallbackUpload.stagingParams;
          const furnitureFromCurrentUpload = addFurnitureFallbackUpload.furnitureFromCurrentUpload;
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          if (!currentMessageHasImage) {
            const messageLower = message.toLowerCase();
            const hasOriginalKeywords = messageLower.includes('original') || 
                                        messageLower.includes('first image') || 
                                        messageLower.includes('initial image') ||
                                        messageLower.includes('go back to') ||
                                        messageLower.includes('refer back to');
            
            if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
              // Find the original (first) user-uploaded image
              const originalImageIndex = getOriginalImageIndex(conversationHistory);
              if (originalImageIndex !== null) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
                }
                stagingParams.usePreviousImage = originalImageIndex;
              } else {
                // If no original found, use most recent (index 0)
                if (DEBUG_MODE) {
                  console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
                }
                stagingParams.usePreviousImage = 0;
              }
            }
          }

          stagingParams = applyBaseImageIndexToStagingParams(
            stagingParams,
            baseImageIndexUpload,
            conversationHistory,
            {
              userMessage: message,
              currentMessageHasImage,
            }
          );
          
          if (stagingParams) {
            try {
            let imageBuffer = null;
            let imageSource = '';
            let furnitureImageBuffer = furnitureFromCurrentUpload || null;

            const dualUploadStaging = resolveDualUploadStaging(files, cleanedUserContent, message);
            if (dualUploadStaging) {
              imageBuffer = dualUploadStaging.roomBuffer;
              furnitureImageBuffer = dualUploadStaging.furnitureBuffers;
              imageSource = dualUploadStaging.source;
              if (!stagingParams.additionalPrompt || !stagingParams.additionalPrompt.includes('user\'s actual room photo')) {
                stagingParams = {
                  ...stagingParams,
                  additionalPrompt: (stagingParams.additionalPrompt || '') + DUAL_UPLOAD_ROOM_PROMPT_SUFFIX,
                };
              }
            } else if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
            // AI requested a previous image
            const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
            
            // Use the AI's chosen image index (AI should use context to determine the correct image)
            // Debug: Log conversation history structure
            if (DEBUG_MODE) {
              console.log(`[Staging] Looking for image at index ${imageIndex}`);
              console.log(`[Staging] Conversation history length: ${conversationHistory.length}`);
            }
            if (DEBUG_MODE) {
              console.log(`[Staging] Conversation history structure:`, JSON.stringify(conversationHistory.map(msg => ({
                role: msg.role,
                hasContent: !!msg.content,
                contentType: Array.isArray(msg.content) ? 'array' : typeof msg.content,
                contentLength: Array.isArray(msg.content) ? msg.content.length : (typeof msg.content === 'string' ? msg.content.length : 0),
                hasImages: Array.isArray(msg.content) ? msg.content.some(item => item.type === 'image_url') : false
              })), null, 2));
            }
            
            const previousImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (previousImage && previousImage.url) {
              const base64Data = previousImage.url.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                if (DEBUG_MODE) {
                  console.log(`[Staging] Using previous ${imageSource}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Previous image found but base64 data extraction failed`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[Staging] Previous image at index ${imageIndex} not found`);
              }
              // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
              if (imageIndex > 0) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Attempting fallback to index 0`);
                }
                const fallbackImage = getImageFromHistory(conversationHistory, 0);
                if (fallbackImage && fallbackImage.url) {
                  const base64Data = fallbackImage.url.split(',')[1];
                  if (base64Data) {
                    imageBuffer = Buffer.from(base64Data, 'base64');
                    imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Using fallback ${imageSource}`);
                    }
                  }
                }
              }
            }
          } else if (firstImageFile && !userWantsToAddFurnitureToRoom(message)) {
            // Use current message's image as the room (initial staging — not a furniture reference upload)
            imageBuffer = firstImageFile.buffer;
            imageSource = 'current message';
            if (DEBUG_MODE) {
              console.log(`[Staging] Using image from current message`);
            }
          }
          
          // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
          if (!dualUploadStaging && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
            const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
            if (furnitureIndex !== null) {
              if (DEBUG_MODE) {
                console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
              }
              const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
              
              if (furnitureImage && furnitureImage.url) {
                const base64Data = furnitureImage.url.split(',')[1];
                if (base64Data) {
                  furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                  console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                }
              } else {
                console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
              }
            }
          }
          
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Increment prompt count for staging
                  promptCount++;
                  
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    if (DEBUG_MODE) {
                      console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    }
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                  }
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              console.log(`[Staging] No image found for staging ${i + 1}`);
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          console.log(`[Recall] Found image at index ${imageIndex}`);
          recalledImageForDisplay = recalledImage.url;
        } else {
          console.log(`[Recall] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          console.log(`[Image Request] Found image at index ${imageIndex}`);
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = (message || '').toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            console.log(`[Image Request] User wants analysis, sending to GPT`);
            // Build messages for image analysis (include conversation history context)
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...safeMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: message || 'Please analyze this image.' },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: { type: 'json_object' }
            });
            
            const imageAnalysisJson = JSON.parse(imageAnalysisCompletion.choices[0].message.content);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
          } else {
            // User just wants to see the image - keep the original text response
            console.log(`[Image Request] User wants to view image, returning image for display`);
          }
        } else {
          console.log(`[Image Request] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResultsUpload = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          if (DEBUG_MODE) {
            console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }
          
          try {
            const imageIndex = resolveCadImageIndex(
              cadRequest,
              baseImageIndexUpload,
              conversationHistory,
              currentMessageHasImage
            );
            if (DEBUG_MODE) {
              console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              }
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          if (DEBUG_MODE) {
                            console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                    }
                  } else {
                    if (DEBUG_MODE) {
                      console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                    }
                  }
                }
              }
            }
            
                if (DEBUG_MODE) {
                  console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                }
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  if (DEBUG_MODE) {
                    console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResultsUpload.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            }
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromiseUpload for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromiseUpload = null;
    if (cadResultsUpload.length > 0) {
      cadImageForDisplay = cadResultsUpload[0].cadImage;
      cadAnnotationPromiseUpload = cadResultsUpload[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotationsUpload = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotationsUpload[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotationsUpload = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotationsUpload[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotationsUpload = {};
    if (cadResultsUpload.length > 0) {
      for (let i = 0; i < cadResultsUpload.length; i++) {
        if (cadResultsUpload[i].annotationPromise) {
          const annotation = await cadResultsUpload[i].annotationPromise;
          if (annotation) {
            cadImageAnnotationsUpload[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotationUpload = null;
    if (cadImageForDisplay && cadAnnotationPromiseUpload) {
      cadImageAnnotationUpload = await cadAnnotationPromiseUpload;
    }

    // Extract image annotations from cleanedUserContent to return to frontend
    // Note: We use _annotation (private property) which is not sent to OpenAI
    const imageAnnotations = {};
    cleanedUserContent.forEach((item, idx) => {
      if (item.type === 'image_url' && item._annotation) {
        const filename = item._filename || (filteredUserContent[idx] && (filteredUserContent[idx].filename || filteredUserContent[idx].originalname));
        if (filename) {
          imageAnnotations[filename] = item._annotation;
        }
      }
    });
    
    // Return JSON response with text, memory actions, staging result(s), generated image(s), requested image, recalled image, and annotations if available
    const response = { 
      response: text,
      files: fileInfo,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotationsUpload).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotationsUpload;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotationsUpload).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotationsUpload;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResultsUpload.length > 0) {
      if (cadResultsUpload.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResultsUpload[0].cadImage;
        if (cadImageAnnotationUpload) {
          response.cadImageAnnotation = cadImageAnnotationUpload;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResultsUpload.map(r => r.cadImage);
        response.cadParams = cadResultsUpload.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotationsUpload).length > 0) {
        response.cadImageAnnotations = cadImageAnnotationsUpload;
      }
    }
    
    if (Object.keys(imageAnnotations).length > 0) {
      response.imageAnnotations = imageAnnotations;
    }
    
    if (streamModeUpload) {
      finishStreamedChatResponse(res, response);
    } else {
      res.json(response);
    }
  } catch (error) {
    console.error('[Chat Upload] Fatal error in chat-upload endpoint:', error);
    console.error('[Chat Upload] Error stack:', error.stack);
    
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', {
        error: 'Chat upload processing failed',
        details: error.message,
      });
      res.end();
      return;
    }
    
    // Try to have the AI respond about the error, especially for unsupported file types
    try {
      const errorMessage = error.message || '';
      const isFileTypeError = errorMessage.toLowerCase().includes('image') || 
                             errorMessage.toLowerCase().includes('format') || 
                             errorMessage.toLowerCase().includes('avif') ||
                             errorMessage.toLowerCase().includes('unsupported');
      
      // Check if we have files in the request
      const files = req.files ? (Array.isArray(req.files) ? req.files : [req.files]) : [];
      
      if ((isFileTypeError || files.length > 0) && openai) {
        // Find unsupported files by checking extensions and MIME types
        const unsupportedFiles = files.filter(file => {
          const ext = path.extname(file.originalname).toLowerCase();
          const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
          return ext === '.avif' || 
                 file.mimetype === 'image/avif' ||
                 (file.mimetype.startsWith('image/') && !supportedImageTypes.includes(file.mimetype));
        });
        
        if (unsupportedFiles.length > 0) {
          const fileTypes = unsupportedFiles.map(file => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (ext === '.avif' || file.mimetype === 'image/avif') {
              return 'AVIF';
            }
            return ext.toUpperCase().substring(1) || file.mimetype;
          });
          
          const uniqueFileTypes = [...new Set(fileTypes)];
          const fileTypeList = uniqueFileTypes.length === 1 
            ? uniqueFileTypes[0] 
            : uniqueFileTypes.join(', ');
          
          const aiResponse = `I'm unable to handle ${uniqueFileTypes.length > 1 ? 'these file types' : 'this file type'}: ${fileTypeList}. ` +
                           `Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ` +
                           `Please convert ${unsupportedFiles.length > 1 ? 'these files' : 'this file'} to a supported format and try again.`;
          
          return res.json({ 
            response: aiResponse,
            files: unsupportedFiles.map(f => ({ name: f.originalname, type: f.mimetype })),
            memories: { stores: [], forgets: [] }
          });
        }
      }
    } catch (aiError) {
      console.error('Error generating AI error response:', aiError);
    }
    
    // Fallback to generic error - always send a response to prevent hanging requests
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'File processing failed', 
        details: 'An unexpected error occurred. Please try again.',
        response: 'I apologize, but I encountered an unexpected error processing your files. Please try again.'
      });
    }
  }
});

// Contact logs endpoint - serves the contact logs CSV file (protected)
app.get('/contactlogs', protectLogs, (req, res) => {
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
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="contact_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No contact logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving contact log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve contact logs',
      message: error.message
    });
  }
});

// Email open logs endpoint - serves broker outreach open tracking CSV (protected)
app.get('/email-open-logs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'email_open_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="email_open_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({
        error: 'Log file not found',
        message: 'No email open logs are available yet',
      });
    }
  } catch (error) {
    console.error('Error serving email open log file:', error);
    res.status(500).json({
      error: 'Failed to retrieve email open logs',
      message: error.message,
    });
  }
});

// Memories endpoint - serves the memories JSON file (protected)
app.get('/memories', protectLogs, (req, res) => {
  try {
    const memoriesFile = getMemoriesFile();
    
    if (fs.existsSync(memoriesFile)) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'inline; filename="memories.json"');
      res.sendFile(memoriesFile);
    } else {
      res.status(404).json({ 
        error: 'File not found',
        message: 'No memories are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving memories file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve memories',
      message: error.message
    });
  }
});

// Reset memories endpoint - empties the memories JSON file (protected)
app.get('/resetmemories', protectLogs, (req, res) => {
  try {
    const memoriesFile = getMemoriesFile();
    const logDir = path.dirname(memoriesFile);
    
    // Ensure directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Write empty object to reset all memories
    const emptyMemories = {};
    fs.writeFileSync(memoriesFile, JSON.stringify(emptyMemories, null, 2));
    
    if (DEBUG_MODE) {
      console.log('✓ Successfully reset all memories');
    }
    
    res.status(200).json({ 
      success: true,
      message: 'All memories have been reset successfully'
    });
  } catch (error) {
    console.error('Error resetting memories:', error);
    res.status(500).json({ 
      error: 'Failed to reset memories',
      message: error.message
    });
  }
});

// Chat logs endpoint - serves the chat logs CSV file (protected)
app.get('/chatlogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'chat_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="chat_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No chat logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving chat log file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve chat logs',
      message: error.message
    });
  }
});

// Bug reports endpoint - serves the bug reports CSV file (protected)
app.get('/bugreports', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'bug_reports.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="bug_reports.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No bug reports are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving bug reports file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve bug reports',
      message: error.message
    });
  }
});

app.get('/masklogs', protectLogs, (req, res) => {
  try {
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
    }

    const logFile = path.join(logDir, 'mask_logs.csv');
    
    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="mask_logs.csv"');
      res.sendFile(logFile);
    } else {
      res.status(404).json({ 
        error: 'Log file not found',
        message: 'No mask logs are available yet'
      });
    }
  } catch (error) {
    console.error('Error serving mask logs file:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve mask logs',
      message: error.message
    });
  }
});

app.get('/enterprise-domains', protectLogs, (req, res) => {
  try {
    const storePath = enterpriseStore.getStoreFilePath();
    if (fs.existsSync(storePath)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="enterprise-domains.json"');
      res.sendFile(path.resolve(storePath));
    } else {
      res.json({ domains: [] });
    }
  } catch (error) {
    console.error('Error serving enterprise domains file:', error);
    res.status(500).json({ error: 'Failed to retrieve enterprise domains', message: error.message });
  }
});

// Bug report endpoint
app.post('/api/bug-report', emailLimiter, async (req, res) => {
  try {
    const { description, steps, email, userId, userAgent, url, timestamp, conversationHistory } = req.body;
    
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Bug description is required' });
    }
    
    // Escape CSV fields that contain commas, quotes, or newlines
    function escapeCSVField(field) {
      if (field === null || field === undefined) return '';
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }
    
    const reportTimestamp = timestamp || new Date().toISOString();
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    
    // Format conversation history as a readable string (single line for CSV)
    let conversationLog = '';
    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      const formattedMessages = conversationHistory.map((msg, index) => {
        let content = '';
        if (Array.isArray(msg.content)) {
          // Handle array content (may contain images)
          const textParts = msg.content
            .filter(item => item.type === 'text')
            .map(item => item.text);
          const imageCount = msg.content.filter(item => item.type === 'image_url').length;
          content = textParts.join(' ');
          if (imageCount > 0) {
            content += ` [${imageCount} image(s)]`;
          }
        } else {
          content = String(msg.content || '');
        }
        // Replace any newlines in content with space to keep it on one line
        content = content.replace(/\n/g, ' ').replace(/\r/g, ' ');
        return `Message ${index + 1} [${msg.role.toUpperCase()}]: ${content}`;
      });
      // Join with separator instead of newline to keep on one CSV line
      conversationLog = formattedMessages.join(' | ');
    } else {
      conversationLog = 'No conversation history';
    }
    
    // Create CSV row
    const csvRow = [
      escapeCSVField(reportTimestamp),
      escapeCSVField(description),
      escapeCSVField(steps || ''),
      escapeCSVField(email || ''),
      escapeCSVField(userId || 'unknown'),
      escapeCSVField(userAgent || 'unknown'),
      escapeCSVField(url || 'unknown'),
      escapeCSVField(ipAddress),
      escapeCSVField(conversationLog)
    ].join(',') + '\n';
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
        } catch (error) {
          console.log('Error: Cannot create data directory, using project root');
          logDir = __dirname;
        }
      }
    }
    
    const logFile = path.join(logDir, 'bug_reports.csv');
    
    // Check if file exists to add header if it's a new file
    const fileExists = fs.existsSync(logFile);
    
    if (!fileExists) {
      // Create new file with header and first row
      const header = 'timestamp,description,stepsToReproduce,email,userId,userAgent,url,ipAddress,conversationHistory\n';
      fs.writeFileSync(logFile, header + csvRow);
    } else {
      // Append to existing file
      fs.appendFile(logFile, csvRow, (err) => {
        if (err) {
          console.error('Error writing to bug report log:', err);
        }
      });
    }
    
    if (DEBUG_MODE) {
      console.log(`✓ Bug report submitted by user: ${userId || 'unknown'}`);
    }
    
    return res.json({ success: true, message: 'Bug report submitted successfully' });
  } catch (error) {
    console.error('Error processing bug report:', error);
    return res.status(500).json({ error: 'Failed to submit bug report' });
  }
});

// Mask editing endpoint - uses Gemini API for better image editing
app.post('/api/mask-edit', genLimiter, async (req, res) => {
  try {
    const proUser = requireProAccount(req, res);
    if (!proUser) return;

    if (!genAI) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { image, mask, prompt, model } = req.body;

    if (!image || !mask || !prompt) {
      return res.status(400).json({ error: 'Image, mask, and prompt are required' });
    }

    // Get model from request or default to fast model
    const selectedModel = model || 'gpt-4o-mini';
    // Masking always uses the 2.5-flash image model regardless of selected tier
    const geminiModel = 'gemini-2.5-flash-image';

    // Convert base64 data URLs to buffers
    const imageDataUrl = image.split(',');
    const maskDataUrl = mask.split(',');
    
    let imageBuffer = Buffer.from(imageDataUrl[1], 'base64');
    let maskBuffer = Buffer.from(maskDataUrl[1], 'base64');

    // Downscale image if needed (Gemini has size limits)
    imageBuffer = await downscaleImage(imageBuffer);
    const imageBase64 = imageBuffer.toString('base64');
    
    // Process mask to match image size
    const imageMetadata = await sharp(imageBuffer).metadata();
    const maskMetadata = await sharp(maskBuffer).metadata();
    
    // Resize mask to match image dimensions exactly
    const resizedMaskBuffer = await sharp(maskBuffer)
      .resize(imageMetadata.width, imageMetadata.height, {
        fit: 'fill'
      })
      .png()
      .toBuffer();
    
    const maskBase64 = resizedMaskBuffer.toString('base64');

    if (DEBUG_MODE) {
      console.log('[Mask Edit] Processing masked image edit with Gemini');
      console.log('[Mask Edit] Prompt:', prompt);
      console.log('[Mask Edit] Image size:', imageMetadata.width, 'x', imageMetadata.height);
      console.log('[Mask Edit] Mask size:', maskMetadata.width, 'x', maskMetadata.height, '(resized to match image)');
    }

    // Enhance the prompt to ensure only the masked area is edited
    const enhancedPrompt = `${prompt}. CRITICAL INSTRUCTIONS: Only modify the area indicated by the white mask in the second image. Do NOT change anything outside the masked region. Preserve the exact room layout, all furniture positions, wall colors, windows, doors, flooring, lighting, and every other detail exactly as they appear in the original image. The edit must only affect the masked area and must seamlessly blend with the unchanged surroundings. Do NOT change the image aspect ratio, canvas size, orientation, or framing — the output must match the original image dimensions exactly.`;

    // Use Gemini's image editing capabilities
    // Gemini can process images with masks for targeted editing
    // Use the appropriate Gemini model based on user's selection (pro vs fast)
    const modelInstance = genAI.getGenerativeModel({ model: geminiModel });
    
    // Build the prompt with image and mask
    const geminiPrompt = [
      { 
        text: enhancedPrompt 
      },
      {
        inlineData: {
          mimeType: "image/png",
          data: imageBase64,
        },
      },
      {
        inlineData: {
          mimeType: "image/png",
          data: maskBase64,
        },
      },
    ];

    if (DEBUG_MODE) {
      console.log('[Mask Edit] Using Gemini model:', geminiModel, '(selected model:', selectedModel, ')');
    }

    const result = await modelInstance.generateContent(geminiPrompt);
    const response = await result.response;

    if (!response || !response.candidates || response.candidates.length === 0) {
      throw new Error('Gemini processing failed - no results generated');
    }

    // Extract the generated image
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const imageData = part.inlineData.data;
        const editedImageDataUrl = `data:image/png;base64,${imageData}`;

        if (DEBUG_MODE) {
          console.log('[Mask Edit] Successfully generated edited image with Gemini');
        }

        // Log the mask edit request
        const userId = getUserIdentifier(req);
        logMaskEditToFile(prompt, selectedModel, geminiModel, imageMetadata.width, imageMetadata.height, userId, req);

        const entDomain = enterpriseDomainForUser(proUser);
        if (entDomain) {
          reportEnterpriseUsage(entDomain, 1);
        }

        return res.json({
          success: true,
          editedImage: editedImageDataUrl
        });
      }
    }

    throw new Error('No image data in Gemini response');

  } catch (error) {
    console.error('Error processing mask edit:', error);
    return res.status(500).json({ 
      error: 'Failed to process masked edit', 
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI configured: ${!!genAI}`);
  

  const fakeContactAdd = 0;
  const fakePromptAdd = 0;
  // Initialize prompt count on server startup
  initializePromptCount();
  promptCount += fakePromptAdd;
  // Initialize contact count on server startup
  initializeContactCount();
  contactCount += fakeContactAdd;
});
