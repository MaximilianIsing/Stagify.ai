// public routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { escapeCsvField } from '../lib/http/csv-escape.js';
import { buildBugReportRow, BUG_REPORT_HEADER, bugReportLogCeiling } from '../lib/http/bug-report-row.js';
import { resolveDataDir } from '../lib/data/data-dir.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../lib/logger.js';

/**
 * Build the public router (static pages, robots/sitemap, hosted-image serving,
 * health/status, prompt/contact counts, contact + bug-report + email endpoints).
 * `deps` is the injection bag from server.js.
 *
 * @param {{
 *   authStore: any,
 *   uptimeMonitor: any,
 *   resend: any,
 *   LOGS_ACCESS_KEY: string,
 *   endpointKeyMatches: (received: string, expected: string) => boolean,
 *   emailLimiter: import('express').RequestHandler,
 *   RESEND_FROM_EMAIL: string,
 *   DEBUG_MODE: boolean,
 *   EMAIL_DEBUG_MODE: boolean,
 *   DEBUG_EMAIL: string,
 *   STATS_DEBUG: boolean,
 *   DEBUG_ROOMS: number,
 *   DEBUG_USERS: number,
 *   getHostedImagesDir: Function,
 *   readHostedImagesManifest: Function,
 *   logEmailOpenToFile: Function,
 *   isConfirmedEmailClientOpen: Function,
 *   healthHandler: import('express').RequestHandler,
 *   getPromptCount: typeof import('../lib/data/counters.js').getPromptCount,
 *   getContactCount: typeof import('../lib/data/counters.js').getContactCount,
 *   incContactCount: typeof import('../lib/data/counters.js').incContactCount,
 *   __dirname: string,
 * }} deps - Stores, injected email client, the email rate-limit + health-check
 *   middleware, debug/stat flags, and hosted-image / logging / counter helpers.
 */
export default function createPublicRouter(deps) {
  const { authStore, uptimeMonitor, resend, LOGS_ACCESS_KEY, endpointKeyMatches, emailLimiter, RESEND_FROM_EMAIL, DEBUG_MODE, EMAIL_DEBUG_MODE, DEBUG_EMAIL, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getHostedImagesDir, readHostedImagesManifest, logEmailOpenToFile, isConfirmedEmailClientOpen, healthHandler, getPromptCount, getContactCount, incContactCount , __dirname } = deps;
  const router = createAsyncRouter();

router.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

router.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

router.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

router.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// The blog hub is served as a static directory index at /blog/ (public/blog/index.html);
// express.static (mounted ahead of this router) 301-redirects /blog → /blog/. Individual
// articles have no matching file/dir, so they fall through to these clean, extensionless routes.
router.get('/blog/is-virtual-staging-allowed-on-the-mls', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'is-virtual-staging-allowed-on-the-mls.html'));
});

router.get('/blog/masking-studio-and-ai-designer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'masking-studio-and-ai-designer.html'));
});

router.get('/blog/does-virtual-staging-help-sell-homes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'does-virtual-staging-help-sell-homes.html'));
});

router.get('/blog/stagify-vs-other-virtual-staging-tools', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'stagify-vs-other-virtual-staging-tools.html'));
});

router.get('/blog/top-10-ai-virtual-staging-sites-2026', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'top-10-ai-virtual-staging-sites-2026.html'));
});

router.get('/blog/dorm-room-design-ai-college-freshmen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'dorm-room-design-ai-college-freshmen.html'));
});

router.get('/bimi-logo.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'bimi-logo.svg'));
});

router.get('/logo-full.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(__dirname, 'public', 'Logo Full.png'));
});

router.get('/i/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const entry = readHostedImagesManifest().find((e) => e && e.id === id);
  if (!entry) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const filePath = path.join(getHostedImagesDir(), entry.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.setHeader('Content-Type', entry.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  return res.sendFile(path.resolve(filePath));
});

router.get('/email/logo.png', (req, res) => {
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

router.post('/api/log-contact', emailLimiter, (req, res) => {
  try {
    const { userRole = 'unknown', referralSource = 'unknown', email = 'unknown', userAgent = 'unknown' } = req.body;
    const timestamp = new Date().toISOString();
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';

    // Create CSV row. Every field is run through escapeCsvField so attacker-supplied
    // values (userRole/referralSource/email/userAgent) can neither break out of their
    // column via an embedded quote/comma nor smuggle a spreadsheet formula (=,+,-,@).
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(userRole),
      escapeCsvField(referralSource),
      escapeCsvField(email),
      escapeCsvField(userAgent),
      escapeCsvField(ipAddress),
    ].join(',') + '\n';
    
    const logFile = path.join(resolveDataDir(__dirname), 'contact_logs.csv');
    
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
          logger.error('Error writing to contact log:', err);
        }
      });
    }
    
    // Increment contact count
    incContactCount();
    
    res.json({ success: true, message: 'Contact logged successfully' });
  } catch (error) {
    logger.error('Error in contact logging:', error);
    sendError(res, 500, 'Failed to log contact');
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
        details: 'Resend API key not found. Please set RESEND_API_KEY environment variable or create resendkey.txt file',
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

router.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(uptimeMonitor.getSnapshot());
});

router.get('/api/prompt-count', (req, res) => {
  if (STATS_DEBUG && Number.isFinite(DEBUG_ROOMS)) {
    return res.json({ promptCount: DEBUG_ROOMS });
  }
  res.json({
    promptCount: getPromptCount()
  });
});

router.get('/api/contact-count', (req, res) => {
  if (STATS_DEBUG && Number.isFinite(DEBUG_USERS)) {
    return res.json({ usersServed: DEBUG_USERS });
  }
  const userCount = authStore.getUserCount();
  res.json({
    contactCount: getContactCount(),
    userCount,
    usersServed: getContactCount() + userCount,
  });
});

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
