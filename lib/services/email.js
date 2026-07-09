// Email helpers: registration verification send + binary email-open tracking.
// Extracted from server.js. See createEmail(deps) for injected dependencies.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

export function createEmail(deps) {
  const {
    resend,
    RESEND_FROM_EMAIL,
    EMAIL_DEBUG_MODE,
    DEBUG_EMAIL,
    escapeCsvField,
    getDataLogDir,
  } = deps;

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
        if (err) logger.error('Error writing to email open log:', err);
      });
    }
    markEmailOpened(email, timestamp);
  } catch (error) {
    logger.error('Error in logEmailOpenToFile:', error);
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
    logger.error('Error loading email opened cache:', error);
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
    logger.error('Error saving email opened cache:', error);
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

async function sendRegistrationVerificationEmail({ toEmail, code }) {
  if (!resend) {
    logger.error('[auth] Resend not configured; cannot send registration verification email');
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
    logger.error('[auth] Resend registration verification failed:', errMsg);
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

  return {
    sendRegistrationVerificationEmail,
    logEmailOpenToFile,
    getEmailOpenedFile,
    isStrictEmailClientProxyUa,
    isConfirmedEmailClientOpen,
    loadEmailOpened,
    saveEmailOpened,
    hasEmailEverOpened,
    markEmailOpened,
  };
}
