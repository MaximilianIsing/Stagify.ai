// Drives the real product. This is the reason the tool lives inside the repo rather than
// in a folder of its own: a post about virtual staging should contain actual Stagify
// output, not a lookalike made in a different pipeline.
//
// Replicates the composition root from server.js, with two deliberate substitutions:
//   * logPromptToFile is a no-op. The real one appends a row to prompt_logs.csv, which is
//     product telemetry. A marketing render is not a customer render and must not pollute it.
//   * req is null. processStaging only ever reads req?.body?.… and increments counters on
//     it, all optionally chained, so a null request is a supported shape.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import '../../../load-env.js';
import { createAiClients } from '../../../lib/services/ai-clients.js';
import { createImageReview } from '../../../lib/image/image-review.js';
import { createImageAnnotation } from '../../../lib/image/image-annotation.js';
import { generateWithQualityRetry as runQualityRetry } from '../../../lib/staging/staging-pipeline.js';
import { createStagingGeneration } from '../../../lib/staging/staging-generation.js';
import { createMaskEditHandler } from '../../../lib/staging/mask-edit.js';
import { maskReferencePromptSuffix } from '../../../lib/staging/prompts.js';
import {
  downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage,
  normalizeMaskOutputToRoom, compositeForReview,
} from '../../../lib/image/image-primitives.js';
import { FAST_MODEL } from '../../../lib/config/model-config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A `data:image/xxx;base64,...` string to raw bytes. */
export function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl));
  if (!match) throw new Error('Expected a base64 data URL from the staging pipeline.');
  return { buffer: Buffer.from(match[2], 'base64'), mime: match[1] };
}

/**
 * Is every pixel outside the brushed area byte-identical to the source photograph?
 *
 * The whole argument of a Masking Studio post is "only the region I painted changed",
 * and that is a claim about pixels, not a claim about intent. compositeForReview is
 * believed to guarantee it, but it is also allowed to fail soft, and a headline that
 * says "only" has to be checked rather than assumed.
 *
 * Mask edge pixels are excluded: the mask is resized with `fit: 'fill'`, which
 * interpolates, so the one-pixel boundary is a legitimate blend of both images and
 * would fail an exact comparison without anything being wrong.
 * @param {{ originalBuffer: Buffer, resultBuffer: Buffer, maskBuffer: Buffer, width: number, height: number }} o
 * @returns {Promise<boolean>} True when the unbrushed area is unchanged.
 */
async function regionOutsideMaskIsIdentical({ originalBuffer, resultBuffer, maskBuffer, width, height }) {
  const raw = (buf) => sharp(buf).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [before, after, mask] = await Promise.all([
    raw(originalBuffer),
    raw(resultBuffer),
    sharp(maskBuffer).resize(width, height, { fit: 'fill' }).extractChannel(0).raw().toBuffer(),
  ]);

  for (let i = 0; i < width * height; i += 1) {
    if (mask[i] !== 0) continue;              // inside the brush, or on its blended edge
    const p = i * 3;
    if (before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]) {
      return false;
    }
  }
  return true;
}

/**
 * @param {{ debug?: boolean, config: object }} options
 */
export function createStagifyImages({ debug = false, config }) {
  // DEBUG_MODE false on purpose: this is a local tool and the server's debug plumbing
  // (debug.txt, LOG_LEVEL) is not its concern.
  const { genAI, openai } = createAiClients({ __dirname: REPO_ROOT, DEBUG_MODE: debug });
  const {
    reviewImageQuality, reviewMaskEdit, validateStageableImage, validateExteriorImage,
  } = createImageReview({ genAI });
  const { annotateImage } = openai ? createImageAnnotation({ openai }) : { annotateImage: null };

  // Capture every QA verdict so the caller can see whether the delivered image actually
  // passed review.
  //
  // Needed because of a real difference in stakes. generateWithQualityRetry returns the
  // best-scoring attempt once it runs out of retries, even if none were perfect, and
  // onReviewDegraded only fires when the reviewer itself is unavailable. For a customer
  // that is the right call: a slightly imperfect render beats an error. For a post it is
  // not, because the image is a public advertisement for the thing being judged, and a
  // chair with an extra leg is exactly what a competitor screenshots.
  //
  // Wrapping the injected reviewer is enough; no product code changes.
  /** @type {Array<{ perfect: boolean, score: number, reason?: string }>} */
  let verdicts = [];
  const recordingReview = async (...args) => {
    const review = await reviewImageQuality(...args);
    verdicts.push(review);
    return review;
  };

  // Second recorder, kept separate from `verdicts`. The mask reviewer is a different
  // rubric (reviewMaskEdit also rejects an edit that stripped out too much), so folding
  // its scores into the staging buffer would make quality.bestScore mean two things.
  /** @type {Array<{ perfect: boolean, score: number, reason?: string }>} */
  let maskVerdicts = [];
  const recordingMaskReview = async (...args) => {
    const review = await reviewMaskEdit(...args);
    maskVerdicts.push(review);
    return review;
  };

  const { processStaging, processImageGeneration, generateWithQualityRetry } = createStagingGeneration({
    genAI,
    DEBUG_MODE: debug,
    runQualityRetry,
    reviewImageQuality: recordingReview,
    QUALITY_MAX_ATTEMPTS: config.models.qualityMaxAttempts,
    logPromptToFile: () => {},
  });

  const available = { gemini: Boolean(genAI), openai: Boolean(openai) };

  function requireGemini(what) {
    if (!genAI) {
      throw new Error(`${what} needs GOOGLE_AI_API_KEY (or key.txt at the repo root). It is not set.`);
    }
  }

  return {
    available,

    /**
     * Stage a real room photo. Quality first by decision: the full retry loop, the better
     * model, never skipQualityReview. The image IS the product demo, so a weak render is
     * worse than no post.
     * `reviewBasePrompt` swaps the QA rubric. The default one opens with "AI-generated
     * interior real-estate photos" and grades against warped furniture and extra legs, so
     * pointed at a facade it marks a correct render down for having no chairs in it. The
     * exterior path passes EXTERIOR_REVIEW_PROMPT. Note that the product's own exterior
     * route sets skipQualityReview because a second roll gives the customer a different sky
     * rather than a better one; a post keeps the loop on, because rule 3 is about the
     * advertisement and not about the wait.
     * `furnitureBuffers` is the product's furniture-reference channel: up to five photos of
     * furniture the customer already owns, which processStaging letterboxes and appends to
     * the prompt so the render contains those actual pieces. Null everywhere else, because
     * a normal post is staged from presets and passing references would quietly change what
     * the "after" is proving.
     * `stampStyle` and `stampScale` are the badge controls the staging panel gives a
     * customer: one of the four looks in lib/image/stamp-disclosure.js, and a size
     * multiplier between 0.7 and 1.6. Undefined everywhere except a post whose SUBJECT is
     * the badge, where the frame has to show it at a size Instagram's compression survives.
     * They are ignored unless labelVirtuallyStaged is on, and processStaging normalises
     * both, so a wrong value degrades to the default rather than failing the render.
     * @param {{ sourceBuffer: Buffer, roomType: string, furnitureStyle?: string,
     *           additionalPrompt?: string, removeFurniture?: boolean, promptOverride?: string,
     *           labelVirtuallyStaged?: boolean, stampStyle?: string, stampScale?: number,
     *           model?: string, reviewBasePrompt?: string,
     *           furnitureBuffers?: Buffer[]|null }} o
     */
    async stage({
      sourceBuffer, roomType, furnitureStyle, additionalPrompt,
      removeFurniture = false, promptOverride, labelVirtuallyStaged = false,
      stampStyle, stampScale,
      model = config.models.staging, reviewBasePrompt, furnitureBuffers = null,
    }) {
      requireGemini('Staging');
      if (!promptOverride && !config.roomTypes.valid.includes(roomType)) {
        throw new Error(
          `roomType "${roomType}" is not one of ${config.roomTypes.valid.join(', ')}. ` +
          'See config.json roomTypes.aliases to map a friendlier name onto one.',
        );
      }

      const params = {
        roomType, furnitureStyle, additionalPrompt, removeFurniture,
        ...(promptOverride ? { promptOverride } : {}),
        ...(labelVirtuallyStaged ? { labelVirtuallyStaged: true } : {}),
        // Only when the badge is on: stampVirtuallyStaged is the only reader, and it never
        // runs otherwise. Kept out of params entirely when unset so an ordinary post's
        // prompt payload is byte-identical to what it was before these two existed.
        ...(labelVirtuallyStaged && stampStyle ? { stampStyle } : {}),
        ...(labelVirtuallyStaged && stampScale !== undefined ? { stampScale } : {}),
        ...(reviewBasePrompt ? { reviewBasePrompt } : {}),
      };

      // Not safe to run two stage() calls concurrently on one client: they would
      // interleave into the same verdict buffer. The pipeline is sequential by design.
      verdicts = [];
      const refs = furnitureBuffers && furnitureBuffers.length ? furnitureBuffers : null;
      const dataUrl = await processStaging(sourceBuffer, params, null, refs, model);
      const { buffer, mime } = dataUrlToBuffer(dataUrl);

      const scores = verdicts.map((v) => v.score ?? 0);
      const quality = {
        perfect: verdicts.some((v) => v.perfect === true),
        attempts: verdicts.length,
        bestScore: scores.length ? Math.max(...scores) : null,
        // Why the reviewer was unhappy, so a caller retrying with a different source
        // photo can say what it is trying to avoid.
        defects: verdicts.filter((v) => v.perfect === false && v.reason).map((v) => v.reason),
        reviewerUnavailable: verdicts.some((v) => v.degraded === true),
      };

      return { buffer, mime, params, model, quality };
    },

    /**
     * The Masking Studio, driven end to end: brush a region, change only that region.
     *
     * This exists because a post about Masking Studio could not previously be made
     * honestly. acquirePair only ever calls processStaging on a WHOLE photo, so the
     * 08-14 post had to abandon its "only the masked region changed" claim and reframe
     * as an AI Designer post. The claim is the product's most checkable differentiator,
     * so the fix is to drive the real thing rather than to keep avoiding the subject.
     *
     * createMaskEditHandler is an Express handler, but it is dependency-injected and only
     * ever touches req.body and res.json, so a stub pair drives it with no product change.
     * Same substitutions as processStaging above: the CSV writer is a no-op and the
     * enterprise meter is inert, because a marketing render is not a customer render.
     *
     * Two things the route does NOT do, which matter here and not in the browser:
     *
     *  * The route returns the model's RAW edit. Pixel identity outside the brush comes
     *    from compositeMaskedEdit in public/scripts/mask-core.js, on the client. Nothing
     *    server-side composites, so a caller that shipped `editedImage` straight into a
     *    post would be publishing the model's unconstrained redraw of the whole room
     *    under a headline promising the opposite. We composite here, through the same
     *    mask, with the product's own compositeForReview.
     *  * compositeForReview swallows its own failure and returns the raw edit. That is
     *    right for a QA reviewer (better to review something than nothing) and wrong for
     *    a public advertisement, so identity is asserted rather than assumed.
     *
     * `compositeMaskBuffer` splits the mask's two jobs apart, and they genuinely want
     * different shapes. The mask sent to the model is a LOCATOR: buildMarkedRoomImage turns
     * it into a magenta outline saying "change what is inside this", and that outline should
     * be crisp, because a soft one describes a boundary the model cannot place. Feeding a
     * feathered mask in here cost real quality: QA scores fell from 85 to 100 down to a flat
     * 70 across four rolls, and the renders came back with half the wall in a completely
     * different tile format. The mask used to COMPOSITE wants the opposite, since every
     * object in a photograph has a soft edge, and a hard composite leaves a rim of the
     * original colour around it that reads as a cut-out. Pass a crisp mask as `maskBuffer`
     * and a feathered copy as `compositeMaskBuffer` to get both.
     * @param {{ sourceBuffer: Buffer, maskBuffer: Buffer, prompt: string,
     *           compositeMaskBuffer?: Buffer|null,
     *           referenceBuffer?: Buffer|null, seed?: number|null }} o
     * @returns {Promise<{ buffer: Buffer, mime: string, prompt: string, model: string,
     *           quality: object, outsideMaskIdentical: boolean }>}
     */
    async maskEdit({
      sourceBuffer, maskBuffer, prompt,
      compositeMaskBuffer = null, referenceBuffer = null, seed = null, modelOverride = null,
    }) {
      requireGemini('Mask editing');

      // The route PINS gemini-2.5-flash-image for masked edits, while ordinary staging runs
      // on the newer model from config. `modelOverride` swaps it by wrapping the client
      // rather than by touching routes/ or lib/staging/, so the product keeps whatever it
      // has chosen and this tool can still answer "is that artifact the model's fault".
      // Leave it unset for a real post: what a post shows should be what a customer gets.
      const client = modelOverride
        ? {
          ...genAI,
          getGenerativeModel: (options) =>
            genAI.getGenerativeModel({ ...options, model: modelOverride }),
        }
        : genAI;

      const handler = createMaskEditHandler({
        genAI: client,
        // No accounts in a local tool. The handler only reads proUser.id, and it reaches
        // this stub solely to key a CSV row we are already discarding.
        requireProAccount: () => ({ id: 'instagram-post-factory' }),
        MAX_MASK_PROMPT_LENGTH: 1000,
        QUALITY_MAX_ATTEMPTS: config.models.qualityMaxAttempts,
        DEBUG_MODE: debug,
        downscaleImage,
        padBufferToAspectRatio,
        buildMarkedRoomImage,
        normalizeMaskOutputToRoom,
        reviewMaskEdit: recordingMaskReview,
        compositeForReview,
        // POSITIONAL signature, per the warning at the top of mask-edit.js. This is the
        // one from createStagingGeneration, not the options-object export of
        // staging-pipeline.js, and swapping them silently breaks the retry loop.
        generateWithQualityRetry,
        maskReferencePromptSuffix,
        logMaskEditToFile: () => {},
        enterpriseDomainForUser: () => null,
        reportEnterpriseUsage: () => {},
        recordStagingActivity: () => false,
      });

      const toDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
      const req = {
        body: {
          image: toDataUrl(sourceBuffer),
          mask: toDataUrl(maskBuffer),
          prompt,
          ...(referenceBuffer ? { referenceImage: toDataUrl(referenceBuffer) } : {}),
          ...(Number.isInteger(seed) ? { seed } : {}),
        },
      };

      // Minimal Express double. sendError calls res.status(n).json(body), the success
      // path calls res.json(body), so capturing both is enough.
      let payload = null;
      let status = 200;
      const res = {
        status(code) { status = code; return res; },
        json(body) { payload = body; return res; },
        set() { return res; },
        setHeader() { return res; },
      };

      maskVerdicts = [];
      await handler(req, res);

      if (!payload || payload.success !== true) {
        const detail = payload?.error ?? payload?.message ?? 'no response body';
        const ref = payload?.ref ? ` (error ref ${payload.ref})` : '';
        throw new Error(`Mask edit failed with status ${status}: ${detail}${ref}`);
      }

      // The route's own downscale may have resized the room, so measure the composite
      // against the SAME normalised room the model was given rather than the original.
      const normalisedRoom = await downscaleImage(sourceBuffer);
      const roomMeta = await sharp(normalisedRoom).metadata();
      const { width, height } = roomMeta;
      // The composite runs through the feathered copy when one was supplied; the model was
      // shown the crisp one.
      const resizedMask = await sharp(compositeMaskBuffer ?? maskBuffer)
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer();

      const compositeUrl = await compositeForReview(
        normalisedRoom, resizedMask, payload.editedImage, width, height,
      );
      if (compositeUrl === payload.editedImage) {
        throw new Error(
          'compositeForReview fell back to the raw model output, so pixels outside the '
          + 'brush are the model\'s redraw rather than the original photograph. Refusing '
          + 'to return an image whose headline claim would be false.',
        );
      }
      const { buffer, mime } = dataUrlToBuffer(compositeUrl);
      // The model's RAW output, before it is blended back through the mask. Kept because
      // when an artifact shows up in a finished post, the first question is whether the
      // model produced it or the compositing did, and nothing else in the pipeline can
      // answer that.
      const rawModelOutput = dataUrlToBuffer(payload.editedImage).buffer;

      // Prove the claim instead of trusting the compositor. Everything outside the brush
      // must be the original photograph, byte for byte after the shared resize.
      const outsideMaskIdentical = await regionOutsideMaskIsIdentical({
        originalBuffer: normalisedRoom, resultBuffer: buffer, maskBuffer: resizedMask, width, height,
      });

      const scores = maskVerdicts.map((v) => v.score ?? 0);
      const quality = {
        perfect: maskVerdicts.some((v) => v.perfect === true),
        attempts: maskVerdicts.length,
        bestScore: scores.length ? Math.max(...scores) : null,
        defects: maskVerdicts.filter((v) => v.perfect === false && v.reason).map((v) => v.reason),
        reviewerUnavailable: maskVerdicts.some((v) => v.degraded === true),
      };

      return {
        buffer,
        mime,
        prompt,
        model: modelOverride ?? 'gemini-2.5-flash-image',
        params: { fn: 'mask-edit', prompt, referenceUsed: Boolean(payload.referenceUsed) },
        quality,
        outsideMaskIdentical,
        rawModelOutput,
        // The exact bytes the edit started from, and the ONLY honest "before" for a post
        // that puts the two frames side by side.
        //
        // The route downscales the upload before it generates, so the untouched original
        // is a different size from the result. Re-deriving the before by resizing the
        // original to match looks equivalent and is not: a different resize path lands
        // sub-pixel differently, and an image reviewer measured the finished carousel
        // shifting by one pixel across the vanity and two across the mirror. Nobody sees
        // that, but the post's legend says "the same pixels", and it was false everywhere
        // rather than nowhere. Hand back the real thing so the caller cannot get it wrong.
        normalisedSource: normalisedRoom,
      };
    },

    /** Pure text to image, no source photo. Used to invent an empty room when stock has none. */
    async generate(prompt, { model = config.models.textToImage } = {}) {
      requireGemini('Text to image');
      const dataUrl = await processImageGeneration(prompt, null, model);
      const { buffer, mime } = dataUrlToBuffer(dataUrl);
      return { buffer, mime, prompt, model };
    },

    /**
     * The product's own upload gate, reused as a free quality filter on sourced photos.
     * If Stagify would reject a photo from a customer, it has no business in a post
     * advertising Stagify.
     */
    async validateSource(buffer) {
      requireGemini('Source validation');
      return validateStageableImage(buffer);
    },

    /**
     * The EXTERIOR upload gate, which is a different gate and not a nicety.
     * validateStageableImage is the interior one, and it classifies a photograph of the
     * front of a house as category 6 (some other object) or as a vehicle when there is a
     * car on the drive, so screening a curb-appeal source through it rejects the one thing
     * the Exterior Studio exists to accept.
     */
    async validateExteriorSource(buffer) {
      requireGemini('Exterior source validation');
      return validateExteriorImage(buffer);
    },

    /**
     * Does this photo actually show the room the brief asked for?
     *
     * validateStageableImage answers "could Stagify stage this", which is a different and
     * much weaker question. A macro shot of plastic-wrapped boxes passes it, because it is
     * technically an interior. Sourcing one for a "cluttered dining room" brief and staging
     * it produced a before and after of two completely unrelated spaces, which on a public
     * account is a false advertisement rather than a bad crop.
     *
     * So this asks the question the brief actually cares about: is it that room, is it a
     * wide enough view to read as one, and is it usable as the "before" half of a pair.
     *
     * @param {Buffer} buffer
     * @param {{ roomType: string, wants: string }} brief
     * @returns {Promise<{ ok: boolean, reason: string, skipped?: boolean }>}
     */
    async fitsBrief(buffer, { roomType, wants }) {
      // No vision client means no opinion. Returning ok would silently reinstate the bug,
      // so say plainly that it was not checked and let the caller decide.
      if (!openai) return { ok: true, skipped: true, reason: 'no GPT_KEY, relevance not checked' };

      const response = await openai.chat.completions.create({
        model: FAST_MODEL,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are screening a stock photo for use as the "before" image in a real estate '
                + 'before-and-after post.\n\n'
                + `It must show: a ${roomType}. ${wants}\n\n`
                + 'Reject it if it is a close-up or macro shot, if the room is not clearly identifiable, '
                + 'if it is mostly one object, if it is an exterior, or if it is too tightly cropped to '
                + 'read as a room.\n\n'
                + 'Answer with JSON only: {"ok": true|false, "reason": "one short sentence"}',
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } },
          ],
        }],
        max_tokens: 120,
      });

      const text = response.choices?.[0]?.message?.content ?? '';
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) return { ok: false, reason: `could not parse the screening reply: ${text.slice(0, 80)}` };
      try {
        const parsed = JSON.parse(match[0]);
        return { ok: parsed.ok === true, reason: String(parsed.reason ?? '') };
      } catch {
        return { ok: false, reason: `screening reply was not valid JSON: ${text.slice(0, 80)}` };
      }
    },

    /** GPT vision caption, used for alt text. Null when GPT_KEY is unset. */
    annotate: annotateImage,
  };
}
