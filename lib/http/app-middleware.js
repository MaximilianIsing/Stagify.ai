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
import zlib from 'node:zlib';
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
  // Brotli (preferred) or gzip for text responses (HTML/CSS/JS/JSON) — ~78% smaller
  // on the wire. Two deliberate skips:
  //   1. Server-Sent Events (text/event-stream): compressing buffers the stream
  //      and would break the AI Designer's live token-by-token responses.
  //   2. The image-generation endpoints: they return multi-MB base64 of images
  //      that are ALREADY compressed (PNG/JPEG/WebP), so we spend CPU for
  //      near-zero savings. Small JSON from every other /api route still compresses.
  const NO_COMPRESS_ROUTES = new Set([
    '/api/process-image',
    '/api/stage-by-endpoint-key',
    '/api/mask-edit',
    '/api/download-result',
  ]);
  app.use(
    compression({
      // `compression` defaults brotli to quality 4, which for our text is actually
      // WORSE than its own gzip — styles.css came out 23,292 bytes as br vs 22,136
      // as gzip. Browsers advertise and prefer br, so everyone was being served the
      // worse of the two encodings. Quality 6 is the knee of the curve, measured on
      // the homepage payload (index.html + the 5 render-blocking sheets +
      // english.json, 344 KB raw):
      //
      //   q4  83.0 KB   9.7 ms      q7  75.3 KB   36.9 ms
      //   q5  76.8 KB  15.4 ms      q8  75.0 KB   51.8 ms
      //   q6  75.9 KB  19.9 ms      q11 67.0 KB  590.7 ms
      //
      // q7+ buys under 1 KB for 17-32 ms more; q11 is unusable on the fly (only
      // reachable by precompressing to .br on disk). This compresses per request
      // with no cache, so the CPU is paid on every response — if Render's single
      // CPU shows strain, q5 keeps 6.1 of the 7.1 KB at three-quarters the cost.
      brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } },
      filter: (req, res) => {
        if (NO_COMPRESS_ROUTES.has(req.path)) return false;
        if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
        return compression.filter(req, res); // default: compressible types over threshold
      },
    })
  );
}

/**
 * The routes that legitimately receive base64 images in a JSON body.
 *
 * Keep the app-wide limit SMALL so a single oversized JSON body can't spike memory or block
 * the event loop (JSON.parse is synchronous) on ANY endpoint — that parser runs before the
 * per-route rate limiters. Only these get the large one. (Multipart image uploads go through
 * multer, not this parser.)
 *
 * EXPORTED so a route's spec can assert its own membership. Forgetting to register a new
 * image-carrying route is a silent 413 raised BEFORE the handler runs, with a message that
 * says nothing about which limit was hit — the kind of thing that is obvious once you know
 * and baffling until then.
 */
export const JSON_LARGE_LIMIT_PATHS = new Set([
  '/api/chat', // conversation history with embedded images
  '/api/mask-edit', // image + mask + optional reference image (data URLs)
  '/api/segment', // base64 image
  '/api/validate-image', // base64 image
  // The Masking Studio's finished composite, plus the original as the "before". Both are
  // canvas exports at up to 1920x1080, so ~1.6MB of base64 together — far past the small
  // parser, which would 413 the save before the handler ever ran.
  '/api/masking-studio/save',
  // Basic Mask's finished composite, posted for the "virtually staged" stamp. The one place
  // that image ever reaches the server — it is built and downloaded in the browser — so it
  // arrives at full resolution as a canvas PNG export, well past the small parser.
  '/api/stamp-image',
  // The homepage staging tool's download button/resolution menu, posting the current
  // full-resolution result for a server-side resize + re-encode (see routes/staging.js).
  // Same size class as /api/stamp-image's payload, for the same reason.
  '/api/download-result',
  // NOT /api/bug-report: it is unauthenticated and persists its body to the same
  // volume as the SQLite DB, and it stores only a COUNT of any images in the
  // conversation history — never their bytes (lib/http/bug-report-row.js reads an
  // item's type and text, never its image_url). Raw data URLs would therefore buy
  // nothing and cost everything, so the studio strips them before the POST
  // (summariseBugReportHistory in public/scripts/ai-designer-model-selector.js) and
  // this small limit is the backstop that keeps a client which does not — or an
  // attacker who will not — from buffering 25MB into an unauthenticated disk write.
]);

// JSON body parsing (with its dedicated error handler) and static-asset serving
// — mounted AFTER the billing router so Stripe's webhook still sees the raw body.
export function applyBodyAndStatic(app) {
  // STATIC FIRST, body parsing second. Every request for a .css/.webp/.woff2/.mp4 used
  // to walk the JSON body parser and the limitKey() regex below before reaching the
  // file, on a path where there is never a JSON body to parse. Static assets are the
  // majority of requests on this site, so that was per-asset work for nothing.
  //
  // Safe to reorder because express.static only ever answers for a file that actually
  // exists under public/ and calls next() otherwise — and no /api/* route has a file of
  // the same name. Everything downstream (the routers, which are mounted after this)
  // still gets its parsed body.
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

  const jsonSmall = express.json({ limit: '1mb' });
  const jsonLarge = express.json({ limit: '25mb' }); // tune to the real max payload if needed
  // Trailing slashes are stripped before the lookup. Express routes non-strictly by
  // default, so `POST /api/chat/` reaches the /api/chat handler — but req.path is
  // '/api/chat/', which is not in the set, so the request got the 1MB parser and was
  // rejected 413 before ever reaching the handler built for 25MB. The route matched
  // and the body limit did not, which is a confusing failure to debug from a 413.
  const limitKey = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  app.use((req, res, next) =>
    (JSON_LARGE_LIMIT_PATHS.has(limitKey(req.path)) ? jsonLarge : jsonSmall)(req, res, next)
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
}
