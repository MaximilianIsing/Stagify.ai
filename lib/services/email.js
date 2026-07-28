// Email helpers: registration verification send + binary email-open tracking.
// Extracted from server.js. See createEmail(deps) for injected dependencies.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Open-tracking ceilings.
//
// GET /email/logo.png is unauthenticated by construction (the caller is a mail
// client's image proxy) and its `?email=` is attacker-controlled, so a first-ever
// "open" for an arbitrary address APPENDS a row to email_open_logs.csv, rewrites
// email_opened.json whole, and adds an entry to the in-memory Map — all on the
// volume auth-store.db lives on. `emailPixelLimiter` bounds the rate per IP; these
// bound the TOTAL, so a distributed flood still cannot fill the disk out from under
// SQLite or grow the Map without limit. Same shape as BUG_REPORT_LOG_MAX_BYTES /
// bugReportLogCeiling() in lib/http/bug-report-row.js.
// ---------------------------------------------------------------------------

/** Absolute ceiling on email_open_logs.csv. A row is ~150 bytes, so ~28k opens. */
export const EMAIL_OPEN_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** Absolute ceiling on distinct tracked addresses (the Map and email_opened.json). */
export const EMAIL_OPEN_MAX_ENTRIES = 20000;

/**
 * The live byte ceiling, read per call so an operator can raise it (or a test lower
 * it) via `EMAIL_OPEN_LOG_MAX_BYTES` without a code change. A missing or nonsense
 * value falls back to the compiled default rather than disabling the backstop.
 * @returns {number} Maximum email_open_logs.csv size in bytes.
 */
export function emailOpenLogCeiling() {
  const override = Number(process.env.EMAIL_OPEN_LOG_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : EMAIL_OPEN_LOG_MAX_BYTES;
}

/**
 * The live entry ceiling, with the same override/fallback rule as
 * emailOpenLogCeiling().
 * @returns {number} Maximum number of distinct addresses ever marked as opened.
 */
export function emailOpenEntriesCeiling() {
  const override = Number(process.env.EMAIL_OPEN_MAX_ENTRIES);
  return Number.isFinite(override) && override > 0 ? override : EMAIL_OPEN_MAX_ENTRIES;
}

// The Microsoft desktop clients that fetch a message's images themselves. Matched on
// the FULL, Microsoft-qualified product token (`ms-office`, `MSOffice 16`,
// `Microsoft Outlook 16.0`) with a non-alphanumeric character either side: a bare
// `outlook` substring used to be enough, so `User-Agent: outlook` marked any address
// as opened. A user agent is self-reported either way, so this is hygiene layered on
// top of the rate limit and the ceilings above — it is not a trust boundary.
const MICROSOFT_EMAIL_CLIENT_UA =
  /(?:^|[^a-z0-9])(?:ms-?office|microsoft +(?:outlook|office))(?:[^a-z0-9]|$)/;

// ---------------------------------------------------------------------------
// Pure renderers for the auth/account emails — each returns { subject, html, text }
// and does no I/O. They are the SINGLE SOURCE for these bodies: the senders below
// build from them, and lib/services/email-catalog.js previews them on the admin
// dashboard, so a preview is always identical to what actually ships.
//
// `debugNote` is the "(intended recipient: …)" suffix appended only when
// EMAIL_DEBUG_MODE redirects mail; it is '' in production and in previews.
// ---------------------------------------------------------------------------

/**
 * @param {{ code: string, debugNote?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderRegistrationVerificationEmail({ code, debugNote = '' }) {
  return {
    subject: 'Your Stagify verification code',
    html:
      `<p>Hi,</p><p>Your Stagify verification code${debugNote} is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:0.2em;margin:16px 0">${code}</p>` +
      `<p>This code expires in 15 minutes. If you didn’t request this, you can ignore this email.</p>` +
      `<p>— Stagify</p>`,
    text: `Your Stagify verification code${debugNote}: ${code}\n\nExpires in 15 minutes. If you didn't request this, ignore this email.`,
  };
}

/**
 * @param {{ debugNote?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderAccountExistsEmail({ debugNote = '' } = {}) {
  return {
    subject: 'You already have a Stagify account',
    html:
      `<p>Hi,</p><p>Someone just tried to create a Stagify account with this email address${debugNote}, but you already have one — so we did not create a duplicate.</p>` +
      `<p>Just sign in instead. If you signed up with Google, use “Continue with Google”. Forgot your password? You can reset it from the sign-in screen.</p>` +
      `<p>If this wasn’t you, you can safely ignore this email — nothing was changed.</p>` +
      `<p>— Stagify</p>`,
    text:
      `You already have a Stagify account for this email, so we didn't create a duplicate.\n\n` +
      `Just sign in instead. If you used Google, use "Continue with Google"; otherwise you can reset your password from the sign-in screen.\n\n` +
      `If this wasn't you, you can ignore this email — nothing was changed.`,
  };
}

/**
 * @param {{ resetUrl: string, debugNote?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderPasswordResetEmail({ resetUrl, debugNote = '' }) {
  return {
    subject: 'Reset your Stagify password',
    html:
      `<p>Hi,</p><p>We received a request to reset your Stagify password${debugNote}.</p>` +
      `<p><a href="${resetUrl}">Choose a new password</a></p>` +
      `<p>This link expires in one hour. If you didn’t ask for this, you can ignore this email.</p>` +
      `<p>— Stagify</p>`,
    text: `Reset your Stagify password: ${resetUrl}\n\nExpires in one hour. If you didn't request this, ignore this email.`,
  };
}

/**
 * Confirmation that a password reset completed. This is the flow's only channel
 * back to the ACCOUNT OWNER: everything else in a reset is driven by whoever holds
 * the mailbox link, so if an attacker ran the reset, this is how the real owner
 * finds out. Hence no "if this wasn't you, ignore this" line — the other account
 * emails say that because nothing changed, whereas here something already did.
 *
 * @param {{ appUrl?: string, debugNote?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderPasswordChangedEmail({ appUrl, debugNote = '' } = {}) {
  const base = String(appUrl || 'https://stagify.ai').replace(/\/$/, '');
  return {
    subject: 'Your Stagify password was changed',
    html:
      `<p>Hi,</p><p>Your Stagify password${debugNote} was just changed, and we signed you out on every device.</p>` +
      `<p><a href="${base}/">Sign in with your new password</a></p>` +
      `<p><strong>If you didn’t do this</strong>, someone else may have access to your email account — reset your Stagify password again straight away from the sign-in screen, and check your email account’s own security settings. You can reply to this email to reach us.</p>` +
      `<p>— Stagify</p>`,
    text:
      `Your Stagify password${debugNote} was just changed, and we signed you out on every device.\n\n` +
      `Sign in with your new password: ${base}/\n\n` +
      `If you didn't do this, someone else may have access to your email account — reset your Stagify password again straight away from the sign-in screen, and check your email account's own security settings. You can reply to this email to reach us.\n\n— Stagify`,
  };
}

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

    const logFile = path.join(getDataLogDir(), 'email_open_logs.csv');

    // Ceilings, checked BEFORE anything is written. Reaching this line means
    // `email` is one we have never seen, and it came straight off an
    // unauthenticated query string — so every miss is a new CSV row, a new Map
    // entry and a full rewrite of email_opened.json. Past either ceiling tracking
    // simply stops; losing opens beats filling the volume the SQLite DB shares.
    if (emailOpenedAt.size >= emailOpenEntriesCeiling()) {
      warnOpenTrackingCeiling(`${emailOpenedAt.size} tracked addresses`);
      return;
    }
    let logBytes = 0;
    try {
      logBytes = fs.statSync(logFile).size;
    } catch { /* not created yet — counts as zero */ }
    if (logBytes >= emailOpenLogCeiling()) {
      warnOpenTrackingCeiling(`email_open_logs.csv at ${logBytes} bytes`);
      return;
    }

    const timestamp = new Date().toISOString();
    const ipAddress = req ? (req.ip || req.connection?.remoteAddress || 'unknown') : 'unknown';
    const userAgent = req ? (req.get('user-agent') || 'unknown') : 'unknown';
    const csvRow = [
      escapeCsvField(timestamp),
      escapeCsvField(email),
      escapeCsvField(ipAddress),
      escapeCsvField(userAgent),
    ].join(',') + '\n';

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

// One line per process when a ceiling first bites, so an operator sees that tracking
// went quiet without the flood that tripped it becoming its own log flood.
let openCeilingWarned = false;
function warnOpenTrackingCeiling(detail) {
  if (openCeilingWarned) return;
  openCeilingWarned = true;
  logger.warn(`[email] open tracking stopped at its ceiling (${detail}); no further opens recorded`);
}

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
  if (MICROSOFT_EMAIL_CLIENT_UA.test(s)) return true;

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

/**
 * Drop an address from the in-memory open-tracking state, so a scrub of
 * email_opened.json on disk actually holds on a running process.
 *
 * WHY THIS EXISTS: the erasure path in lib/data/user-deletion.js
 * (`scrubEmailOpened`) rewrites email_opened.json without the erased address, but
 * this factory loads that file into a Map ONCE and then rewrites the whole Map on
 * the next open by anybody. Without this call the erased address is written straight
 * back by the next stranger's pixel fetch, and the erasure only holds across a
 * restart. The seam is on the returned API rather than a module-level export because
 * the state is per-factory-instance — a bare import could not reach the live one — so
 * server.js injects this into createUserDeletion (see its `forgetEmailOpenState` dep).
 *
 * Deliberately memory-only: user-deletion.js has already rewritten the file, and a
 * second write here would race it for no gain. Both "never loaded" and "address not
 * present" are no-ops: if nothing has been loaded yet, the next load reads the
 * already-scrubbed file from disk.
 *
 * Matching is trimmed/case-insensitive, the same rule user-deletion.js applies with
 * `sameEmail` — the Map is keyed by whatever the tracker was handed, and only the
 * route path lowercases.
 *
 * @param {unknown} email - The erased address. A non-string or blank value is a no-op.
 * @returns {number} How many entries were dropped from memory (0 when there was nothing to drop).
 */
function forgetEmailOpenState(email) {
  if (typeof email !== 'string') return 0;
  const target = email.trim().toLowerCase();
  if (!target) return 0;
  // Not loaded yet → nothing cached to contradict the file, and forcing a load here
  // would only pull the scrubbed file into memory for no reason.
  if (!emailOpenedLoaded) return 0;

  let dropped = 0;
  for (const key of [...emailOpenedAt.keys()]) {
    if (String(key).trim().toLowerCase() !== target) continue;
    emailOpenedAt.delete(key);
    dropped += 1;
  }
  return dropped;
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
    ...renderRegistrationVerificationEmail({ code, debugNote }),
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

// Sent when someone tries to register an email that ALREADY has an account. The
// return shape (success body AND the 503/502 failure bodies) is deliberately kept
// byte-for-byte identical to sendRegistrationVerificationEmail so /api/auth/register
// responds the same whether or not the email is taken — a prober can't tell the two
// apart, while the real mailbox owner gets actionable guidance here. See the
// anti-enumeration note in auth-store.js#startRegistration.
async function sendAccountExistsNotice({ toEmail }) {
  if (!resend) {
    logger.error('[auth] Resend not configured; cannot send account-exists notice');
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
    ...renderAccountExistsEmail({ debugNote }),
  });

  if (sendResult.error) {
    const errMsg =
      typeof sendResult.error?.message === 'string'
        ? sendResult.error.message
        : JSON.stringify(sendResult.error);
    logger.error('[auth] Resend account-exists notice failed:', errMsg);
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
    sendAccountExistsNotice,
    logEmailOpenToFile,
    getEmailOpenedFile,
    isStrictEmailClientProxyUa,
    isConfirmedEmailClientOpen,
    loadEmailOpened,
    saveEmailOpened,
    hasEmailEverOpened,
    markEmailOpened,
    forgetEmailOpenState,
  };
}
