// The admin console's analyst endpoint: one turn of a tool-calling conversation
// about the operator's own data.
//
// WHY IT IS ITS OWN ROUTER. The analyst drawer is reachable from every tab and is
// the console's only model-backed conversation, with its own hostile-input posture
// (below). Mounted with the rest of the console in routes/admin/mount.js.
//
// WHY IT IS STATELESS. The browser owns the conversation and the tool execution:
// it posts the whole transcript, gets back either an answer or a set of tool calls,
// runs those against the data it already holds, and posts again. So there is no
// session to store, nothing to expire, and a refresh simply loses a conversation
// rather than orphaning one. It also means the request body is the ONLY input, and
// lib/services/admin-analyst.js#sanitizeMessages treats it as hostile on principle.
//
// WHAT NEVER REACHES THIS ROUTE. The browser aggregates before it sends: tool
// results are counts, rates and opaque `acct_*` handles. No CSV row, no email, no
// IP and no customer prompt is posted here, and the scrub in the service is a
// backstop for that rather than the thing that makes it true.

import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';

/** Matches the service's own cap; rejected here so an oversized body is never parsed twice. */
const MAX_MESSAGES = 40;

/**
 * Build the admin analyst router.
 *
 * @param {{
 *   adminAnalyst: { ask: (req: {messages: any[]}) => Promise<object> } | null,
 *   protectLogs: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 * }} deps
 * @returns {import('express').Router} The mounted router.
 */
export function createAdminAnalystRouter(deps) {
  const { adminAnalyst, protectLogs, setSensitiveHeaders } = deps;
  const router = createAsyncRouter();

  // protectLogs runs BEFORE express.json() so an unauthenticated request is
  // rejected without its body being parsed — the ordering every mutating admin
  // route uses.
  router.post('/api/admin/analyst', protectLogs, express.json({ limit: '512kb' }), async (req, res) => {
    // The transcript quotes the operator's own analytics back at them. Not a
    // credential, but not something to leave in a shared cache either — the same
    // treatment the render inspector and the API usage panel get.
    setSensitiveHeaders(res);
    res.set('Cache-Control', 'no-store');

    // Degrade, don't 503. A deployment without GPT_KEY should show a drawer that
    // explains itself rather than an error the operator has to interpret — the
    // same contract GET /api/admin/metrics and POST /api/admin/brief offer.
    if (!adminAnalyst || typeof adminAnalyst.ask !== 'function') {
      return res.json({ message: null, reason: 'unavailable' });
    }

    const messages = req.body && req.body.messages;
    if (!Array.isArray(messages)) {
      return sendError(res, 400, 'A messages array is required');
    }
    if (messages.length > MAX_MESSAGES) {
      return sendError(res, 400, `A conversation may carry at most ${MAX_MESSAGES} messages`);
    }

    // `ask` never throws — it reports its own failure as a reason code, so a model
    // outage reads as "the analyst is unavailable" rather than a 500 on the tab.
    const result = await adminAnalyst.ask({ messages });
    return res.json(result);
  });

  return router;
}
