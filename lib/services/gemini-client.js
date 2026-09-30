// Gemini client on the current SDK (@google/genai), behind the call shape the rest of
// the codebase was written against (the deprecated @google/generative-ai):
//
//   genAI.getGenerativeModel({ model, generationConfig }).generateContent(parts)
//     → { response: { candidates, promptFeedback, usageMetadata, text() } }
//
// Keeping that shape is deliberate. Every call site and the test fakes in
// test/helpers/fake-ai.js all speak it, and every field they use maps 1:1 onto the new
// SDK: `generationConfig` (seed, temperature, maxOutputTokens, thinkingConfig,
// imageConfig) is the new flat `config`, and a Part[] is a valid `contents`.
import { GoogleGenAI } from '@google/genai';

/**
 * @typedef {{ candidates?: any[], promptFeedback?: any, usageMetadata?: any, text: () => string }} GeminiResponse
 * @typedef {{ generateContent: (contents: any) => Promise<{ response: GeminiResponse }> }} GeminiModel
 * @typedef {{ getGenerativeModel: (options: { model: string, generationConfig?: Record<string, unknown> }) => GeminiModel }} GeminiClient
 */

/**
 * @param {string} apiKey - Gemini API key.
 * @param {{ timeoutMs: number, attempts: number, fetch?: typeof globalThis.fetch }} http -
 *   Per-request timeout, total attempts (1 = no retry) for the SDK's own retry on
 *   429/5xx, and an optional fetch override (tests only).
 * @returns {GeminiClient} The adapter.
 */
export function createGeminiClient(apiKey, { timeoutMs, attempts, fetch }) {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts }, ...(fetch ? { fetch } : {}) },
  });

  return {
    getGenerativeModel({ model, generationConfig }) {
      return {
        async generateContent(contents) {
          const res = await ai.models.generateContent({ model, contents, config: generationConfig });
          return {
            response: {
              candidates: res.candidates,
              promptFeedback: res.promptFeedback,
              usageMetadata: res.usageMetadata,
              // The old SDK's text() threw on a blocked prompt; every caller already
              // guards with `|| ''`, so an empty string is the safe equivalent.
              text: () => res.text ?? '',
            },
          };
        },
      };
    },
  };
}
