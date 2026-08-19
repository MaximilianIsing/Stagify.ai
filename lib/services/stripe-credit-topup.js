// Stripe → API credits: the two events that move a prepaid balance.
//
// A SEPARATE MODULE from stripe-webhooks.js on purpose — that file is already close to
// its 650-line cap, and this is a self-contained concern with its own failure modes.
//
// THE RETURN CONTRACT IS THE IDEMPOTENCY PROTOCOL. routes/billing.js already implements
// claim / markDone / release correctly and needs no change; what decides which of those
// runs is the SHAPE of what these functions return:
//
//   { ok: true }                 → markDone. Credited; a redelivery is a duplicate.
//   { ok: true, duplicate }      → markDone. Already credited; nothing moved.
//   { ok: false, reason }        → RELEASE. Something an operator must fix, so Stripe's
//                                  "Resend event" button still works afterwards. A bare
//                                  "skip if seen" here would black-hole the retry.
//   throw                        → release + 500. Stripe retries; the transaction rolled
//                                  back, so the retry is the one that credits.
//
// VERIFYING THE MONEY. The credit count comes from OUR pack table, keyed by a pack id we
// wrote into the session metadata — and is then checked against `amount_total`. Trusting
// metadata alone would make credits mintable by anyone who could influence it; trusting
// the Stripe price alone would let a dashboard edit silently change what we grant.

import { logger } from '../logger.js';

/**
 * Build the credit-topup handlers.
 * @param {{ apiBilling: any, creditPacks: any, authStore: any }} deps - The credit store,
 *   the pack table, and the account store (to resolve a Stripe customer to a user).
 * @returns {{ handleCreditTopup: (session: any) => any, handleCreditClawback: (charge: any) => any, isCreditSession: (session: any) => boolean }}
 */
export function createStripeCreditTopup({ apiBilling, creditPacks, authStore }) {
  /**
   * Whether a completed checkout session is an API credit purchase.
   * @param {any} session - The Stripe session.
   * @returns {boolean} True when it carries our pack marker.
   */
  function isCreditSession(session) {
    return !!(session && session.mode === 'payment' && session.metadata && session.metadata.stagify_api_pack);
  }

  /**
   * Resolve the buyer.
   *
   * client_reference_id first (we set it ourselves at checkout, from the validated
   * session), then the Stripe customer id. Deliberately NO email fallback: an
   * unverified address must never be able to direct a top-up, and unlike the
   * subscription path there is no existing relationship an email could merely confirm.
   * @param {any} session - The Stripe session.
   * @returns {string | null} The user id, or null.
   */
  function resolveUserId(session) {
    const ref = session.client_reference_id;
    if (ref && authStore.findUserById(ref)) return ref;

    const custId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (custId && typeof authStore.findUserByStripeIds === 'function') {
      const byCustomer = authStore.findUserByStripeIds({ stripeCustomerId: custId });
      if (byCustomer?.id) return byCustomer.id;
    }
    return null;
  }

  /**
   * Credit a completed one-time purchase.
   * @param {any} session - The `checkout.session.completed` object.
   * @returns {{ ok: boolean, reason?: string, duplicate?: boolean, credited?: number }} The outcome.
   */
  function handleCreditTopup(session) {
    // An unpaid session is not a purchase. Released rather than marked done, because a
    // later async payment method genuinely can complete it.
    if (session.payment_status !== 'paid') {
      return { ok: false, reason: 'not_paid' };
    }

    const packId = session.metadata?.stagify_api_pack;
    const pack = creditPacks.resolvePackById(packId);
    if (!pack) {
      logger.error('[api-credits] unknown pack id on a paid session:', packId, session.id);
      return { ok: false, reason: 'unknown_pack' };
    }

    // The proof. Credits granted must be justified by money actually received.
    // `>=` rather than `===` so a coupon-free overpayment or a currency-rounding
    // difference does not strand a real purchase; an UNDERpayment is refused.
    if (session.currency !== pack.currency || Number(session.amount_total) < pack.amountCents) {
      logger.error(
        '[api-credits] amount mismatch for', pack.id, '—', session.amount_total, session.currency,
        'expected at least', pack.amountCents, pack.currency, '(session', session.id + ')',
      );
      return { ok: false, reason: 'amount_mismatch' };
    }

    const userId = resolveUserId(session);
    if (!userId) {
      // Money arrived and nobody can be credited. Released so the operator can fix the
      // mapping and hit "Resend event".
      logger.error('[api-credits] paid session maps to no account:', session.id);
      return { ok: false, reason: 'no_user' };
    }

    const out = apiBilling.creditPurchase({
      userId,
      credits: pack.credits,
      sessionId: session.id,
      packId: pack.id,
    });
    if (out.duplicate) {
      logger.info('[api-credits] redelivery of an already-credited session:', session.id);
      return { ok: true, duplicate: true, credited: 0 };
    }
    logger.info('[api-credits] credited', pack.credits, 'to', userId, 'for', session.id);
    return { ok: true, credited: pack.credits };
  }

  /**
   * Take credits back after a refund or a dispute.
   *
   * Without this, spend-then-chargeback is a free render: the balance was already
   * consumed and the money goes home. Clamped at zero by the store, which suspends the
   * account on any shortfall — that suspension is what actually stops further spend.
   * @param {any} charge - The `charge.refunded` / `charge.dispute.created` object.
   * @returns {{ ok: boolean, reason?: string, duplicate?: boolean, clawed?: number }} The outcome.
   */
  function handleCreditClawback(charge) {
    // Our own metadata, copied onto the PaymentIntent at checkout so it survives onto
    // the charge — a dispute object does not carry the checkout session.
    const meta = charge?.metadata || charge?.payment_intent?.metadata || {};
    const packId = meta.stagify_api_pack;
    if (!packId) {
      // Not one of ours (a subscription invoice, say). Nothing to do, and nothing an
      // operator needs to fix, so this is `handled` rather than released.
      return { ok: true, reason: 'not_a_credit_charge', clawed: 0 };
    }

    const pack = creditPacks.resolvePackById(packId);
    if (!pack) return { ok: false, reason: 'unknown_pack' };

    const userId = meta.stagify_user_id && authStore.findUserById(meta.stagify_user_id)
      ? meta.stagify_user_id
      : null;
    if (!userId) {
      logger.error('[api-credits] clawback maps to no account:', charge.id);
      return { ok: false, reason: 'no_user' };
    }

    const out = apiBilling.clawbackCredits({
      userId,
      credits: pack.credits,
      externalId: charge.id,
    });
    if (out.duplicate) return { ok: true, duplicate: true, clawed: 0 };
    logger.warn(
      '[api-credits] clawed back', out.clawed, 'credit(s) from', userId,
      out.suspended ? `— SUSPENDED (shortfall ${out.shortfall})` : '',
    );
    return { ok: true, clawed: out.clawed };
  }

  return { handleCreditTopup, handleCreditClawback, isCreditSession };
}
