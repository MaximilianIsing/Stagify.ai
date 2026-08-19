// The public developer API. Every route here is authenticated by an API key and paid
// for with prepaid credits — no session, no cookie, no CORS.
//
// WHY SYNCHRONOUS. A render answers in the same request that asked for it. There is no
// job queue in this app (docs/guides/architecture.md), and adding one HERE would be a
// worse deal than it looks: a queue whose jobs evaporate on a Render restart leaves the
// customer's credit spent with no socket left to tell them, which is strictly worse
// than a connection that drops and can be retried against the same Idempotency-Key.
// `variations` is therefore capped at 1, which also makes the money 1:1 — one request,
// one credit, one debit, one refund. A client wanting three variations issues three
// concurrent requests and gets better parallelism than the fan-out gave them anyway.
//
// The migration to async is kept ADDITIVE on purpose: the success body already carries
// `status: "succeeded"` and GET /api/v1/renders/:id already exists, so a future
// `status: "queued"` needs no new endpoint and no breaking change. The docs tell
// clients to treat any status other than "succeeded" as "poll the GET".

import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { logger } from '../lib/logger.js';
import { apiRenderLimiter as defaultApiRenderLimiter } from '../lib/http/rate-limiters.js';
import { buildApiOptions, MAX_VARIATIONS } from '../lib/staging/api-options.js';

/** Bounds the Idempotency-Key we will store. Long enough for a UUID or a ULID. */
const MAX_IDEMPOTENCY_KEY = 128;

/**
 * Build the public API router.
 * @param {{
 *   apiBilling: any,
 *   requireApiKey: import('express').RequestHandler,
 *   concurrencyGate: import('express').RequestHandler,
 *   stagingProcessUpload: import('express').RequestHandler,
 *   runBilledRender: (req: any, res: any, opts: any) => Promise<any>,
 *   apiRenderLimiter?: import('express').RequestHandler,
 * }} deps - The credit store, the two gates, multer, the billing band, and
 *   a test-only limiter seam (omitted, the shared limiter is used, so the render
 *   endpoint is never mounted unlimited).
 * @returns {import('express').Router} The mounted router.
 */
export default function createApiV1Router(deps) {
  const {
    apiBilling,
    requireApiKey,
    concurrencyGate,
    stagingProcessUpload,
    runBilledRender,
    apiRenderLimiter = defaultApiRenderLimiter,
  } = deps;

  const router = createAsyncRouter();

  /**
   * The validated key context, which requireApiKey guarantees on every route here.
   *
   * A helper rather than a non-null assertion at nine call sites: it states the
   * invariant once, and it throws loudly if this router is ever mounted without the
   * guard in front of it — which would otherwise read as a caller with no account
   * rather than as the wiring mistake it is.
   * @param {any} req - The request.
   * @returns {{ keyId: string, userId: string, prefix: string, user: any }} The context.
   */
  function ctx(req) {
    const k = req.apiKey;
    if (!k) throw new Error('api-v1: route reached without requireApiKey');
    return { keyId: k.id, userId: k.userId, prefix: k.prefix, user: req.apiUser };
  }

  /**
   * Advertise the balance on every answer, so a client can see the wall coming without
   * polling for it. A hard stop at zero is inherent to prepaid and correct; discovering
   * it only when a batch dies half-way is not.
   * @param {any} res @param {string} userId @param {string} [requestId]
   */
  function stampCreditHeaders(res, userId, requestId) {
    try {
      res.setHeader('X-Stagify-Credits-Remaining', String(apiBilling.getBalance(userId).balance));
      if (requestId) res.setHeader('X-Stagify-Request-Id', requestId);
    } catch { /* headers are informational; never fail a render over one */ }
  }

  /**
   * The idempotency key for this request: the caller's, or one derived per request.
   *
   * A caller who supplies none gets a fresh random key, i.e. no replay protection —
   * which is the honest default. Silently deriving one from the body would make two
   * genuinely-separate renders of the same photo collide, and the second caller would
   * be handed the first one's image.
   * @param {any} req @returns {string}
   */
  function idempotencyKeyFor(req) {
    const raw = req.get('Idempotency-Key');
    if (raw && typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, MAX_IDEMPOTENCY_KEY);
    return 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ── POST /api/v1/renders ────────────────────────────────────────────────────
  // Chain order is load-bearing:
  //   apiRenderLimiter   — cheap, refuses a flood before any database work
  //   requireApiKey      — identifies the account (and rate-limits WRONG keys itself)
  //   concurrencyGate    — bounds SIMULTANEOUS renders, which the limiter cannot
  //   stagingProcessUpload — multer LAST, so 25MB is never buffered for a caller who
  //                        was going to be refused anyway (the same ordering fix
  //                        /api/process-image already carries)
  router.post(
    '/api/v1/renders',
    apiRenderLimiter,
    requireApiKey,
    concurrencyGate,
    stagingProcessUpload,
    async (req, res) => {
      const { keyId, userId, user } = ctx(req);

      // v1 accepts one variation. Refused rather than silently clamped: a caller who
      // asked for 3 and was billed for 1 should be told, not left to discover it.
      //
      // BOTH spellings are checked. `variations` is the documented one, but the pipeline
      // reads `variationCount` (lib/staging/virtual-staging-handler.js), and for a while
      // only the first was guarded — so `variationCount=3` rendered three images against
      // one credit. api-render-billing.js now pins the field regardless; this stays the
      // loud half, so a caller who asks for three learns they cannot have them.
      for (const field of ['variations', 'variationCount']) {
        const requested = req.body?.[field];
        if (requested !== undefined && Number(requested) !== MAX_VARIATIONS) {
          return sendError(res, 400, 'This API renders one image per request. Issue concurrent requests for variations.', {
            code: 'VARIATIONS_UNSUPPORTED',
          });
        }
      }

      const out = await runBilledRender(req, res, {
        keyId,
        userId,
        user,
        idempotencyKey: idempotencyKeyFor(req),
        // Fired right after the debit and before the render. This is the ONLY moment
        // the router can still write headers on the success path: the wrapped handler
        // flushes the response itself, so anything set after the await is too late.
        onCharged: ({ requestId, balance }) => {
          res.setHeader('X-Stagify-Request-Id', requestId);
          res.setHeader('X-Stagify-Credits-Remaining', String(balance));
          res.setHeader('X-Stagify-Replayed', 'false');
        },
      });

      // Refusals that never spent a model call.
      if (out.outcome === 'insufficient') {
        stampCreditHeaders(res, userId);
        // Built inline rather than through sendError because the body carries the two
        // numbers a client needs to act — the same shape, and the same reason, as the
        // DAILY_LIMIT_REACHED 429 in lib/staging/virtual-staging-handler.js.
        return res.status(402).json({
          error: 'Not enough credits. Top up at /api-keys.html.',
          code: 'INSUFFICIENT_CREDITS',
          credits_required: 1,
          credits_remaining: out.balance ?? 0,
        });
      }
      if (out.outcome === 'suspended') {
        return sendError(res, 403, 'This account is suspended. Contact support@stagify.ai.', {
          code: 'ACCOUNT_SUSPENDED',
        });
      }
      if (out.outcome === 'in_flight') {
        return sendError(res, 409, 'A request with this Idempotency-Key is still running.', {
          code: 'REQUEST_IN_FLIGHT',
        });
      }
      if (out.outcome === 'too_many_attempts') {
        return sendError(res, 409, 'This Idempotency-Key has been retried too many times. Use a new one.', {
          code: 'REQUEST_IN_FLIGHT',
        });
      }
      if (out.outcome === 'key_reused') {
        return sendError(res, 422, 'This Idempotency-Key was already used for different parameters.', {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      if (out.outcome === 'settled_retry') {
        return sendError(res, 422, 'This Idempotency-Key belongs to a settled request. Use a new one.', {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }

      // A replay: the work was done and paid for on an earlier call. The image itself
      // is not re-served (we do not keep the bytes here — the gallery does), so the
      // caller is pointed at the record.
      if (out.outcome === 'replay') {
        stampCreditHeaders(res, userId, out.requestId);
        res.setHeader('X-Stagify-Replayed', 'true');
        return res.json({
          id: out.requestId,
          object: 'render',
          status: 'succeeded',
          replayed: true,
          detail: 'This Idempotency-Key was already rendered. Retrieve it from GET /api/v1/renders/{id}.',
        });
      }

      if (out.outcome === 'failed') {
        const error = out.error;
        const ref = reportError('api.v1.renders', error);
        if (res.headersSent) return undefined;

        // Fail-closed disclosure, the same distinct branch /api/process-image carries
        // at routes/staging.js:198. Without its own code a withheld-but-successful
        // render is indistinguishable from a generation failure and gets retried
        // forever. The credit was already refunded by the band.
        if (error && error.code === 'DISCLOSURE_STAMP_FAILED') {
          return sendError(res, 500, 'The "virtually staged" label could not be applied, so the image was withheld. Retry without labelVirtuallyStaged.', {
            code: 'DISCLOSURE_STAMP_FAILED',
            ref,
          });
        }
        if (error && error.code === 'NO_IMAGE_GENERATED') {
          return sendError(res, 422, 'The model did not return an image for this photo. Your credit was refunded.', {
            code: 'NO_IMAGE_GENERATED',
            ref,
          });
        }
        return sendError(res, 500, 'Render failed. Your credit was refunded.', { code: 'RENDER_FAILED', ref });
      }

      // Rendered: the wrapped handler already wrote the body, and onCharged put the
      // credit headers on before it flushed. Nothing left to send.
      return undefined;
    },
  );

  // ── GET /api/v1/renders/:id ─────────────────────────────────────────────────
  // Status/replay lookup, and the seam a future async mode grows into.
  router.get('/api/v1/renders/:id', apiRenderLimiter, requireApiKey, async (req, res) => {
    const { userId } = ctx(req);
    const row = apiBilling.getRequest(req.params.id);
    // Owner-scoped, and a stranger's id answers exactly as one that never existed —
    // otherwise this is an existence oracle for other customers' request ids.
    if (!row || row.user_id !== userId) {
      return sendError(res, 404, 'No such render', { code: 'NOT_FOUND' });
    }
    stampCreditHeaders(res, userId, row.id);
    return res.json({
      id: row.id,
      object: 'render',
      status: row.status === 'charged' ? 'processing' : row.status,
      created: Math.floor(row.claimed_at / 1000),
      credits: { charged: row.credits_charged },
    });
  });

  // ── GET /api/v1/credits ─────────────────────────────────────────────────────
  router.get('/api/v1/credits', apiRenderLimiter, requireApiKey, async (req, res) => {
    const { userId } = ctx(req);
    const b = apiBilling.getBalance(userId);
    stampCreditHeaders(res, userId);
    return res.json({
      object: 'credits',
      balance: b.balance,
      lifetime_purchased: b.lifetimePurchased,
      lifetime_spent: b.lifetimeSpent,
    });
  });

  // ── GET /api/v1/me ──────────────────────────────────────────────────────────
  // The "is my key working" call. Deliberately cheap and side-effect free, so a
  // client's health check does not spend a render budget worth mentioning.
  router.get('/api/v1/me', apiRenderLimiter, requireApiKey, async (req, res) => {
    const { userId, prefix, user } = ctx(req);
    const b = apiBilling.getBalance(userId);
    stampCreditHeaders(res, userId);
    return res.json({
      object: 'account',
      email: user.email,
      key_prefix: prefix,
      credits: b.balance,
    });
  });

  // ── GET /api/v1/options ─────────────────────────────────────────────────────
  // The accepted values for roomType, furnitureStyle and the stamp fields, derived
  // from the same tables the renderer uses (lib/staging/api-options.js).
  //
  // UNAUTHENTICATED, unlike every other route in this file. Three reasons: it is a
  // static vocabulary with nothing account-specific in it; an integrator needs it while
  // choosing whether to buy credits at all, which is before they have a key to send;
  // and developers.html renders its parameter table from this response, which it fetches
  // as an anonymous visitor. Same-origin, so the deliberate absence of CORS headers on
  // /api/v1/* does not get in the way.
  //
  // Still rate-limited: unauthenticated and cheap is not unauthenticated and free.
  router.get('/api/v1/options', apiRenderLimiter, async (req, res) => {
    // Safe to cache hard — the body only changes when the code does.
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(buildApiOptions());
  });

  logger.debug('[api] /api/v1 router mounted');
  return router;
}
