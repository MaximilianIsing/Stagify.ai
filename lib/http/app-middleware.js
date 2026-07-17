// Base HTTP middleware wiring for the app, lifted out of the composition root
// (server.js). Split into TWO functions on purpose: the billing router must be
// mounted BETWEEN them (it needs the raw request body for Stripe signature
// verification, before express.json runs). Do not collapse them.
//
//   applyEdgeMiddleware(app)  — security headers, CORS, compression (before billing)
//   applyBodyAndStatic(app)   — JSON body parsing + its error handler, static assets (after billing)
//
// No injected server state: all config (CSP directives, the origin allow-list,
// the no-compress + large-JSON path sets) moves inline with the middleware it
// configures, and the process.env flags (DISABLE_CSP, ALLOWED_ORIGINS) are read
// here in place.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { sendError } from './http-helpers.js';
import { logger } from '../logger.js';

// Security headers, CORS, and response compression — the "edge" middleware that
// must run before the billing router (which needs the raw body).
export function applyEdgeMiddleware(app) {
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
      // Google Ads tag (gtag.js): the library loads from googletagmanager.com and
      // pulls in conversion/remarketing scripts from googleadservices.com,
      // www.google.com, and the doubleclick.net ad-serving subdomains (e.g.
      // googleads.g.doubleclick.net serves the view-through-conversion script).
      // Config + loader live in public/scripts/gtag.js; the measurement beacons
      // themselves ride on imgSrc/connectSrc 'https:' below.
      'https://www.googletagmanager.com',
      'https://www.googleadservices.com',
      'https://www.google.com',
      'https://*.doubleclick.net',
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
      // Google Ads conversion-linker / remarketing cookie-sync iframes.
      'https://*.doubleclick.net',
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
}

// JSON body parsing (with its dedicated error handler) and static-asset serving
// — mounted AFTER the billing router so Stripe's webhook still sees the raw body.
export function applyBodyAndStatic(app) {
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
    if (err instanceof SyntaxError && /** @type {any} */ (err).status === 400 && 'body' in err) {
      logger.error('JSON parsing error:', err.message);
      logger.error('Request body size:', req.headers['content-length'], 'bytes');
      return sendError(res, 400, 'Invalid JSON or request too large');
    }
    if (err.type === 'entity.too.large') {
      logger.error('Request entity too large:', err.message);
      logger.error('Request body size:', req.headers['content-length'], 'bytes');
      logger.error('Limit:', err.limit, 'bytes');
      return sendError(res, 413, 'Request entity too large', { details: `limit ${err.limit} bytes` });
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
}
