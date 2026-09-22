// Model-selection helpers extracted verbatim from server.js. Pure — no deps.

// Helper function to get appropriate temperature for a model
// gpt-5-mini only supports temperature 1 (default), other models can use 0.7
export function getTemperatureForModel(model) {
  if (model && model.includes('gpt-5')) {
    return 1; // gpt-5-mini only supports default temperature (1)
  }
  return 0.7; // Default for other models
}

// The only two GPT models a request may select. `model` arrives from the client
// on every AI-Designer / staging / mask-edit call, and it is forwarded straight
// to OpenAI — so an unfiltered value lets a signed-in user bill an arbitrary
// (far more expensive) model to our API key. Resolve every client-supplied model
// through resolveChatModel below; never pass req.body.model to OpenAI directly.
export const FAST_MODEL = 'gpt-4o-mini';
export const PLUS_MODEL = 'gpt-5-mini';
const ALLOWED_MODELS = new Set([FAST_MODEL, PLUS_MODEL]);

// The admin console's analyst (lib/services/admin-analyst.js). Deliberately NOT a
// member of ALLOWED_MODELS above: that set exists to stop a CLIENT-SUPPLIED `model`
// field selecting an expensive model on the staging/chat routes, and nothing here
// reads one — this constant is chosen server-side, on one admin-gated endpoint,
// for a question the operator typed by hand. Adding it to the set would widen the
// billing guard on every other route to buy nothing.
//
// It is a stronger model than either of those on purpose. The analyst's job is to
// chain several tool calls and notice what it should ask next; the fast model
// answers such questions with a confident single hop, which is precisely the
// shallow output this surface was built to replace.
export const ANALYST_MODEL = process.env.ADMIN_ANALYST_MODEL || 'gpt-5';

/**
 * Whether a model bills its thinking against the completion budget.
 *
 * The gpt-5 family does: `max_completion_tokens` covers reasoning AND the visible
 * answer, so a budget sized for the answer alone returns `finish_reason: 'length'`
 * with empty content. Named rather than inlined because two separate decisions
 * hang off it — whether to send `reasoning_effort` at all, and how to size the
 * budget — and `ADMIN_ANALYST_MODEL` can point at a non-reasoning model.
 *
 * @param {unknown} model - A model id.
 * @returns {boolean} True when the id is a reasoning model.
 */
export function supportsReasoningEffort(model) {
  return Boolean(model && typeof model === 'string' && model.includes('gpt-5'));
}

/** Parse an env integer, falling back to `fallback` on anything unusable. */
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// The analyst's completion budget. It was 1600, which is ample for the four
// sentences the operator reads and nowhere near enough once gpt-5's reasoning is
// billed against the same number: a round carrying a tool result would spend the
// whole budget thinking and return an empty completion, which the drawer showed as
// "the model returned nothing". 6000 leaves ~5500 tokens of reasoning headroom
// above a typical 300-500 token answer.
//
// Env-tunable for the same reason ADMIN_ANALYST_MODEL is: how large a tool result
// gets depends on how much data a deployment has, and that knob should not need a
// redeploy.
export const ANALYST_MAX_OUTPUT_TOKENS = clampInt(process.env.ADMIN_ANALYST_MAX_TOKENS, 6000, 256, 32000);

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

// Low, not the implicit medium. One analyst turn is a narrow job — read tool
// results the browser already computed, pick the next tool, or write the answer —
// and the chaining that needs actual thought is spread across up to six browser
// round-trips (public/scripts/admin/analyst.js). Depth per turn buys little here
// and costs the visible budget.
//
// Null for a non-reasoning ADMIN_ANALYST_MODEL override: the key is then omitted
// from the request entirely rather than sent as undefined.
const ANALYST_EFFORT_ENV = process.env.ADMIN_ANALYST_REASONING_EFFORT ?? '';
/** @type {string|null} */
export const ANALYST_REASONING_EFFORT = supportsReasoningEffort(ANALYST_MODEL)
  ? (REASONING_EFFORTS.has(ANALYST_EFFORT_ENV) ? ANALYST_EFFORT_ENV : 'low')
  : null;

/**
 * Resolve a client-supplied model id to one we actually allow. Unknown values
 * fall back to the fast model rather than erroring — the client only ever sends
 * these two (public/scripts/ai-designer-model-selector.js), so anything else is
 * a tampered or stale request and degrading beats a 400.
 * @param {unknown} requestedModel - Raw `model` field off the request body.
 * @param {{ isPro?: boolean }} [options] - `isPro` false pins the fast model regardless of the request.
 * @returns {string} An allowed model id.
 */
export function resolveChatModel(requestedModel, { isPro = false } = {}) {
  if (!isPro) return FAST_MODEL;
  return typeof requestedModel === 'string' && ALLOWED_MODELS.has(requestedModel)
    ? requestedModel
    : FAST_MODEL;
}

// Helper function to map GPT model selection to Gemini image model
// Fast (gpt-4o-mini) → gemini-2.5-flash-image
// Pro/Stagify+ (gpt-5-mini) → gemini-3.1-flash-image (Nano Banana 2)
// Note: CAD floor-plan staging uses gemini-3-pro-image directly (see cad-handling.js)
export function getGeminiImageModel(gptModel) {
  if (gptModel && gptModel.includes('gpt-5')) {
    return 'gemini-3.1-flash-image'; // Stagify+ quality
  }
  return 'gemini-2.5-flash-image'; // Fast model (default)
}
