// Two-stage furniture removal (erase + GPT-vision verify/retry) and its pre/post
// checks. Factory injects the Gemini + OpenAI clients. Extracted verbatim from server.js.
import sharp from 'sharp';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { downscaleImage, enforceAspectRatio, orientedDimensions, resolveAspectRatioPin } from './image-primitives.js';
import { FURNITURE_ERASE_PROMPT, EMPTY_ROOM_CHECK_PROMPT } from '../staging/prompts.js';

/**
 * Build the two-stage furniture-removal API (erase + GPT-vision verify/retry)
 * bound to the injected AI clients. Every returned method degrades gracefully
 * when its required client is null.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, openai: import('openai').default | null }} deps - Injected AI clients; genAI (Gemini) drives erase generation, openai (GPT-vision) drives the empty-room checks. Either may be null when unconfigured. genAI is typed structurally (just the used `getGenerativeModel`) because the SDK's own `Part`/`GenerationConfig` types are stricter than the working verbatim call payloads.
 * @returns {{ roomIsAlreadyEmpty: (imageBuffer: Buffer) => Promise<boolean>, verifyRoomEmptied: (imageBuffer: Buffer, keepInstruction?: string) => Promise<{ empty: boolean, remaining: string }>, eraseFurniture: (imageBuffer: Buffer, req: import('express').Request, keepInstruction?: string) => Promise<import('../types/image.js').EraseResult | null>, buildKeepExceptionText: (keepInstruction: string) => string }} The two-stage furniture-removal API bound to the injected clients.
 */
export function createErase({ genAI, openai }) {
  const ERASE_MAX_ATTEMPTS = 3;
  const ERASE_MODEL = 'gemini-2.5-flash-image';

  /**
   * Pre-check whether the room is already empty before running an erase, using
   * gpt-4o-mini vision. Fails closed toward doing work — returns false when
   * openai is null or on any error, so the erase still proceeds.
   * @param {Buffer} imageBuffer - Room photo bytes to pre-check with gpt-4o-mini before running the erase.
   * @returns {Promise<boolean>} true only when the vision model replies EMPTY: true; false otherwise.
   */
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

  /**
   * Build the 'NARROW EXCEPTION' prompt-appendix clause naming user-specified
   * items to preserve during erase. Pure string builder; trims the instruction.
   * @param {string} keepInstruction - User-specified items to preserve during erase; may be empty/whitespace.
   * @returns {string} A 'NARROW EXCEPTION' clause naming the kept items, or '' when keepInstruction is empty/blank.
   */
  function buildKeepExceptionText(keepInstruction) {
    if (!keepInstruction || !keepInstruction.trim()) return '';
    return `\n\nNARROW EXCEPTION — keep ONLY these specific items, exactly where they are and unchanged: ${keepInstruction.trim()}.\nThis exception is strictly limited to the exact items named. Do NOT extend it to other items just because they are nearby, similar in type, look valuable, or seem related. For example, if told to keep paintings, you keep ONLY the paintings — you still remove every cabinet, sofa, table, chair, shelf, rug, and all other furniture and decor. Everything not explicitly named in this exception MUST still be removed in full, exactly as instructed above.`;
  }

  /**
   * Inspect a post-erase image via gpt-4o-mini vision, answering TWO questions in one call:
   * did the erase remove enough, and did it destroy the room doing it?
   *
   * The second question is why `sourceBuffer` exists. This check used to instruct the
   * reviewer to "Ignore the room's own walls, floor, ceiling, windows, doors, trim" — so
   * the only failure it could ever report was UNDER-removal, and the retry ladder built on
   * top of it only ever pushed harder ("you MUST now remove completely…"). An erase that
   * took a window out with the curtains was invisible to it, scored as a success, and the
   * result was then handed to a second full generative pass. Both directions are graded now.
   *
   * Both halves fail OPEN (empty + intact) when openai is null or on error, so a flaky
   * reviewer never blocks an erase — same contract as before.
   *
   * @param {Buffer} imageBuffer - Post-erase image bytes to inspect.
   * @param {string} [keepInstruction] - Items allowed to remain; anything else counts as a leftover. Defaults to ''.
   * @param {Buffer | null} [sourceBuffer] - The ORIGINAL room photo. Supply it to enable the architecture check; without it `intact` is always true, because there is nothing to compare against.
   * @returns {Promise<{ empty: boolean, remaining: string, intact: boolean, damage: string }>} `empty`/`remaining` describe leftover furniture; `intact`/`damage` describe whether the room's own architecture survived.
   */
  async function verifyRoomEmptied(imageBuffer, keepInstruction = '', sourceBuffer = null) {
    if (!openai) return { empty: true, remaining: '', intact: true, damage: '' };
    try {
      const processed = await downscaleImage(imageBuffer);
      const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
      let sourceUrl = null;
      if (sourceBuffer) {
        try {
          sourceUrl = `data:image/jpeg;base64,${(await downscaleImage(sourceBuffer)).toString('base64')}`;
        } catch { /* no source → the architecture half degrades to "assume intact" below */ }
      }
      const keep = keepInstruction && keepInstruction.trim();
      let instruction = sourceUrl
        ? `You are comparing two photos of the SAME interior room. The FIRST is the original. The SECOND is after an edit that was supposed to remove ALL furniture, decor, rugs, curtains, wall art, plants, lamps, and movable objects, leaving an empty unfurnished room with the room ITSELF untouched.`
        : `You are inspecting an interior room photo that was supposed to have ALL furniture, decor, rugs, curtains, wall art, plants, lamps, and movable objects removed, leaving an empty unfurnished room.`;
      if (keep) {
        instruction += `\nThe ONLY items allowed to remain are exactly these: ${keepInstruction.trim()}. Anything else (including chairs, cabinets, sofas, tables, shelves, rugs, and all other furniture/decor) is a leftover that should have been removed.`;
      } else {
        instruction += `\nNo furniture or decor at all should remain.`;
      }
      instruction += `\n\nQUESTION 1 — LEFTOVERS. Ignore the room's own walls, floor, ceiling, windows, doors, trim, and permanently built-in structural fixtures${keep ? ', and ignore the allowed items listed above' : ''}. List every other leftover furniture/decor/movable item you can still see${sourceUrl ? ' in the SECOND photo' : ''}.\nReply on ONE line in EXACTLY this format: "CLEAN: true" if nothing remains, or "CLEAN: false | <comma-separated leftover items>" if items remain.`;
      if (sourceUrl) {
        // The count is the question, not "does it look similar". A vision model answers a
        // count reliably; holistic similarity it does not. And an empty room legitimately
        // looks very different from a furnished one, so anything vaguer than this produces
        // a false "damaged" on every successful erase.
        instruction += `\n\nQUESTION 2 — DID THE ROOM SURVIVE? Removing furniture is EXPECTED and is never damage. Compare the ROOM ITSELF between the two photos: the number, position and size of windows, doors and wall openings; the walls, ceiling, floor, room shape, built-in cabinetry, counters, fireplace, radiators, stairs, columns, beams and trim; and the camera angle. A window or door that has been covered over, filled in, shrunk, enlarged, moved or deleted is DAMAGE. So is a removed fireplace, radiator, staircase or built-in. A wall that is merely now visible because the furniture in front of it is gone is NOT damage.\nReply on a SECOND line in EXACTLY this format: "ROOM: intact" or "ROOM: damaged | <what was destroyed>".`;
      }
      instruction += `\nOutput nothing else.`;
      /** @type {any[]} */
      const content = [{ type: 'text', text: instruction }];
      if (sourceUrl) content.push({ type: 'image_url', image_url: { url: sourceUrl } });
      content.push({ type: 'image_url', image_url: { url: dataUrl } });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content }],
        temperature: 0,
        // Two verdict lines plus their detail lists need more room than one did; a
        // truncated second line reads as "no damage" and silently restores the old blindness.
        max_tokens: sourceUrl ? 160 : 80,
      });
      const raw = (completion.choices[0].message.content || '').trim();

      // Split the two verdicts BEFORE parsing: both use ' | ' as their detail separator, so
      // parsing the whole reply as one line would fold the damage list into `remaining`.
      const cleanLine = raw.split('\n').find((l) => /CLEAN:/i.test(l)) || raw;
      const roomLine = raw.split('\n').find((l) => /ROOM:/i.test(l)) || '';
      const detail = (line) => {
        const parts = line.split('|');
        return parts.length > 1 ? parts.slice(1).join('|').trim() : '';
      };
      const empty = /CLEAN:\s*true/i.test(cleanLine);
      // No source, or no parseable ROOM line → intact. Fail open: a missing verdict must
      // not throw away an otherwise good erase.
      const intact = !sourceUrl || !/ROOM:\s*damaged/i.test(roomLine);
      return {
        empty,
        remaining: empty ? '' : detail(cleanLine),
        intact,
        damage: intact ? '' : detail(roomLine),
      };
    } catch (error) {
      logger.error('[Erase] verification failed, accepting current erase:', error.message);
      return { empty: true, remaining: '', intact: true, damage: '' };
    }
  }

  /**
   * Empty a room photo of furniture via up to ERASE_MAX_ATTEMPTS Gemini passes,
   * each verified by verifyRoomEmptied and retried with an escalating extraNote;
   * keeps the latest/best buffer and locks output to the source aspect ratio.
   * @param {Buffer} imageBuffer - Source room photo (from req.files.image[0].buffer) to empty of furniture.
   * @param {import('express').Request} req - Express request — passed by the caller but currently unused in the body (vestigial).
   * @param {string} [keepInstruction] - Items to preserve; caller trims and slices to 500 chars. Defaults to ''.
   * @returns {Promise<import('../types/image.js').EraseResult | null>} The emptied room as a PNG data URL plus its Buffer, or null when erase could not run/succeed.
   */
  async function eraseFurniture(imageBuffer, req, keepInstruction = '') {
    if (!genAI) return null;
    try {
      const processedImageBuffer = await downscaleImage(imageBuffer);
      const base64Image = processedImageBuffer.toString('base64');
      // Visual (EXIF-oriented) dims: the emptied room is locked back to this ratio, and
      // downscaleImage already baked orientation into base64Image, so raw metadata dims
      // (swapped for rotated photos) would target the wrong ratio.
      const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
      const srcDims = orientedDimensions(srcMeta);
      // Only pins when a supported bucket actually FITS the source — see
      // resolveAspectRatioPin. An erase asked to reshape the photo by 7% has to invent or
      // discard frame edges, which is where a window turns into wall.
      const arPin = srcDims ? resolveAspectRatioPin(srcDims.width, srcDims.height) : null;
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

      // How good an attempt is, as one comparable number. An INTACT room outranks an empty
      // one on purpose: a room that still has a chair in it can be staged around; a room
      // whose window has been bricked up is unusable at any level of emptiness, and it is
      // about to be handed to a second generative pass that will bake the damage in.
      const scoreAttempt = (check) => (check.intact ? 2 : 0) + (check.empty ? 1 : 0);
      const PERFECT_SCORE = 3; // intact AND empty — nothing to gain from another attempt

      /** @type {{ buffer: Buffer, score: number } | null} */
      let best = null;
      let extraNote = '';
      for (let attempt = 1; attempt <= ERASE_MAX_ATTEMPTS; attempt++) {
        const isFinal = attempt === ERASE_MAX_ATTEMPTS;
        if (DEBUG_MODE) {
          logger.debug(`[Erase] attempt ${attempt}/${ERASE_MAX_ATTEMPTS} on ${ERASE_MODEL}`);
        }

        let outBuffer;
        try {
          const model = genAI.getGenerativeModel({
            model: ERASE_MODEL,
            // Pin the output shape, exactly as processStaging does. Without it this pass
            // relied solely on enforceAspectRatio below, which corrects by STRETCHING —
            // so a drifted erase reached staging with the room's proportions already
            // distorted, and the next pass reconstructed architecture from that.
            ...(arPin ? { generationConfig: { imageConfig: { aspectRatio: arPin.label } } } : {}),
          });
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
          if (best) break; // keep the best earlier result
          if (isFinal) return null;
          continue;
        }

        // Lock the emptied room to the source aspect ratio before staging/verification.
        if (srcDims) {
          outBuffer = await enforceAspectRatio(outBuffer, srcDims.width, srcDims.height);
        }

        // The final attempt is still verified, where it never used to be. Skipping the
        // check there was what made "last attempt wins" so damaging: attempt 3 could brick
        // up a window and ship unexamined, beating a perfectly good attempt 1.
        const check = await verifyRoomEmptied(outBuffer, keepInstruction, imageBuffer);
        const score = scoreAttempt(check);

        // Strictly greater, so an EARLIER attempt wins a tie. Each pass is another full
        // re-synthesis and another roll of the dice on the room's architecture, so when two
        // attempts are equally good the one that has been regenerated less is the safer one.
        if (!best || score > best.score) best = { buffer: outBuffer, score };

        if (score === PERFECT_SCORE) {
          if (DEBUG_MODE) logger.debug(`[Erase] verified clean and intact on attempt ${attempt}`);
          break;
        }
        if (isFinal) break;

        if (!check.intact) {
          // Do NOT escalate. The removal instruction is already being followed too
          // enthusiastically — repeating "you MUST remove more" is what walks a room from
          // "one chair left" to "no window". Pull the next attempt back instead.
          if (DEBUG_MODE) {
            logger.debug(`[Erase] attempt ${attempt} damaged the room (${check.damage || 'unspecified'}) — retrying more conservatively`);
          }
          extraNote = `IMPORTANT: A previous attempt went TOO FAR — it altered the room itself: ${check.damage || 'architecture was changed'}. The room is a real property and must survive exactly: keep every window, door, wall opening, wall, ceiling, floor, built-in and fixture precisely as it appears in the photo, with the same number, positions and sizes. Remove ONLY furniture, decor and movable objects, and where you remove something, rebuild what was behind it to match the surrounding wall and floor. If you cannot tell whether something is furniture or part of the room, LEAVE IT.`;
          continue;
        }

        if (DEBUG_MODE) {
          logger.debug(`[Erase] attempt ${attempt} left items behind: ${check.remaining || 'unspecified'} — retrying`);
        }
        extraNote = `IMPORTANT: A previous removal attempt FAILED — it left these items in the room that you MUST now remove completely: ${check.remaining || 'all remaining furniture and decor'}. Erase them entirely and realistically reconstruct the floor and wall behind them. Do NOT touch the room itself while doing so — every window, door, wall opening and built-in stays exactly as it is.`;
        if (keepInstruction && keepInstruction.trim()) {
          extraNote += ` Still keep ONLY: ${keepInstruction.trim()} — remove everything else, including the leftover items just listed.`;
        }
      }

      if (!best) return null;
      const bestBuffer = best.buffer;
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
