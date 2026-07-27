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
