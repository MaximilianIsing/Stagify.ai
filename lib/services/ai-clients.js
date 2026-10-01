// AI/email client initialization. Each client is created once at boot from its env var
// (Render, or .env locally via load-env.js); no key has a file fallback. The factory
// injects DEBUG_MODE (logging).
import OpenAI from 'openai';
import { Resend } from 'resend';
import { logger } from '../logger.js';
import { createGeminiClient } from './gemini-client.js';
import { errorMessage } from '../errors.js';

/**
 * Parse an env integer, falling back to `fallback` on anything unusable.
 * @param {unknown} raw @param {number} fallback @param {number} min @param {number} max
 * @returns {number}
 */
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Per-request ceilings. Without them both SDKs wait on a stalled connection far past
// the point a user has given up: OpenAI's default is 10 minutes, and @google/genai's
// default retry makes 5 attempts with up to 60s backoff. A normal Gemini image render
// takes ~57s, so 120s leaves headroom for a slow one. Gemini gets one retry, not four:
// the staging quality gate (lib/staging/staging-pipeline.js) already re-rolls a bad
// render, so SDK retries stacked beneath it multiply worst-case latency without
// improving output. OpenAI keeps its default two retries; its calls are short.
// Env-tunable so a latency regression upstream does not need a redeploy.
export const GEMINI_TIMEOUT_MS = clampInt(process.env.GEMINI_TIMEOUT_MS, 120_000, 5_000, 600_000);
export const OPENAI_TIMEOUT_MS = clampInt(process.env.OPENAI_TIMEOUT_MS, 90_000, 5_000, 600_000);
const GEMINI_ATTEMPTS = 2;

/** @param {{ DEBUG_MODE: boolean }} deps */
export function createAiClients({ DEBUG_MODE }) {

  // Initialize Google AI (for image processing)
  let genAI;
  try {
    // Env only. The key.txt fallback was removed: it held a revoked key long after
    // .env had the live one, which is exactly the silent failure a fallback invites.
    const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
    // Guard on a NON-EMPTY key, matching the openai/resend branches below. The SDK
    // happily constructs from '' and returns a truthy client that 400s on every call,
    // so without this an empty key reads as "configured" to every `if (!genAI)` guard
    // in the codebase and turns a clean no-op into failing network round-trips.
    if (apiKey) {
      genAI = createGeminiClient(apiKey, { timeoutMs: GEMINI_TIMEOUT_MS, attempts: GEMINI_ATTEMPTS });
      if (DEBUG_MODE) {
        logger.debug('Google AI API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: GOOGLE_AI_API_KEY is not set, image features will not be available');
    }
  } catch (error) {
    logger.error('Error initializing Google AI:', errorMessage(error));
  }

  // Initialize OpenAI GPT (for chat)
  let openai;
  try {
    // Env only, like GOOGLE_AI_API_KEY above.
    const gptApiKey = process.env.GPT_KEY?.trim();
    if (gptApiKey) {
      openai = new OpenAI({ apiKey: gptApiKey, timeout: OPENAI_TIMEOUT_MS });
      if (DEBUG_MODE) {
        logger.debug('OpenAI API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: GPT_KEY is not set, chat features may not work');
    }
  } catch (error) {
    logger.error('Error initializing OpenAI:', errorMessage(error));
    logger.info('Chat features will not be available');
  }

  // Initialize Resend (for email sending)
  let resend;
  try {
    // Env only, like the Gemini and OpenAI keys above.
    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    if (resendApiKey) {
      resend = new Resend(resendApiKey);
      if (DEBUG_MODE) {
        logger.debug('Resend API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: Resend key not found, email features will not be available');
    }
  } catch (error) {
    logger.error('Error initializing Resend:', errorMessage(error));
    logger.info('Email features will not be available');
  }

  // Normalize "absent" to null (not undefined): every consumer gates on
  // `if (!client)`, and null is the single spelling their dep typedefs use.
  return { genAI: genAI ?? null, openai: openai ?? null, resend: resend ?? null };
}
