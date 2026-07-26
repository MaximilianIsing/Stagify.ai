// Trial-lifecycle emails — the onboarding/retention sequence that runs while (and
// just after) a Stagify+ free trial. These are DELIBERATELY separate from
// lib/services/email.js (which owns the auth/verification mail): this file owns
// nothing but the trial funnel, so the two never entangle.
//
// Five templates, keyed by the trigger that fires them (see trial-lifecycle.js):
//   welcome   — trial started (Stripe checkout.session.completed)
//   activation— sweep: signed up, hasn't staged anything yet (~day 1-4)
//   value     — sweep: is staging, show the Stagify+-only power features (~day 3-5)
//   ending    — trial ends soon (Stripe customer.subscription.trial_will_end)
//   canceled  — subscription ended (Stripe customer.subscription.deleted)
//
// Every sender mirrors email.js: it no-ops safely when Resend is unconfigured,
// honours EMAIL_DEBUG_MODE (redirect all mail to DEBUG_EMAIL), and returns a
// { ok } shape so the caller can decide whether to mark the email as sent. It
// NEVER throws — a mail outage must not break a Stripe webhook or the sweep.

import { logger } from '../logger.js';

const BRAND = '#2563eb';

/**
 * Wrap body HTML in a minimal, email-client-safe shell (inline styles only).
 * @param {string} innerHtml - The pre-built inner HTML for this email.
 * @param {string} appUrl - Absolute site origin (no trailing slash) for footer links.
 * @returns {string} A full HTML document string.
 */
function shell(innerHtml, appUrl) {
  return (
    `<div style="margin:0;padding:24px 0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2733">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e9f0">` +
    `<div style="padding:22px 28px 0 28px">` +
    `<span style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#111827">Stagify<span style="color:${BRAND}">+</span></span>` +
    `</div>` +
    `<div style="padding:8px 28px 26px 28px;font-size:15px;line-height:1.6">${innerHtml}</div>` +
    `<div style="padding:16px 28px;border-top:1px solid #eef1f6;font-size:12px;line-height:1.5;color:#8a93a6">` +
    `You're receiving this because you started a Stagify+ free trial. ` +
    `Manage or cancel anytime from <a href="${appUrl}/stagify-plus.html" style="color:${BRAND};text-decoration:none">your plan page</a>.` +
    `</div></div></div>`
  );
}

/**
 * Primary call-to-action button as an email-safe inline-styled anchor.
 * @param {string} href - Destination URL.
 * @param {string} label - Button text.
 * @returns {string} Anchor HTML.
 */
function button(href, label) {
  return (
    `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;` +
    `text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px">${label}</a>`
  );
}

// ---------------------------------------------------------------------------
// Pure renderers — each returns { subject, html, text } for the given inputs and
// touches no I/O. These are the SINGLE SOURCE for the trial-email bodies: the
// senders below build from them, and lib/services/email-catalog.js previews them
// on the admin dashboard, so a preview is always byte-identical to what ships.
// ---------------------------------------------------------------------------

/** @param {string} [appUrl] @returns {string} Origin with any trailing slash stripped. */
function normBase(appUrl) {
  return String(appUrl || 'https://stagify.ai').replace(/\/$/, '');
}

/**
 * @param {{ appUrl?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderTrialWelcomeEmail({ appUrl } = {}) {
  const base = normBase(appUrl);
  const html = shell(
    `<p style="font-size:19px;font-weight:700;margin:14px 0 6px">Your 7 days of Stagify+ are live 🎉</p>` +
      `<p style="margin:0 0 14px">Everything's unlocked — the high-quality model, furniture removal, the AI Designer, and the Masking Studio. The fastest way to see what it can do is to stage one room right now.</p>` +
      `<p style="margin:0 0 20px">${button(base + '/', 'Stage your first photo')}</p>` +
      `<p style="margin:0 0 6px;font-weight:600">A few tips for a great first result:</p>` +
      `<ul style="margin:0 0 16px;padding-left:20px;color:#3a4356">` +
      `<li>Use a wide shot of an empty or lightly-furnished room.</li>` +
      `<li>Good, even lighting beats a dramatic angle.</li>` +
      `<li>Try the AI Designer if you'd rather describe the look in words.</li>` +
      `</ul>` +
      `<p style="margin:0;color:#5b6577">We'll email you 2 days before your trial ends — no surprise charges. You can cancel anytime.</p>`,
    base,
  );
  const text =
    `Your 7 days of Stagify+ are live.\n\n` +
    `Everything's unlocked — the high-quality model, furniture removal, the AI Designer, and the Masking Studio.\n\n` +
    `Stage your first photo: ${base}/\n\n` +
    `Tips: use a wide shot of an empty room, good even lighting, and try the AI Designer to describe the look in words.\n\n` +
    `We'll email you 2 days before your trial ends — no surprise charges. Cancel anytime.\n\n— Stagify`;
  return { subject: 'Your Stagify+ trial is live — stage your first room', html, text };
}

/**
 * @param {{ appUrl?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderTrialActivationNudgeEmail({ appUrl } = {}) {
  const base = normBase(appUrl);
  const html = shell(
    `<p style="font-size:19px;font-weight:700;margin:14px 0 6px">Your first staged room is 30 seconds away</p>` +
      `<p style="margin:0 0 14px">You've got full Stagify+ access, but it looks like you haven't staged a photo yet. It's quicker than it sounds — upload a room, pick a style, and you'll have a listing-ready image in about 8 seconds.</p>` +
      `<p style="margin:0 0 20px">${button(base + '/', 'Try it now')}</p>` +
      `<p style="margin:0 0 6px;font-weight:600">Not sure which photo to use?</p>` +
      `<p style="margin:0;color:#5b6577">Pick a wide shot of an empty or nearly-empty room with decent light — that gives the AI the most to work with. Empty rooms stage best.</p>`,
    base,
  );
  const text =
    `Your first staged room is 30 seconds away.\n\n` +
    `You've got full Stagify+ access but haven't staged a photo yet. Upload a room, pick a style, and you'll have a listing-ready image in about 8 seconds.\n\n` +
    `Try it now: ${base}/\n\n` +
    `Tip: use a wide shot of an empty, well-lit room — empty rooms stage best.\n\n— Stagify`;
  return { subject: 'Haven’t tried Stagify+ yet? Start here', html, text };
}

/**
 * @param {{ appUrl?: string }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderTrialValueEmail({ appUrl } = {}) {
  const base = normBase(appUrl);
  const html = shell(
    `<p style="font-size:19px;font-weight:700;margin:14px 0 6px">Three Stagify+ tools worth trying before your trial ends</p>` +
      `<p style="margin:0 0 14px">You're already staging — nice. These are the features that free plans (and most other tools) don't have:</p>` +
      `<ul style="margin:0 0 18px;padding-left:20px;color:#3a4356">` +
      `<li style="margin-bottom:8px"><strong>Remove existing furniture</strong> — clear a cluttered room, then restage it from a clean slate.</li>` +
      `<li style="margin-bottom:8px"><strong>AI Designer</strong> — describe the look you want in plain language and refine it conversationally.</li>` +
      `<li style="margin-bottom:8px"><strong>Masking Studio</strong> — highlight exactly which areas can change and attach your own furniture; everything else stays pixel-perfect.</li>` +
      `</ul>` +
      `<p style="margin:0 0 8px">${button(base + '/ai-designer.html', 'Open the AI Designer')}</p>` +
      `<p style="margin:12px 0 0;color:#5b6577">These are the features that make the $11.99/mo pay for itself on a single listing.</p>`,
    base,
  );
  const text =
    `Three Stagify+ tools worth trying before your trial ends:\n\n` +
    `1. Remove existing furniture — clear a cluttered room, then restage from a clean slate.\n` +
    `2. AI Designer — describe the look in plain language and refine it conversationally: ${base}/ai-designer.html\n` +
    `3. Masking Studio — highlight exactly which areas can change and attach your own furniture: ${base}/masking-studio.html\n\n` +
    `These are the features that make $11.99/mo pay for itself on a single listing.\n\n— Stagify`;
  return { subject: 'The Stagify+ features free plans don’t have', html, text };
}

/**
 * @param {{ appUrl?: string, daysLeft?: number, roomsStaged?: number }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderTrialEndingEmail({ appUrl, daysLeft, roomsStaged } = {}) {
  const base = normBase(appUrl);
  const n = Number.isFinite(daysLeft) ? Math.max(1, Number(daysLeft)) : 2;
  const dayWord = n === 1 ? 'tomorrow' : `in ${n} days`;
  const staged = Number.isFinite(roomsStaged) ? Number(roomsStaged) : 0;
  const recap =
    staged > 0
      ? `<p style="margin:0 0 14px">So far you've staged <strong>${staged} ${staged === 1 ? 'room' : 'rooms'}</strong> with Stagify+. Keep them coming — your plan stays unlimited.</p>`
      : `<p style="margin:0 0 14px">There's still time to put your trial to work — stage a room or two before it converts.</p>`;
  const html = shell(
    `<p style="font-size:19px;font-weight:700;margin:14px 0 6px">Your Stagify+ trial ends ${dayWord}</p>` +
      recap +
      `<p style="margin:0 0 14px">After that it's <strong>$11.99/month</strong> for unlimited staging — less than the cost of one traditional staging. No action needed if you'd like to keep going.</p>` +
      `<p style="margin:0 0 18px">${button(base + '/', 'Stage another room')}</p>` +
      `<p style="margin:0;color:#5b6577">Not for you right now? You can <a href="${base}/stagify-plus.html" style="color:${BRAND};text-decoration:none">cancel in one click</a> before the trial ends and you won't be charged.</p>`,
    base,
  );
  const text =
    `Your Stagify+ trial ends ${dayWord}.\n\n` +
    (staged > 0
      ? `So far you've staged ${staged} ${staged === 1 ? 'room' : 'rooms'}. Keep them coming — your plan stays unlimited.\n\n`
      : `There's still time to put your trial to work — stage a room or two before it converts.\n\n`) +
    `After that it's $11.99/month for unlimited staging. No action needed to keep going.\n\n` +
    `Keep staging: ${base}/\n` +
    `Cancel before the trial ends (no charge): ${base}/stagify-plus.html\n\n— Stagify`;
  return { subject: `Your Stagify+ trial ends ${dayWord}`, html, text };
}

/**
 * @param {{ appUrl?: string, accessUntil?: Date | null }} a
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderSubscriptionCanceledEmail({ appUrl, accessUntil } = {}) {
  const base = normBase(appUrl);
  let untilLine = '';
  if (accessUntil instanceof Date && !Number.isNaN(accessUntil.getTime())) {
    // Format in UTC so the displayed date is deterministic and matches the Stripe
    // period-end instant regardless of the server's local timezone.
    const d = accessUntil.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    untilLine = `<p style="margin:0 0 14px">You'll keep Stagify+ access until <strong>${d}</strong>.</p>`;
  }
  const html = shell(
    `<p style="font-size:19px;font-weight:700;margin:14px 0 6px">Your Stagify+ is canceled</p>` +
      untilLine +
      `<p style="margin:0 0 14px">No hard feelings — staging is bursty work, and a lot of people come back the week a new listing lands. Whenever that's you, your account and settings are right where you left them.</p>` +
      `<p style="margin:0 0 18px">${button(base + '/stagify-plus.html', 'Reactivate when you list again')}</p>` +
      `<p style="margin:0;color:#5b6577">Mind sharing why you left? Just reply to this email — a one-line answer genuinely helps us make Stagify better.</p>`,
    base,
  );
  const text =
    `Your Stagify+ is canceled.\n\n` +
    (untilLine ? `You'll keep access until the date shown in your account.\n\n` : '') +
    `Staging is bursty work — a lot of people come back the week a new listing lands. Your account and settings will be right where you left them.\n\n` +
    `Reactivate anytime: ${base}/stagify-plus.html\n\n` +
    `Mind sharing why you left? Just reply to this email — it genuinely helps.\n\n— Stagify`;
  return { subject: 'Your Stagify+ is canceled — come back anytime', html, text };
}

/**
 * Build the trial-lifecycle email senders, bound to the injected Resend client + config.
 * @param {{
 *   resend: { emails: { send: (opts: any) => Promise<{ error?: any }> } } | null,
 *   RESEND_FROM_EMAIL: string,
 *   EMAIL_DEBUG_MODE: boolean,
 *   DEBUG_EMAIL: string,
 *   appUrl: string,
 * }} deps - Resend client (null disables sending), the From address, the debug
 *   redirect flag + address, and the absolute site origin used in links.
 * @returns {{
 *   sendTrialWelcome: (a: { toEmail: string }) => Promise<{ ok: boolean, skipped?: boolean }>,
 *   sendTrialActivationNudge: (a: { toEmail: string }) => Promise<{ ok: boolean, skipped?: boolean }>,
 *   sendTrialValue: (a: { toEmail: string }) => Promise<{ ok: boolean, skipped?: boolean }>,
 *   sendTrialEnding: (a: { toEmail: string, daysLeft?: number, roomsStaged?: number }) => Promise<{ ok: boolean, skipped?: boolean }>,
 *   sendSubscriptionCanceled: (a: { toEmail: string, accessUntil?: Date | null }) => Promise<{ ok: boolean, skipped?: boolean }>,
 * }} The five trial-lifecycle senders.
 */
export function createLifecycleEmails(deps) {
  const { resend, RESEND_FROM_EMAIL, EMAIL_DEBUG_MODE, DEBUG_EMAIL, appUrl } = deps;
  const base = String(appUrl || 'https://stagify.ai').replace(/\/$/, '');

  /**
   * Low-level send: guards on config, applies the debug redirect, never throws.
   * @param {string} kind - Short label for logs (e.g. 'welcome').
   * @param {{ toEmail: string, subject: string, html: string, text: string }} msg - The email.
   * @returns {Promise<{ ok: boolean, skipped?: boolean }>} Send outcome.
   */
  async function send(kind, msg) {
    if (!resend) {
      logger.warn(`[trial-email] Resend not configured; skipping ${kind} email`);
      return { ok: false, skipped: true };
    }
    const recipient = EMAIL_DEBUG_MODE ? DEBUG_EMAIL : msg.toEmail;
    if (!recipient) return { ok: false, skipped: true };
    try {
      const result = await resend.emails.send({
        from: RESEND_FROM_EMAIL,
        to: recipient,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      if (result && result.error) {
        const errMsg =
          typeof result.error?.message === 'string' ? result.error.message : JSON.stringify(result.error);
        logger.error(`[trial-email] ${kind} send failed:`, errMsg);
        return { ok: false };
      }
      logger.info(`[trial-email] sent ${kind} email`);
      return { ok: true };
    } catch (err) {
      logger.error(`[trial-email] ${kind} send threw:`, err && err.message ? err.message : err);
      return { ok: false };
    }
  }

  // Senders = pure renderer (single source, shared with the admin preview) + send().
  const sendTrialWelcome = ({ toEmail }) =>
    send('welcome', { toEmail, ...renderTrialWelcomeEmail({ appUrl: base }) });
  const sendTrialActivationNudge = ({ toEmail }) =>
    send('activation', { toEmail, ...renderTrialActivationNudgeEmail({ appUrl: base }) });
  const sendTrialValue = ({ toEmail }) =>
    send('value', { toEmail, ...renderTrialValueEmail({ appUrl: base }) });
  const sendTrialEnding = ({ toEmail, daysLeft, roomsStaged }) =>
    send('ending', { toEmail, ...renderTrialEndingEmail({ appUrl: base, daysLeft, roomsStaged }) });
  const sendSubscriptionCanceled = ({ toEmail, accessUntil }) =>
    send('canceled', { toEmail, ...renderSubscriptionCanceledEmail({ appUrl: base, accessUntil }) });

  return {
    sendTrialWelcome,
    sendTrialActivationNudge,
    sendTrialValue,
    sendTrialEnding,
    sendSubscriptionCanceled,
  };
}
