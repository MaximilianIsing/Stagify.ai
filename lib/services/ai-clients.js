// AI/email client initialization, extracted from server.js. Each client is created
// once at boot from an env var (Render) or a local *-key.txt fallback (dev). The
// factory injects __dirname (to resolve the key files) and DEBUG_MODE (logging).
// Behavior is preserved verbatim from the original inline blocks — including which
// clients construct on a missing/empty key and the exact log messages.
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { Resend } from 'resend';
import { logger } from '../logger.js';

export function createAiClients({ __dirname, DEBUG_MODE }) {
  // Read a local key file if it exists; returns the trimmed contents or undefined.
  // (genAI deliberately does NOT use this — see its note below.)
  const readKeyFile = (fileName) => {
    const keyFile = path.join(__dirname, fileName);
    return fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : undefined;
  };

  // Initialize Google AI (for image processing)
  let genAI;
  try {
    // Try environment variable first (Render), then fall back to local file
    let apiKey = process.env.GOOGLE_AI_API_KEY;
    if (apiKey === undefined) {
      if (DEBUG_MODE) {
        logger.debug('GOOGLE_AI_API_KEY is not set in an enviorment variable, using local file');
      }
      // Read directly (no existsSync): a missing key.txt throws and is caught below,
      // leaving genAI undefined — the original behavior.
      apiKey = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
    }
    // Guard on a NON-EMPTY key, matching the openai/resend branches below. The SDK
    // happily constructs from '' and returns a truthy client that 400s on every call,
    // so without this an empty key reads as "configured" to every `if (!genAI)` guard
    // in the codebase and turns a clean no-op into failing network round-trips.
    if (apiKey) {
      genAI = new GoogleGenerativeAI(apiKey);
      if (DEBUG_MODE) {
        logger.debug('Google AI API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: Google AI key is empty, image features will not be available');
    }
  } catch (error) {
    logger.error('Error initializing Google AI:', error.message);
  }

  // Initialize OpenAI GPT (for chat)
  let openai;
  try {
    // Try environment variable first (Render), then fall back to local file
    let gptApiKey = process.env.GPT_KEY;
    if (gptApiKey === undefined) {
      if (DEBUG_MODE) {
        logger.debug('GPT_KEY is not set in an environment variable, using local file');
      }
      gptApiKey = readKeyFile('gpt-key.txt');
    }
    if (gptApiKey) {
      openai = new OpenAI({ apiKey: gptApiKey });
      if (DEBUG_MODE) {
        logger.debug('OpenAI API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: GPT key file is empty, chat features may not work');
    }
  } catch (error) {
    logger.error('Error initializing OpenAI:', error.message);
    logger.info('Chat features will not be available');
  }

  // Initialize Resend (for email sending)
  let resend;
  try {
    // Try environment variable first (Render), then fall back to local file
    let resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey === undefined) {
      if (DEBUG_MODE) {
        logger.debug('RESEND_API_KEY is not set in an environment variable, using local file');
      }
      resendApiKey = readKeyFile('resendkey.txt');
    }
    if (resendApiKey) {
      resend = new Resend(resendApiKey);
      if (DEBUG_MODE) {
        logger.debug('Resend API key successfully loaded');
      }
    } else if (DEBUG_MODE) {
      logger.debug('Warning: Resend key not found, email features will not be available');
    }
  } catch (error) {
    logger.error('Error initializing Resend:', error.message);
    logger.info('Email features will not be available');
  }

  // Normalize "absent" to null (not undefined): every consumer gates on
  // `if (!client)`, and null is the single spelling their dep typedefs use.
  return { genAI: genAI ?? null, openai: openai ?? null, resend: resend ?? null };
}
