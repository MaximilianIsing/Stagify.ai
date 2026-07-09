// Two-stage furniture removal (erase + GPT-vision verify/retry) and its pre/post
// checks. Factory injects the Gemini + OpenAI clients. Extracted verbatim from server.js.
import sharp from 'sharp';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { downscaleImage, enforceAspectRatio } from './image-primitives.js';
import { FURNITURE_ERASE_PROMPT, EMPTY_ROOM_CHECK_PROMPT } from '../staging/prompts.js';

export function createErase({ genAI, openai }) {
  const ERASE_MAX_ATTEMPTS = 3;
  const ERASE_MODEL = 'gemini-2.5-flash-image';

  async function roomIsAlreadyEmpty(imageBuffer) {
    if (!openai) return false;
    try {
      const processed = await downscaleImage(imageBuffer);
      const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: EMPTY_ROOM_CHECK_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 10,
      });
      const raw = (completion.choices[0].message.content || '').trim();
      return /EMPTY:\s*true/i.test(raw);
    } catch (error) {
      logger.error('[Erase] empty-room pre-check failed, proceeding with erase:', error.message);
      return false;
    }
  }

  function buildKeepExceptionText(keepInstruction) {
    if (!keepInstruction || !keepInstruction.trim()) return '';
    return `\n\nNARROW EXCEPTION — keep ONLY these specific items, exactly where they are and unchanged: ${keepInstruction.trim()}.\nThis exception is strictly limited to the exact items named. Do NOT extend it to other items just because they are nearby, similar in type, look valuable, or seem related. For example, if told to keep paintings, you keep ONLY the paintings — you still remove every cabinet, sofa, table, chair, shelf, rug, and all other furniture and decor. Everything not explicitly named in this exception MUST still be removed in full, exactly as instructed above.`;
  }

  async function verifyRoomEmptied(imageBuffer, keepInstruction = '') {
    if (!openai) return { empty: true, remaining: '' };
    try {
      const processed = await downscaleImage(imageBuffer);
      const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
      const keep = keepInstruction && keepInstruction.trim();
      let instruction = `You are inspecting an interior room photo that was supposed to have ALL furniture, decor, rugs, curtains, wall art, plants, lamps, and movable objects removed, leaving an empty unfurnished room.`;
      if (keep) {
        instruction += `\nThe ONLY items allowed to remain are exactly these: ${keepInstruction.trim()}. Anything else (including chairs, cabinets, sofas, tables, shelves, rugs, and all other furniture/decor) is a leftover that should have been removed.`;
      } else {
        instruction += `\nNo furniture or decor at all should remain.`;
      }
      instruction += `\nIgnore the room's own walls, floor, ceiling, windows, doors, trim, and permanently built-in structural fixtures${keep ? ', and ignore the allowed items listed above' : ''}. List every other leftover furniture/decor/movable item you can still see.\nReply on ONE line in EXACTLY this format: "CLEAN: true" if nothing remains, or "CLEAN: false | <comma-separated leftover items>" if items remain. Output nothing else.`;
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 80,
      });
      const raw = (completion.choices[0].message.content || '').trim();
      if (/CLEAN:\s*true/i.test(raw)) return { empty: true, remaining: '' };
      const parts = raw.split('|');
      const remaining = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
      return { empty: false, remaining };
    } catch (error) {
      logger.error('[Erase] verification failed, accepting current erase:', error.message);
      return { empty: true, remaining: '' };
    }
  }

  async function eraseFurniture(imageBuffer, req, keepInstruction = '') {
    if (!genAI) return null;
    try {
      const processedImageBuffer = await downscaleImage(imageBuffer);
      const base64Image = processedImageBuffer.toString('base64');
      const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
      const keepText = buildKeepExceptionText(keepInstruction);
      if (keepText && DEBUG_MODE) {
        logger.debug(`[Erase] keeping user-specified items: ${keepInstruction.trim()}`);
      }

      const buildPrompt = (extraNote) => {
        let eraseText = FURNITURE_ERASE_PROMPT + keepText;
        if (extraNote) eraseText += `\n\n${extraNote}`;
        return [
          { text: eraseText },
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        ];
      };

      let bestBuffer = null;
      let extraNote = '';
      for (let attempt = 1; attempt <= ERASE_MAX_ATTEMPTS; attempt++) {
        const isFinal = attempt === ERASE_MAX_ATTEMPTS;
        if (DEBUG_MODE) {
          logger.debug(`[Erase] attempt ${attempt}/${ERASE_MAX_ATTEMPTS} on ${ERASE_MODEL}`);
        }

        let outBuffer;
        try {
          const model = genAI.getGenerativeModel({ model: ERASE_MODEL });
          const result = await model.generateContent(buildPrompt(extraNote));
          const response = await result.response;
          if (!response || !response.candidates || response.candidates.length === 0) {
            throw new Error('no candidates in erase response');
          }
          const part = response.candidates[0].content.parts.find((p) => p.inlineData);
          if (!part) throw new Error('no image data in erase response');
          outBuffer = Buffer.from(part.inlineData.data, 'base64');
        } catch (genErr) {
          logger.error(`[Erase] attempt ${attempt} generation failed:`, genErr.message);
          if (bestBuffer) break; // keep the best earlier result
          if (isFinal) return null;
          continue;
        }

        // Lock the emptied room to the source aspect ratio before staging/verification.
        if (srcMeta && srcMeta.width && srcMeta.height) {
          outBuffer = await enforceAspectRatio(outBuffer, srcMeta.width, srcMeta.height);
        }
        bestBuffer = outBuffer; // latest attempt is our current best

        if (isFinal) break; // no retry after the last attempt — take it

        const check = await verifyRoomEmptied(outBuffer, keepInstruction);
        if (check.empty) {
          if (DEBUG_MODE) logger.debug(`[Erase] verified clean on attempt ${attempt}`);
          break;
        }
        if (DEBUG_MODE) {
          logger.debug(`[Erase] attempt ${attempt} left items behind: ${check.remaining || 'unspecified'} — retrying`);
        }
        extraNote = `IMPORTANT: A previous removal attempt FAILED — it left these items in the room that you MUST now remove completely: ${check.remaining || 'all remaining furniture and decor'}. Erase them entirely and realistically reconstruct the floor and wall behind them.`;
        if (keepInstruction && keepInstruction.trim()) {
          extraNote += ` Still keep ONLY: ${keepInstruction.trim()} — remove everything else, including the leftover items just listed.`;
        }
      }

      if (!bestBuffer) return null;
      return {
        dataUrl: `data:image/png;base64,${bestBuffer.toString('base64')}`,
        buffer: bestBuffer,
      };
    } catch (error) {
      logger.error('[Erase] furniture removal failed, falling back to single-pass staging:', error.message);
      return null;
    }
  }

  return { roomIsAlreadyEmpty, verifyRoomEmptied, eraseFurniture, buildKeepExceptionText };
}
