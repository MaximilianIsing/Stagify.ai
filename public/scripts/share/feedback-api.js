// The reply channel's two network calls — and, unlike api.js, this one MUST distinguish
// its failures.
//
// WHY THE RULE IS DIFFERENT HERE. api.js collapses every manifest failure into one bit on
// purpose: the server withholds the reason so a stranger holding a guessed token learns
// nothing, and a client that smuggled the reason out would undo that. Nothing on this
// endpoint is a secret from the person already holding the link — they are being asked to
// answer, and the four outcomes need four different sentences:
//
//   * `ok`      — recorded. Paint it.
//   * `FULL`    — a 409: this link has said everything it is allowed to say. That is a
//                 CALM state ("we already have your notes"), not an error, and painting it
//                 red would tell a seller they broke something when they did not.
//   * `INVALID` — a 400. Unreachable from this UI (the verdict comes from a button, not a
//                 field), so it is folded into the ordinary failure copy rather than given
//                 a sentence of its own; it exists as a distinct code so the seam is
//                 visible if the contract ever moves.
//   * `ERROR`   — anything else, including a dead network. Quiet, inline, retryable.
//
// THE GET IS ALSO THE CAPABILITY PROBE, AND `absent` — NOT `ok` — IS THE PROBE'S ANSWER.
// An older server has no /feedback route and answers 404; that returns `absent: true` and
// makes the whole reply UI never render (see signoff.js), because half a form pointed at a
// route that does not exist is worse for a seller than the read-only gallery they had.
//
// The distinction is load-bearing and was originally missing: `ok: false` alone ALSO covers
// a route that exists and merely could not answer — a 429, a 5xx, a dropped connection on a
// phone. Hiding the channel for those told a seller the feature did not exist, when in fact
// they simply needed to try. So only a 404 (or having nothing to call at all) is "absent";
// every other failure renders the UI and lets the SEND report its own error, which it can do
// accurately and retryably. A seller who cannot see a reply form does not report a bug — they
// assume there was never a way to reply, and the broker just never hears back.
//
// Neither call throws. A rejected promise on this page is a spinner nobody can report.

import { feedbackUrl } from './token.js';
import { normalizeAllowance, normalizeResponse, normalizeResponses } from './feedback-model.js';

/**
 * @typedef {import('./feedback-model.js').Allowance} Allowance
 * @typedef {import('./feedback-model.js').FeedbackResponse} FeedbackResponse
 * @typedef {import('./feedback-model.js').Verdict} Verdict
 */

/**
 * @typedef {object} FeedbackStateOk
 * @property {true} ok
 * @property {FeedbackResponse[]} responses
 * @property {Allowance} allowance
 */

/**
 * @typedef {object} FeedbackStateMissing
 * @property {false} ok
 * @property {boolean} absent - True only when the ROUTE is not there (404, or nothing to
 *   call it with). False when the route answered and merely refused or failed. The reply UI
 *   keys its feature detection on this rather than on `ok`, because "the server does not
 *   have this feature" and "the server could not answer just now" want opposite answers:
 *   hide the channel forever vs. offer it and let the send report its own error.
 */

/** @typedef {FeedbackStateOk|FeedbackStateMissing} FeedbackState */

/**
 * @typedef {object} SendPayload
 * @property {string|null} roomKey
 * @property {Verdict} verdict
 * @property {string} note
 * @property {string} viewerLabel
 */

// The three send outcomes are spelled as separate typedefs rather than one inline union.
// That is not style: an inline multi-line union here type-checks but does not NARROW —
// `if (result.ok)` left the checker still offering the ok-branch's members afterwards, and
// the discriminated form is what makes `result.code` and `result.allowance` resolve.

/**
 * @typedef {object} SendOk
 * @property {true} ok
 * @property {FeedbackResponse|null} feedback - The server's echo of what it stored, when
 *   it sent one. Null means "keep the value you painted optimistically".
 * @property {Allowance} allowance
 */

/**
 * @typedef {object} SendFull
 * @property {false} ok
 * @property {'FULL'} code
 * @property {Allowance} allowance
 */

/**
 * @typedef {object} SendFailed
 * @property {false} ok
 * @property {'INVALID'|'ERROR'|'THROTTLED'} code
 */

/** @typedef {SendOk|SendFull|SendFailed} SendResult */

/**
 * Resolve the fetch to use. Returns null when there is none, which both callers treat as
 * "the feature is unavailable" rather than crashing the gallery around it.
 * @param {typeof fetch} [fetchImpl]
 * @returns {typeof fetch|null}
 */
function resolveFetch(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  return typeof fetch === 'function' ? fetch : null;
}

/**
 * Read a JSON body without ever throwing. An HTML error page, an empty 204 and a truncated
 * response all answer `{}` — the caller decides on the STATUS, and only reads the body for
 * detail it can do without.
 * @param {any} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
  if (!response || typeof response.json !== 'function') return {};
  try {
    const body = await response.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * What this link has already said. Also the probe that decides whether the reply UI renders
 * at all — see the header.
 *
 * @param {string} token
 * @param {typeof fetch} [fetchImpl] - Injected for tests; defaults to the global.
 * @returns {Promise<FeedbackState>}
 */
export async function fetchFeedback(token, fetchImpl) {
  const call = resolveFetch(fetchImpl);
  // Nothing to call with: indistinguishable from the feature not existing, and equally
  // unactionable, so it takes the same branch.
  if (!token || !call) return { ok: false, absent: true };

  let response;
  try {
    response = await call(feedbackUrl(token), {
      headers: { Accept: 'application/json' },
      // Anonymous, exactly like the manifest: this link gets forwarded to strangers and
      // must never carry the broker's session with it.
      credentials: 'omit',
    });
  } catch {
    // A thrown fetch is a transport failure, not a missing route — an old server without
    // this endpoint answers 404, it does not fail to connect. Offer the channel.
    return { ok: false, absent: false };
  }
  // 404 is THE feature-detection signal, and the only status that means the route is not
  // there; every other refusal (429 from the read limiter, a 5xx, a proxy hiccup) came FROM
  // the route, so the feature exists and hiding it would strand the seller.
  if (!response) return { ok: false, absent: false };
  if (!response.ok) return { ok: false, absent: Number(response.status) === 404 };

  const body = await readJson(response);
  return {
    ok: true,
    responses: normalizeResponses(body.responses),
    allowance: normalizeAllowance(body.allowance),
  };
}

/**
 * Record one answer.
 *
 * @param {string} token
 * @param {SendPayload} payload
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<SendResult>}
 */
export async function sendFeedback(token, payload, fetchImpl) {
  const call = resolveFetch(fetchImpl);
  if (!token || !call) return { ok: false, code: 'ERROR' };

  const body = {
    roomKey: payload.roomKey || null,
    verdict: payload.verdict,
    note: payload.note || '',
    viewerLabel: payload.viewerLabel || '',
  };

  let response;
  try {
    response = await call(feedbackUrl(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: 'ERROR' };
  }
  if (!response) return { ok: false, code: 'ERROR' };

  const parsed = await readJson(response);
  const status = Number(response.status) || 0;

  if (status === 409) {
    // The documented discriminator is the code, so it is honoured when present: a future
    // 409 that means something else must NOT be painted as "we already have your notes".
    // A 409 with no code at all is the ceiling — that is the only one the contract names.
    if (parsed.code && parsed.code !== 'FEEDBACK_FULL') return { ok: false, code: 'ERROR' };
    // `full: true` is forced, not read. THE STATUS IS THE AUTHORITY: a 409 FEEDBACK_FULL
    // means the ceiling has been reached, and the server does not always put an `allowance`
    // in the refusal body (routes/share-feedback.js sends `{ error, code }` and nothing
    // else). Trusting the body here would parse the absent field into `full: false` and
    // leave every panel still offering a form that is guaranteed to 409 again.
    return { ok: false, code: 'FULL', allowance: { ...normalizeAllowance(parsed.allowance), full: true } };
  }
  if (status === 400) return { ok: false, code: 'INVALID' };
  // 429 is separated from the generic failure because the ADVICE differs, and the generic
  // advice is actively wrong here: the panel's retry copy tells the seller to try again,
  // which is the one thing guaranteed to fail for the rest of the limiter's 15-minute
  // window. This is reachable by an honest seller, not just a flood — each room's verdict
  // is its own POST, so a long listing plus revisions (or two people on one household
  // connection) walks into RL_SHARE_FEEDBACK without anyone misbehaving.
  if (status === 429) return { ok: false, code: 'THROTTLED' };
  if (!response.ok) return { ok: false, code: 'ERROR' };

  return {
    ok: true,
    // The server is the authority on what it stored (it may have clamped the note), so the
    // panel repaints from the echo when there is one and keeps its optimistic value when
    // there is not.
    feedback: normalizeResponse(parsed.feedback),
    allowance: normalizeAllowance(parsed.allowance),
  };
}
