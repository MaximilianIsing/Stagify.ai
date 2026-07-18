// public routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { escapeCsvField } from '../lib/http/csv-escape.js';
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
    
    // Use mounted disk on Render, project data folder locally
    let logDir;
    
    if (process.env.RENDER && fs.existsSync('/data')) {
      // Use Render's mounted disk
      logDir = '/data';
      if (DEBUG_MODE) {
        logger.debug('Using Render persistent disk for contact logs');
      }
    } else {
      // Use project data folder for local development
      logDir = path.join(__dirname, 'data');
      
      // Create data directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
          if (DEBUG_MODE) {
            logger.debug('Created local data directory successfully');
          }
        } catch {
          if (DEBUG_MODE) {
            logger.debug('Error: Cannot create data directory, using project root');
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

    if (DEBUG_MODE) {
      logger.debug('Email sent successfully:', result);
    }

    res.json({ 
      success: true, 
      message: 'Email sent successfully',
      id: result.id 
    });
  } catch (error) {
    logger.error('Error sending email:', error);
    sendError(res, 500, 'Failed to send email', { details: error.message || 'An error occurred while sending the email' });
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
    const { description, steps, email, userId, userAgent, url, timestamp, conversationHistory } = req.body;
    
    if (!description || !description.trim()) {
      return sendError(res, 400, 'Bug description is required');
    }
    
    const reportTimestamp = timestamp || new Date().toISOString();
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    
    // Format conversation history as a readable string (single line for CSV)
    let conversationLog = '';
    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      const formattedMessages = conversationHistory.map((msg, index) => {
        let content;
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
      escapeCsvField(reportTimestamp),
      escapeCsvField(description),
      escapeCsvField(steps || ''),
      escapeCsvField(email || ''),
      escapeCsvField(userId || 'unknown'),
      escapeCsvField(userAgent || 'unknown'),
      escapeCsvField(url || 'unknown'),
      escapeCsvField(ipAddress),
      escapeCsvField(conversationLog)
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
        } catch {
          logger.info('Error: Cannot create data directory, using project root');
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
          logger.error('Error writing to bug report log:', err);
        }
      });
    }
    
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
