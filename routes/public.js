// Public routes.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { escapeCsvField } from '../lib/http/csv-escape.js';
import { buildBugReportRow, BUG_REPORT_HEADER, bugReportLogCeiling } from '../lib/http/bug-report-row.js';
import { appendCsvRow } from '../lib/services/csv-append.js';
import { resolveDataDir } from '../lib/data/data-dir.js';
import { createStatsHandler, statsFromDeps } from '../lib/http/stats-endpoint.js';
import { emailPixelLimiter as defaultEmailPixelLimiter, EMAIL_PIXEL_RATE_LIMITED } from '../lib/http/rate-limiters.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../lib/logger.js';
import { statusPayload } from '../lib/health/service-health.js';
import { errorMessage } from '../lib/errors.js';

/**
 * Build the public router (static pages, robots/sitemap, hosted-image serving,
 * health/status, prompt/contact counts, contact + bug-report + email endpoints).
 * `deps` is the injection bag from server.js.
 *
 * @param {{
 *   authStore: any,
 *   uptimeMonitor: any,
 *   serviceHealth?: ReturnType<typeof import('../lib/health/service-health.js').createServiceHealth> | null,
 *   resend: any,
 *   LOGS_ACCESS_KEY: string,
 *   endpointKeyMatches: (received: string, expected: string) => boolean,
 *   emailLimiter: import('express').RequestHandler,
 *   emailPixelLimiter?: import('express').RequestHandler,
 *   RESEND_FROM_EMAIL: string,
 *   DEBUG_MODE: boolean,
 *   EMAIL_DEBUG_MODE: boolean,
 *   DEBUG_EMAIL: string,
 *   STATS_DEBUG: boolean,
 *   DEBUG_ROOMS: number,
 *   DEBUG_USERS: number,
 *   hostedImages: import('../lib/types/deps.js').HostedImagesDeps,
 *   email: import('../lib/types/deps.js').EmailDeps,
 *   healthHandler: import('express').RequestHandler,
 *   getPromptCount: typeof import('../lib/data/counters.js').getPromptCount,
 *   getContactCount: typeof import('../lib/data/counters.js').getContactCount,
 *   incContactCount: typeof import('../lib/data/counters.js').incContactCount,
 *   blogViews?: ReturnType<typeof import('../lib/data/blog-views.js').createBlogViews>,
 *   emailOptOut?: ReturnType<typeof import('../lib/data/email-optout.js').createEmailOptOut>,
 *   readPublicStats?: (() => import('../lib/data/public-stats.js').PublicStats) | null,
 *   __dirname: string,
 * }} deps - Stores, injected email client, the email rate-limit + health-check
 *   middleware, debug/stat flags, and hosted-image / logging / counter helpers.
 *   `emailPixelLimiter` is a test seam only: omitted (or null) it falls back to the
 *   shared `emailPixelLimiter`, so the open-tracking pixel is never mounted unlimited.
 *   `blogViews` is OPTIONAL: absent, the articles are served exactly as before and
 *   simply go uncounted, so the router still mounts without the store. `emailOptOut`
 *   is optional on the same terms: without it the unsubscribe route still answers,
 *   and answers honestly, by telling the reader to email us instead. `serviceHealth`
 *   is optional too: absent, /api/status answers with exactly the payload it always
 *   did, so a spec that stubs the uptime monitor alone still passes. `readPublicStats`
 *   is the shared usage-figure reader server.js builds; without it the three stat
 *   endpoints fall back to the same arithmetic over the counters injected above.
 */
export default function createPublicRouter(deps) {
  const { authStore, readPublicStats = null, uptimeMonitor, serviceHealth, resend, LOGS_ACCESS_KEY, endpointKeyMatches, emailLimiter, emailPixelLimiter, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, hostedImages, email: emailService, healthHandler, getPromptCount, getContactCount, incContactCount , blogViews, emailOptOut, __dirname } = deps;
  const router = createAsyncRouter();
  const pixelLimiter = emailPixelLimiter ?? defaultEmailPixelLimiter;

  /**
   * Send a public document with the same cache policy express.static gives the very
   * same file when it is reached by its own URL.
   *
   * These routes bypass the `setHeaders` callback in lib/http/app-middleware.js
   * entirely — that hook only runs for files express.static itself serves — so they
   * fell back to res.sendFile's default, `Cache-Control: public, max-age=0`. The
   * practical difference from the documented `no-cache` policy is small but real: a
   * shared/edge cache may serve max-age=0 without revalidating in some conditions,
   * and `/` is the homepage. Setting it explicitly also means docs/reference/caching.md
   * describes what actually ships for every HTML response, not just most of them.
   *
   * @param {import('express').Response} res
   * @param {string} file Absolute path to the document.
   */
  const sendPage = (res, file) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  };

  /**
   * Send a blog article, counting the open on the way past.
   *
   * The count happens HERE rather than in a script inside the article because
   * these pages are static HTML that runs no analytics of its own: the route is
   * the only place every reader passes through, including the ones a beacon
   * would miss (reader modes, content blockers, clients that never run the
   * script). lib/data/blog-views.js explains what is and isn't recorded — no IP,
   * no stored user-agent, referrer reduced to host + path.
   *
   * `recordView` never throws and the article is sent regardless: a counter must
   * not be able to cost a reader their page.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} slug Article slug, which is also its file name in public/blog/.
   */
  const sendPost = (req, res, slug) => {
    try {
      if (blogViews) {
        blogViews.recordView({ slug, referer: req.get('referer'), userAgent: req.get('user-agent') });
      }
    } catch (err) {
      // The store swallows its own write errors; this catches the ones it cannot
      // (an unopenable database at construction, a store injected half-built).
      // Belt and braces on purpose: the article is what the reader came for.
      logger.error('[blog] could not count a view of', slug, '-', errorMessage(err));
    }
    sendPage(res, path.join(__dirname, 'public', 'blog', slug + '.html'));
  };

router.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  sendPage(res, path.join(__dirname, 'public', 'robots.txt'));
});

// RFC 9116. Served from public/well-known/ rather than public/.well-known/ because
// express.static ignores dot-directories, so a file under the real name would 404 —
// the route is what puts it at the standard path. Reachable without credentials on
// purpose: a stranger who found a bug should not have to find a person first.
router.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain');
  sendPage(res, path.join(__dirname, 'public', 'well-known', 'security.txt'));
});

router.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  sendPage(res, path.join(__dirname, 'public', 'sitemap.xml'));
});

router.get('/', (req, res) => {
  sendPage(res, path.join(__dirname, 'public', 'index.html'));
});

// The entity hub. It gets the extensionless alias the other reference pages have because
// it is the URL that ends up cited — in a "not affiliated with" line, in a profile bio,
// in an answer engine's source list — and /about reads as a company, /about.html as a
// file. The .html URL stays canonical; this is an alias, not a second page.
router.get('/about', (req, res) => {
  sendPage(res, path.join(__dirname, 'public', 'about.html'));
});

// AI-crawler summary (llms.txt), generated by scripts/build-i18n-seo.js from lib/seo/llms-txt.js.
//
// In practice express.static answers this URL first — it is mounted well ahead of this
// router (server.js) and the file exists on disk — so this handler is a fallback, not the
// live path. It stays for the explicit charset and because the cache policy should not
// depend on which of the two wins; `.txt` is now in the no-cache branch of
// lib/http/app-middleware.js, so both agree. Same for /robots.txt and /sitemap.xml above.
router.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8');
  sendPage(res, path.join(__dirname, 'public', 'llms.txt'));
});

router.get('/privacy', (req, res) => {
  sendPage(res, path.join(__dirname, 'public', 'privacy.html'));
});

router.get('/status', (req, res) => {
  sendPage(res, path.join(__dirname, 'public', 'status.html'));
});

// The blog hub is served as a static directory index at /blog/ (public/blog/index.html);
// express.static (mounted ahead of this router) 301-redirects /blog → /blog/. Individual
// articles have no matching file/dir, so they fall through to these clean, extensionless routes.
router.get('/blog/is-virtual-staging-allowed-on-the-mls', (req, res) => sendPost(req, res, 'is-virtual-staging-allowed-on-the-mls'));
router.get('/blog/masking-studio-and-ai-designer', (req, res) => sendPost(req, res, 'masking-studio-and-ai-designer'));
router.get('/blog/does-virtual-staging-help-sell-homes', (req, res) => sendPost(req, res, 'does-virtual-staging-help-sell-homes'));
router.get('/blog/stagify-vs-other-virtual-staging-tools', (req, res) => sendPost(req, res, 'stagify-vs-other-virtual-staging-tools'));
router.get('/blog/top-10-ai-virtual-staging-sites-2026', (req, res) => sendPost(req, res, 'top-10-ai-virtual-staging-sites-2026'));
router.get('/blog/dorm-room-design-ai-college-freshmen', (req, res) => sendPost(req, res, 'dorm-room-design-ai-college-freshmen'));
router.get('/blog/prepare-your-listing-for-the-fall-market', (req, res) => sendPost(req, res, 'prepare-your-listing-for-the-fall-market'));
router.get('/blog/curb-appeal-real-estate-photos', (req, res) => sendPost(req, res, 'curb-appeal-real-estate-photos'));
router.get('/blog/free-virtual-staging', (req, res) => sendPost(req, res, 'free-virtual-staging'));
router.get('/blog/virtual-staging-disclosure-laws-by-state', (req, res) => sendPost(req, res, 'virtual-staging-disclosure-laws-by-state'));
router.get('/blog/fsbo-listing-photos', (req, res) => sendPost(req, res, 'fsbo-listing-photos'));
router.get('/blog/new-construction-listing-photos', (req, res) => sendPost(req, res, 'new-construction-listing-photos'));
router.get('/blog/virtual-staging-api', (req, res) => sendPost(req, res, 'virtual-staging-api'));
router.get('/blog/home-staging-cost', (req, res) => sendPost(req, res, 'home-staging-cost'));
router.get('/blog/remove-furniture-from-listing-photos', (req, res) => sendPost(req, res, 'remove-furniture-from-listing-photos'));
router.get('/blog/which-virtual-staging-style', (req, res) => sendPost(req, res, 'which-virtual-staging-style'));
router.get('/blog/virtual-staging-before-and-after', (req, res) => sendPost(req, res, 'virtual-staging-before-and-after'));

router.get('/bimi-logo.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'bimi-logo.svg'));
});

// NOTE: there is deliberately no `/logo-full.png` route. The file used to be
// `public/Logo Full.png`, whose space made the clean URL impossible to serve
// statically, so a hand-written route mapped one to the other. Now that it is
// `public/logo-full.png`, express.static (mounted in applyBodyAndStatic, well
// ahead of this router) answers the URL directly — and better, since it adds the
// immutable cache header and an ETag the old route omitted. A route here would
// simply be unreachable.

router.get('/i/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const entry = /** @type {import('../lib/types/image.js').HostedImageEntry[]} */ (hostedImages.readHostedImagesManifest()).find((e) => e && e.id === id);
  if (!entry) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const filePath = path.join(hostedImages.getHostedImagesDir(), entry.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.setHeader('Content-Type', entry.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  return res.sendFile(path.resolve(filePath));
});

/**
 * Escape text for interpolation into the unsubscribe page below.
 *
 * The page echoes the address the token resolved to, which is the only way a reader
 * can tell WHICH of their addresses they just unsubscribed. That address came out of
 * our own database rather than the request, but it was attacker-chosen at signup, so
 * it is escaped like any other untrusted string. The site's CSP carries no
 * 'unsafe-inline', so an injected <script> would not execute either — this is the
 * belt to that brace.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The unsubscribe confirmation page. Deliberately a self-contained document with no
 * stylesheet and no script: it is opened from a mail client, often in an in-app
 * browser with its own rules, and it has exactly one job.
 *
 * @param {{ title: string, body: string }} a
 * @returns {string}
 */
function unsubscribePage({ title, body }) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow">'
    + `<title>${escapeHtml(title)} - Stagify.ai</title></head>`
    + '<body style="margin:0;padding:48px 20px;background:#f4f6fb;'
    + 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2733">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e9f0;'
    + 'border-radius:14px;padding:28px">'
    + `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>`
    + body
    + '<p style="margin:20px 0 0;font-size:13px;color:#8a93a6">'
    + '<a href="/" style="color:#2563eb;text-decoration:none">stagify.ai</a></p>'
    + '</div></body></html>';
}

// Email open-tracking pixel. Unauthenticated by construction — the caller is a mail
// client's image proxy, not a browser — and `?email=` is attacker-controlled, so a
// first-ever open APPENDS a row to email_open_logs.csv and rewrites email_opened.json,
// both on the volume auth-store.db lives on. `pixelLimiter` bounds those writes per IP
// and lib/services/email.js bounds their total. Past the limit the image is still sent
// — it is the full logo PNG, so a 429 would render as a broken image — and only the
// write is dropped, which is why the flag is read here rather than the limiter 429ing.
router.get('/email/logo.png', pixelLimiter, (req, res) => {
  const rawEmail = req.query.email;
  if (typeof rawEmail === 'string' && !res.locals[EMAIL_PIXEL_RATE_LIMITED]) {
    // NOT decoded again here. Express's qs parser has already percent-decoded the
    // value, and on a malformed escape it hands back the raw string rather than
    // throwing — so `?email=100%` arrived as the literal '100%' and a second
    // decodeURIComponent threw URIError, turning this into a 500. That breaks the
    // one promise this route makes (always serve the PNG: a mail client renders
    // the failure as a broken image) and filed a Sentry event per open. Decoding
    // twice was also wrong on its own: '%2540' collapsed to '@', so a single
    // address could be tracked under several encodings.
    const email = rawEmail.trim().toLowerCase();
    if (email.includes('@') && email.length <= 254 && emailService.isConfirmedEmailClientOpen(req)) {
      emailService.logEmailOpenToFile(email, req);
    }
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'logo-full.png'));
});

// Unsubscribe from the trial-lifecycle emails.
//
// UNAUTHENTICATED BY CONSTRUCTION, for the same reason the pixel above is: the
// person clicking has a mail client and a token, not a session. Making someone sign
// in to stop receiving email is the dark pattern the rules on this exist to prevent,
// and privacy.html §3.6 promises a link in the email, not a login.
//
// THE TOKEN IS THE WHOLE CREDENTIAL, and it is worth being plain about what it can
// do: stop mail to one address, and be undone from the same page. It opens no
// account and reveals nothing beyond the address it already belongs to.
//
// AN UNKNOWN OR MISSING TOKEN IS NOT AN ERROR PAGE. Mail clients rewrite and
// truncate links, and erasure deletes the row outright, so a dead token is an
// ordinary outcome. The reader's actual problem — "stop emailing me" — is
// answerable either way, so they get the address to write to instead of a 404.
//
// Rate-limited with the shared email limiter, because it is an unauthenticated
// write path onto the same volume as everything else.
const UNSUB_HELP = '<p style="margin:0;font-size:15px;line-height:1.6">Email '
  + '<a href="mailto:team@stagify.ai" style="color:#2563eb;text-decoration:none">team@stagify.ai</a> '
  + 'and we will remove you by hand. Account emails such as password resets are not '
  + 'affected either way.</p>';

/**
 * Apply an unsubscribe (or a resubscribe) and render the outcome.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'out' | 'in'} direction
 */
function handleUnsubscribe(req, res, direction) {
  res.setHeader('Cache-Control', 'no-store');
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const apply = direction === 'out' ? emailOptOut?.optOutByToken : emailOptOut?.optInByToken;
  const result = token && apply ? apply(token) : { ok: false };

  if (!result.ok) {
    res.status(200).type('html').send(unsubscribePage({
      title: 'We could not read that link',
      body: '<p style="margin:0 0 12px;font-size:15px;line-height:1.6">That unsubscribe link '
        + 'was missing or is no longer valid — some mail clients shorten links, and we '
        + 'remove the record entirely when an account is deleted.</p>' + UNSUB_HELP,
    }));
    return;
  }

  const addr = escapeHtml(result.email ?? '');
  if (direction === 'out') {
    res.status(200).type('html').send(unsubscribePage({
      title: 'You are unsubscribed',
      body: '<p style="margin:0 0 12px;font-size:15px;line-height:1.6">We will not send any '
        + `more trial or onboarding emails to <strong>${addr}</strong>.</p>`
        + '<p style="margin:0 0 12px;font-size:15px;line-height:1.6">This does not cancel a '
        + 'subscription, and it does not stop account emails such as password resets and '
        + 'billing notices — those are not marketing and cannot be switched off.</p>'
        + '<p style="margin:0;font-size:15px;line-height:1.6">Clicked this by mistake? '
        + `<a href="/email/resubscribe?t=${encodeURIComponent(token)}" `
        + 'style="color:#2563eb;text-decoration:none">Turn these emails back on</a>.</p>',
    }));
    return;
  }

  res.status(200).type('html').send(unsubscribePage({
    title: 'You are subscribed again',
    body: '<p style="margin:0;font-size:15px;line-height:1.6">Trial and onboarding emails to '
      + `<strong>${addr}</strong> are switched back on. You can unsubscribe again from the `
      + 'footer of any of them.</p>',
  }));
}

router.get('/email/unsubscribe', emailLimiter, (req, res) => handleUnsubscribe(req, res, 'out'));
router.get('/email/resubscribe', emailLimiter, (req, res) => handleUnsubscribe(req, res, 'in'));

// RFC 8058 one-click. Gmail and Yahoo POST here from their own native "Unsubscribe"
// control without ever loading the page, and expect a 2xx. The handler is shared, so
// the POST and the click cannot drift apart.
router.post('/email/unsubscribe', emailLimiter, (req, res) => handleUnsubscribe(req, res, 'out'));

// Unauthenticated, and it writes to the same volume auth-store.db lives on — the
// same threat model /api/bug-report documents in lib/http/bug-report-row.js, which
// this endpoint was missing entirely. It had NO per-field cap and NO file ceiling,
// while emailLimiter allows 6 requests / 15 min / IP against a 1 MB JSON parser: a
// few IPs could fill the disk and take SQLite (auth, sessions, memories) down with
// it. Fields are clamped here and the file carries the same absolute backstop.
const CONTACT_LOG_HEADER = 'timestamp,userRole,referralSource,email,userAgent,ipAddress';
// Generous enough that a real submission is never clipped, small enough that abuse
// is bounded to a few KB per request rather than a megabyte.
const CONTACT_LIMITS = { userRole: 64, referralSource: 128, email: 320, userAgent: 512 };
/** @param {unknown} value @param {number} max @returns {string} */
const clampContactField = (value, max) => {
  const str = String(value ?? '');
  return str.length <= max ? str : str.slice(0, max) + ' [truncated]';
};

router.post('/api/log-contact', emailLimiter, (req, res) => {
  try {
    const { userRole = 'unknown', referralSource = 'unknown', email = 'unknown', userAgent = 'unknown' } = req.body;
    const timestamp = new Date().toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';

    // Create CSV row. Every field is run through escapeCsvField so attacker-supplied
    // values (userRole/referralSource/email/userAgent) can neither break out of their
    // column via an embedded quote/comma nor smuggle a spreadsheet formula (=,+,-,@),
    // and is clamped first so no single field can be megabytes long.
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(clampContactField(userRole, CONTACT_LIMITS.userRole)),
      escapeCsvField(clampContactField(referralSource, CONTACT_LIMITS.referralSource)),
      escapeCsvField(clampContactField(email, CONTACT_LIMITS.email)),
      escapeCsvField(clampContactField(userAgent, CONTACT_LIMITS.userAgent)),
      escapeCsvField(ipAddress),
    ].join(',') + '\n';

    const logFile = path.join(resolveDataDir(__dirname), 'contact_logs.csv');

    // Second, absolute ceiling — the same backstop /api/bug-report uses, for the
    // same reason: past this size stop appending rather than eat the volume.
    let existingSize = 0;
    try {
      existingSize = fs.statSync(logFile).size;
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
    }
    const ceiling = bugReportLogCeiling();
    if (existingSize >= ceiling) {
      logger.error(
        `Contact log dropped: ${logFile} is at its ${ceiling}-byte ceiling (${existingSize} bytes). Rotate or archive it.`
      );
      return sendError(res, 503, 'Contact logging is temporarily unavailable');
    }

    appendCsvRow(logFile, CONTACT_LOG_HEADER, csvRow, 'contact log');

    // Increment contact count
    incContactCount();

    return res.json({ success: true, message: 'Contact logged successfully' });
  } catch (error) {
    logger.error('Error in contact logging:', error);
    return sendError(res, 500, 'Failed to log contact');
  }
});

router.post('/api/send-email', emailLimiter, async (req, res) => {
  try {
    // Check access key
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 500, 'Server configuration error', { details: 'Endpoint access key not configured' });
    }

    // Require the endpoint key in a header (never ?key= or the body — a key in the
    // URL leaks via access logs, reverse-proxy logs, browser history, and Referer)
    // and compare it in constant time, mirroring protectLogs / stagingEndpointKeyGuard.
    const accessKey = (req.get('X-Stagify-Endpoint-Key') || '').trim();
    if (!accessKey || !endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
      return sendError(res, 403, 'Access denied', {
        details: 'Valid access key required in the X-Stagify-Endpoint-Key header',
      });
    }

    // Check if Resend is initialized
    if (!resend) {
      return sendError(res, 500, 'Email service not configured', {
        details: 'Resend API key not found. Please set the RESEND_API_KEY environment variable.',
      });
    }

    const { to, subject, text } = req.body;

    // Validate required fields
    if (!to || !subject || !text) {
      return sendError(res, 400, 'Missing required fields', { details: 'All fields "to", "subject", and "text" are required' });
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

    // Resend resolves — it does NOT throw — on a rejected send, returning
    // { data: null, error }. Without this check a bounce, a suppressed address or
    // a bad `from` would report success. Mirrors sendRegistrationVerificationEmail
    // in lib/services/email.js.
    if (result.error) {
      const errMsg =
        typeof result.error?.message === 'string' ? result.error.message : JSON.stringify(result.error);
      // The upstream text is an operator diagnostic, not a caller-facing one: it
      // carries Resend's own prose about our account, domains and suppression list.
      return sendError(res, 502, 'Failed to send email', {
        ref: reportError('public.send-email.upstream', new Error(errMsg)),
      });
    }

    if (DEBUG_MODE) {
      logger.debug('Email sent successfully:', result);
    }

    res.json({
      success: true,
      message: 'Email sent successfully',
      // The id lives under `data` in the Resend v6 response shape; `result.id` is
      // always undefined.
      id: result.data?.id,
    });
  } catch (error) {
    sendError(res, 500, 'Failed to send email', { ref: reportError('public.send-email', error) });
  }
});

router.get('/health', healthHandler);

router.get('/api/health', healthHandler);

// statusPayload is synchronous and never probes — this endpoint is polled by every
// visitor to /status on a 60-second timer, and a burst of readers must not become a
// burst of HEADs against R2. `includeDetail` is false: `detail` can carry an R2 error
// body or a SQLite message, which is infrastructure a public page must not leak.
router.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(statusPayload(uptimeMonitor.getSnapshot(), serviceHealth));
});

// The three public-usage endpoints, all reading ONE reader so the figures in the HTML,
// in llms.txt and in the JSON can never disagree (lib/data/public-stats.js owns the
// arithmetic and the STATS_DEBUG overrides). The response SHAPES below are unchanged:
// public/scripts/app/hero-stats.js and the Playwright stubs depend on them, including
// contact-count's debug branch returning usersServed alone.
const statsDeps = { authStore, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getPromptCount, getContactCount };
const readStats = readPublicStats ?? statsFromDeps(statsDeps);

router.get('/api/prompt-count', (req, res) => res.json({ promptCount: readStats().roomsStaged }));

router.get('/api/contact-count', (req, res) => {
  const { usersServed } = readStats();
  if (STATS_DEBUG && Number.isFinite(DEBUG_USERS)) return res.json({ usersServed });
  res.json({ contactCount: getContactCount(), userCount: authStore.getUserCount(), usersServed });
});

// The canonical, self-describing figures — what llms.txt points an answer engine at, and
// what the served HTML is injected from. Handler in lib/http/stats-endpoint.js.
router.get('/api/stats', createStatsHandler(readStats));

router.post('/api/bug-report', emailLimiter, async (req, res) => {
  try {
    const { description, userId } = req.body || {};

    if (typeof description !== 'string' || !description.trim()) {
      return sendError(res, 400, 'Bug description is required');
    }

    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

    // Every field is clamped by the row builder: this endpoint is unauthenticated and
    // writes to the same volume as auth-store.db, so an unbounded row is a disk-fill
    // vector that takes SQLite down with it. See lib/http/bug-report-row.js.
    const csvRow = buildBugReportRow(req.body, ipAddress);

    const logFile = path.join(resolveDataDir(__dirname), 'bug_reports.csv');

    // Second, absolute ceiling: past it, stop appending rather than eat the volume
    // the SQLite DB shares. A missing file just means this is the first report.
    let fileExists = true;
    let existingSize = 0;
    try {
      existingSize = fs.statSync(logFile).size;
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
      fileExists = false;
    }

    const ceiling = bugReportLogCeiling();
    if (existingSize >= ceiling) {
      logger.error(
        `Bug report dropped: ${logFile} is at its ${ceiling}-byte ceiling (${existingSize} bytes). Rotate or archive it.`
      );
      return sendError(res, 503, 'Bug reporting is temporarily unavailable');
    }

    // appendFile creates the file when it is missing, so the header and the first row
    // go out in the same write — no exists-then-write race.
    fs.appendFile(logFile, fileExists ? csvRow : BUG_REPORT_HEADER + csvRow, (err) => {
      if (err) {
        logger.error('Error writing to bug report log:', err);
      }
    });

    if (DEBUG_MODE) {
      logger.debug(`✓ Bug report submitted by user: ${userId || 'unknown'}`);
    }
    
    return res.json({ success: true, message: 'Bug report submitted successfully' });
  } catch (error) {
    logger.error('Error processing bug report:', error);
    return sendError(res, 500, 'Failed to submit bug report');
  }
});

  return router;
}
