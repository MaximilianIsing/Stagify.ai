// Trial-lifecycle orchestrator — decides WHICH lifecycle email fires WHEN, and
// records that it fired so nobody is emailed twice. Two triggers feed it:
//
//   1. Stripe webhooks (event-driven, exact timing):
//        checkout.session.completed        → onTrialCheckout   (welcome)
//        customer.subscription.trial_will_end → onTrialWillEnd  (ending soon)
//        customer.subscription.deleted      → onSubscriptionCanceled (win-back)
//
//   2. A periodic sweep (behaviour + time based, can't be a single Stripe event):
//        ~day 1-4, hasn't staged anything → activation nudge
//        ~day 3-5, is actively staging    → value / feature-depth email
//
// Idempotency lives in the auth-store: each user carries a `trialLifecycle.sent`
// map of which emails have gone out (see auth-store.markTrialEmailSent). We set a
// flag only AFTER a successful send, so a transient mail failure is retried by the
// next sweep (for the sweep emails) rather than silently lost.
//
// Nothing here throws: a mail outage must never break a Stripe webhook (which
// would make Stripe retry forever) or crash the sweep timer.

import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a Stripe subscription's customer id whether it arrived as a string or
 * an expanded object.
 * @param {any} subscription - Stripe subscription payload.
 * @returns {string | null} The customer id, or null.
 */
function customerIdOf(subscription) {
  const c = subscription && subscription.customer;
  if (typeof c === 'string') return c;
  if (c && typeof c.id === 'string') return c.id;
  return null;
}

/**
 * Build the trial-lifecycle orchestrator.
 * @param {{
 *   authStore: {
 *     beginTrial: (userId: string, startAtISO: string) => any,
 *     markTrialEmailSent: (userId: string, key: string) => any,
 *     listTrialCandidates: () => Array<{ id: string, email: string, plan: string, trialLifecycle: { startAt?: string, sent?: Record<string, string> }, lastStagedAt?: string | null, lifetimeStaged?: number }>,
 *     findUserByStripeIds: (ids: { subscriptionId?: string | null, customerId?: string | null }) => any,
 *   },
 *   emails: ReturnType<typeof import('./lifecycle-emails.js').createLifecycleEmails>,
 *   now?: () => number,
 * }} deps - The trial-tracking slice of the auth-store, the lifecycle email
 *   senders, and an injectable clock (tests).
 */
export function createTrialLifecycle(deps) {
  const { authStore, emails } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  /**
   * The trial-tracked users, never throwing — a store hiccup yields an empty pass.
   * @returns {Array<any>} Candidate users (possibly empty).
   */
  function listCandidatesSafe() {
    try {
      return authStore.listTrialCandidates() || [];
    } catch (err) {
      logger.error('[trial] listTrialCandidates failed:', err && err.message ? err.message : err);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Webhook-driven emails
  // -------------------------------------------------------------------------

  /**
   * A Stagify+ trial just started (Stripe checkout). Start tracking the trial and
   * send the welcome/activation email exactly once.
   * @param {{ userId?: string | null, email?: string | null }} arg - The mapped user.
   * @returns {Promise<void>}
   */
  async function onTrialCheckout({ userId }) {
    if (!userId) return;
    const user = authStore.beginTrial(userId, new Date(now()).toISOString());
    if (!user) return;
    if (user.trialLifecycle && user.trialLifecycle.sent && user.trialLifecycle.sent.welcome) return;
    const res = await emails.sendTrialWelcome({ toEmail: user.email });
    if (res && res.ok) authStore.markTrialEmailSent(userId, 'welcome');
  }

  /**
   * Stripe says the trial ends in ~3 days. Send the trial-ending reminder once.
   * @param {{ subscription: any }} arg - The Stripe subscription payload.
   * @returns {Promise<void>}
   */
  async function onTrialWillEnd({ subscription }) {
    const user = authStore.findUserByStripeIds({
      subscriptionId: subscription && subscription.id,
      customerId: customerIdOf(subscription),
    });
    if (!user) return;
    if (user.trialLifecycle && user.trialLifecycle.sent && user.trialLifecycle.sent.ending) return;
    const trialEndMs = subscription && subscription.trial_end ? subscription.trial_end * 1000 : null;
    const daysLeft = trialEndMs ? Math.max(1, Math.round((trialEndMs - now()) / DAY_MS)) : 2;
    const res = await emails.sendTrialEnding({
      toEmail: user.email,
      daysLeft,
      roomsStaged: Number.isFinite(user.lifetimeStaged) ? user.lifetimeStaged : 0,
    });
    if (res && res.ok) authStore.markTrialEmailSent(user.id, 'ending');
  }

  /**
   * The subscription ended (trial not converted, or a paying customer cancelled).
   * Send the win-back email once.
   * @param {{ subscription: any }} arg - The Stripe subscription payload.
   * @returns {Promise<void>}
   */
  async function onSubscriptionCanceled({ subscription }) {
    const user = authStore.findUserByStripeIds({
      subscriptionId: subscription && subscription.id,
      customerId: customerIdOf(subscription),
    });
    if (!user) return;
    if (user.trialLifecycle && user.trialLifecycle.sent && user.trialLifecycle.sent.canceled) return;
    const untilMs = subscription && subscription.current_period_end ? subscription.current_period_end * 1000 : null;
    const res = await emails.sendSubscriptionCanceled({
      toEmail: user.email,
      accessUntil: untilMs ? new Date(untilMs) : null,
    });
    if (res && res.ok) authStore.markTrialEmailSent(user.id, 'canceled');
  }

  // -------------------------------------------------------------------------
  // Behaviour + time based sweep
  // -------------------------------------------------------------------------

  /**
   * One pass over every trial-tracked user: send the activation nudge to those who
   * haven't staged yet, and the value email to those who have. At most one email
   * per user per pass, each sent at most once ever.
   * @returns {Promise<{ activation: number, value: number }>} Count of emails sent.
   */
  async function runSweep() {
    const sent = { activation: 0, value: 0 };
    const candidates = listCandidatesSafe();
    const nowMs = now();
    for (const u of candidates) {
      const tl = u.trialLifecycle || {};
      const startMs = tl.startAt ? Date.parse(tl.startAt) : NaN;
      if (!Number.isFinite(startMs)) continue;
      const ageDays = (nowMs - startMs) / DAY_MS;
      const flags = tl.sent || {};
      const activated = !!u.lastStagedAt && Date.parse(u.lastStagedAt) >= startMs;
      try {
        // #2 Activation nudge: early, and only if they haven't staged anything.
        if (!flags.activation && !activated && ageDays >= 1 && ageDays < 4.5) {
          const res = await emails.sendTrialActivationNudge({ toEmail: u.email });
          if (res && res.ok) {
            authStore.markTrialEmailSent(u.id, 'activation');
            sent.activation += 1;
          }
          continue; // one email per user per sweep
        }
        // #3 Value email: mid-trial, and only for users who ARE staging.
        if (!flags.value && activated && ageDays >= 3 && ageDays < 5.5) {
          const res = await emails.sendTrialValue({ toEmail: u.email });
          if (res && res.ok) {
            authStore.markTrialEmailSent(u.id, 'value');
            sent.value += 1;
          }
          continue;
        }
      } catch (err) {
        logger.error('[trial] sweep send failed for user:', err && err.message ? err.message : err);
      }
    }
    return sent;
  }

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /**
   * Start the recurring sweep (runs once immediately, then every intervalMs).
   * Idempotent — a second call is a no-op while a timer is already running.
   * @param {number} [intervalMs] - Sweep cadence (default hourly).
   * @returns {void}
   */
  function start(intervalMs = 60 * 60 * 1000) {
    if (timer) return;
    runSweep().catch((err) => logger.error('[trial] initial sweep failed:', err && err.message ? err.message : err));
    timer = setInterval(() => {
      runSweep().catch((err) => logger.error('[trial] sweep failed:', err && err.message ? err.message : err));
    }, intervalMs);
    timer.unref?.();
  }

  /** Stop the recurring sweep (tests / shutdown). @returns {void} */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { onTrialCheckout, onTrialWillEnd, onSubscriptionCanceled, runSweep, start, stop };
}
