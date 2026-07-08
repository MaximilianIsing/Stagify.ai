// Model-selection helpers extracted verbatim from server.js. Pure — no deps.

// Helper function to get appropriate temperature for a model
// gpt-5-mini only supports temperature 1 (default), other models can use 0.7
export function getTemperatureForModel(model) {
  if (model && model.includes('gpt-5')) {
    return 1; // gpt-5-mini only supports default temperature (1)
  }
  return 0.7; // Default for other models
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
