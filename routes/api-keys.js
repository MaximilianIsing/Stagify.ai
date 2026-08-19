// The account-facing half of the public API: managing keys and buying credits.
//
// Session-authenticated, unlike routes/api-v1.js — this is what the signed-in developer
// dashboard (public/api-keys.html) calls from a browser, so it uses the same
// getAuthUserFromRequest every other account route does. The two halves are separate
// files because they have separate auth models, and mixing them would make it far too
// easy to leave an /api/v1 route reachable with a session cookie.
//
// OWNERSHIP IS KEYED ON THE VALIDATED SESSION, NEVER ON THE BODY. Every route below
// derives the user from the token and passes that id to the store; a request naming
// somebody else's key id gets a 404, indistinguishable from one that never existed, so
// this is not an existence oracle for other people's key ids.

import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError, setSensitiveHeaders, resolveAppOrigin } from '../lib/http/http-helpers.js';
import { logger } from '../lib/logger.js';
import {
  apiKeyManageLimiter as defaultApiKeyManageLimiter,
  creditCheckoutLimiter as defaultCreditCheckoutLimiter,
} from '../lib/http/rate-limiters.js';

/**
 * Build the API key + credits management router.
 * @param {{
 *   apiKeys: any,
 *   apiBilling: any,
 *   creditPacks: any,
 *   stripe: any,
 *   getAuthUserFromRequest: (req: any) => any,
 *   apiKeyManageLimiter?: import('express').RequestHandler,
 *   creditCheckoutLimiter?: import('express').RequestHandler,
 * }} deps - Stores, the pack table, Stripe (or null), the session reader, and two
 *   test-only limiter seams.
 * @returns {import('express').Router} The mounted router.
 */
export default function createApiKeysRouter(deps) {
  const {
    apiKeys,
    apiBilling,
    creditPacks,
    stripe,
    getAuthUserFromRequest,
    apiKeyManageLimiter = defaultApiKeyManageLimiter,
    creditCheckoutLimiter = defaultCreditCheckoutLimiter,
  } = deps;

  const router = createAsyncRouter();

  /**
   * The signed-in account, or null after answering 401.
   * @param {any} req @param {any} res
   * @returns {any | null} The user.
   */
  function requireSession(req, res) {
    setSensitiveHeaders(res);
    const user = getAuthUserFromRequest(req);
    if (!user) {
      sendError(res, 401, 'Sign in required', { code: 'AUTH_REQUIRED' });
      return null;
    }
    return user;
  }

  // ── Keys ────────────────────────────────────────────────────────────────────

  router.get('/api/api-keys', async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;
    return res.json({ keys: apiKeys.listForUser(user.id) });
  });

  router.post('/api/api-keys', apiKeyManageLimiter, express.json(), async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;

    const out = apiKeys.mintKey({ userId: user.id, name: req.body?.name });
    if (!out.ok) {
      return sendError(res, 409, 'You have reached the maximum number of API keys. Revoke one first.', {
        code: 'TOO_MANY_KEYS',
      });
    }
    logger.info('[api-keys] minted a key for', user.id);
    // THE ONLY TIME `key` IS EVER RETURNED. There is no read path that can recover it
    // afterwards — the store holds a digest — so the dashboard has to show it now and
    // say so plainly.
    return res.status(201).json({ key: out.key, record: out.record });
  });

  router.delete('/api/api-keys/:id', apiKeyManageLimiter, async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;

    const out = apiKeys.revoke({ id: req.params.id, userId: user.id });
    if (!out.ok) {
      // 'not_found' covers both "no such key" and "somebody else's key" on purpose.
      // 'already_revoked' is also a 404: the caller's intent is satisfied either way
      // and distinguishing them would leak that the id is real.
      return sendError(res, 404, 'No such API key', { code: 'NOT_FOUND' });
    }
    return res.json({ ok: true });
  });

  router.patch('/api/api-keys/:id', apiKeyManageLimiter, express.json(), async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;

    const out = apiKeys.rename({ id: req.params.id, userId: user.id, name: req.body?.name });
    if (!out.ok) return sendError(res, 404, 'No such API key', { code: 'NOT_FOUND' });
    return res.json({ record: out.record });
  });

  // ── Credits ─────────────────────────────────────────────────────────────────

  router.get('/api/api-credits', async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;
    const b = apiBilling.getBalance(user.id);
    return res.json({
      balance: b.balance,
      lifetimePurchased: b.lifetimePurchased,
      lifetimeSpent: b.lifetimeSpent,
      suspended: !!b.suspendedAt,
      // Why the count rides along on the CREDITS call: the account menu needs one
      // yes/no ("does this person use the API at all?") to decide whether to show its
      // row, and answering it from two endpoints would double a request that fires on
      // every menu open. Everything here is already loaded for the dashboard anyway.
      keyCount: apiKeys.listForUser(user.id).filter((k) => !k.revokedAt).length,
      ledger: apiBilling.listLedger(user.id, 50),
    });
  });

  // ── Usage ───────────────────────────────────────────────────────────────────

  // What the dashboard's detail pane is made of: traffic per key and per day, which
  // the credits endpoint above cannot answer because the ledger records money, not
  // requests. Session-gated like the rest — these are the account's own numbers.
  //
  // `days` is a query parameter rather than a fixed 30 so the range switcher costs a
  // parameter instead of a second endpoint. It is clamped in the store (1..90), so a
  // caller asking for a year gets ninety days rather than an error or a table scan.
  router.get('/api/api-usage', async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;
    return res.json(apiBilling.usageSummary(user.id, { days: Number(req.query.days) || 30 }));
  });

  router.get('/api/api-credits/packs', async (req, res) => {
    // Not session-gated: the pack table is public pricing, and developers.html shows it
    // to signed-out visitors. It carries no Stripe price ids — only what to charge and
    // what you get — so there is nothing here worth authenticating.
    return res.json({
      packs: creditPacks.list().map((p) => ({
        id: p.id,
        credits: p.credits,
        amountCents: p.amountCents,
        currency: p.currency,
      })),
    });
  });

  router.post('/api/api-credits/checkout', creditCheckoutLimiter, express.json(), async (req, res) => {
    const user = requireSession(req, res);
    if (!user) return undefined;

    if (!stripe) return sendError(res, 503, 'Billing not configured', { code: 'STRIPE_DISABLED' });

    const pack = creditPacks.resolvePackById(req.body?.packId);
    if (!pack || !pack.priceId) {
      return sendError(res, 400, 'Unknown credit pack', { code: 'UNKNOWN_PACK' });
    }

    try {
      const baseUrl = resolveAppOrigin(req);
      const session = await stripe.checkout.sessions.create({
        // One-time, NOT a subscription: credits are bought, not rented, and putting
        // them on a metered subscription is what would collide with the enterprise
        // meter for an account that holds both.
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: user.id,
        // Reuse the account's Stripe customer when it has one, so a credit purchase and
        // any Stagify+ subscription live under the same customer — which is what makes
        // the existing customer portal and the clawback path both able to find it. Safe
        // because this is a different product, on a different price, in a different mode.
        ...(user.stripeCustomerId
          ? { customer: user.stripeCustomerId }
          : { customer_email: user.email }),
        line_items: [{ price: pack.priceId, quantity: 1 }],
        metadata: { stagify_api_pack: pack.id, stagify_user_id: user.id },
        // Copied onto the PaymentIntent so it survives onto the CHARGE: a dispute event
        // carries no checkout session, so without this a chargeback could not be traced
        // back to the pack it bought.
        payment_intent_data: {
          metadata: { stagify_api_pack: pack.id, stagify_user_id: user.id },
        },
        success_url: `${baseUrl}/api-keys.html?credits=1`,
        cancel_url: `${baseUrl}/api-keys.html?cancelled=1`,
      });
      return res.json({ url: session.url });
    } catch (e) {
      logger.error('[api-credits] checkout session error:', e.message);
      return sendError(res, 500, 'Could not create checkout session');
    }
  });

  return router;
}
