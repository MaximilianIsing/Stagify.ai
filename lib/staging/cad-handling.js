// CAD floor-plan → render, via the SHARED Gemini client.
//
// TWO VIEWS, one pipeline. `view: 'top-down'` (the default) produces a furnished 3D
// floor plan seen from directly above — the whole plan in frame, every room at once.
// `view: 'eye-level'` produces a photorealistic interior photograph taken standing
// inside ONE room of that plan. They are genuinely different products and they need
// opposite framing rules, which is why the prompt is two builders over a shared core
// rather than one string with a conditional line.
//
// Only top-down existed until now, and it was mandated five separate times ("DO NOT use
// any angled perspective, side view, or isometric view - ONLY top-down") — while the
// welcome message, the homepage and all 11 language packs promised "a photorealistic,
// furnished render". Asking for the living room got you a bird's-eye floor plan.
//
// This module used to build its own GoogleGenerativeAI client from a private
// readApiKey() + module-level cache, and compute its own DEBUG_MODE. Both read
// files relative to THIS directory (lib/staging/key.txt, lib/staging/debug.txt) —
// paths that never exist, because the convention everywhere else is repo root
// (lib/services/ai-clients.js takes an injected __dirname; lib/config/runtime-flags.js
// walks two levels up). That left three divergences from the rest of the codebase:
// the module was the only consumer of GEMINI_API_KEY, it treated an empty
// GOOGLE_AI_API_KEY as "throw" where ai-clients.js treats it as "disabled", and it
// ignored a root debug.txt. It now takes the injected client like every other
// AI-touching module.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { logger } from '../logger.js';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { REALISTIC_DEFECT_FREE_RULES, qualityRetryFeedbackSuffix } from './prompts.js';
import { generateWithQualityRetry } from './staging-pipeline.js';
import {
  nearestGeminiAspectRatio,
  cropToAspectRatio,
  upscaleForDelivery,
  orientedDimensions,
} from '../image/image-primitives.js';
import { stampVirtuallyStaged } from '../image/stamp-disclosure.js';

/** The two renders this module can produce. `view` is validated against these. */
export const CAD_VIEWS = /** @type {const} */ (['top-down', 'eye-level']);

/**
 * The default view. A routing decision from before the `view` field existed carries no
 * value at all, and must keep behaving exactly as it did — so the default lives HERE,
 * at the consumer, and not as a schema default the model can be talked out of.
 */
export const DEFAULT_CAD_VIEW = 'top-down';

// An eye-level render is a photograph, so it gets a photographic frame. Pinning it to
// the BLUEPRINT's aspect ratio (which is what the top-down view correctly does) would
// shape a room photo like a floor plan — a tall skinny plan would come back as a tall
// skinny interior shot. 3:2 is the real-estate default and one of the buckets Gemini
// actually supports (see GEMINI_ASPECT_RATIOS in lib/image/image-primitives.js).
const EYE_LEVEL_ASPECT = { label: '3:2', ratio: 3 / 2 };

// Attempts through the retry loop. NOT the same thing as "renders three times": the loop
// only re-enters on a THROW or a failed review, so with the gate off (which is how
// server.js wires it — see the note there) this is ONE generation in the happy path, and
// the remaining attempts exist solely to ride out a transient provider error.
//
// Left at 3 rather than dropped to 1 for exactly that reason. Setting it to 1 would buy
// the same cost saving as switching the reviewer off, and would additionally throw away
// the transient-error retry — turning a momentary 429 on a 57-second Pro-model call into
// a failed turn for the user.
const CAD_QUALITY_MAX_ATTEMPTS = 3;

/**
 * Build the CAD handling API bound to the shared Gemini client, so this module uses the
 * same client (and the same key resolution) as the rest of the app instead of constructing
 * its own.
 * @param {{ genAI: any, reviewImageQuality?: ((url: string, opts?: any) => Promise<any>) | null }} deps - The shared GoogleGenerativeAI client (loosely typed; null when no key is configured) and the optional QA reviewer. Omitting the reviewer disables the quality gate rather than failing the render.
 * @returns {{ blueprintTo3D: (blueprintImage: string|Buffer, options?: import('../types/image.js').BlueprintRenderOptions) => Promise<Buffer> }} The CAD handling API.
 */
export function createCadHandling({ genAI, reviewImageQuality = null }) {
  return {
    blueprintTo3D: (blueprintImage, options = {}) =>
      renderBlueprintTo3D(genAI, reviewImageQuality, blueprintImage, options),
  };
}

/**
 * Gets the MIME type from data URL or file extension
 * @param {string} dataUrlOrPath - Data URL (data:image/png;base64,...) or file path
 * @returns {string} MIME type
 */
function getMimeType(dataUrlOrPath) {
  // If it's a data URL, extract MIME type
  if (dataUrlOrPath.startsWith('data:')) {
    const mimeMatch = dataUrlOrPath.match(/data:([^;]+)/);
    if (mimeMatch) {
      return mimeMatch[1];
    }
  }
  // Otherwise, try to get from file extension
  const ext = path.extname(dataUrlOrPath).toLowerCase();
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/png";
}

/**
 * Extracts base64 data from a data URL or image buffer
 * @param {string|Buffer} imageData - Data URL string or Buffer
 * @returns {string} Base64 string (without data URL prefix)
 */
function extractBase64(imageData) {
  if (Buffer.isBuffer(imageData)) {
    return imageData.toString("base64");
  }
  if (typeof imageData === 'string') {
    if (imageData.startsWith('data:')) {
      // Extract base64 from data URL
      const base64Match = imageData.match(/base64,(.+)$/);
      if (base64Match) {
        return base64Match[1];
      }
    }
    // Assume it's already base64
    return imageData;
  }
  throw new Error("Invalid image data format");
}

/**
 * Coerce an arbitrary `view` into one this module can render. Anything unrecognised —
 * including the `undefined` a pre-`view` routing decision carries — becomes the default
 * rather than throwing: a floor plan the user asked to have furnished should render the
 * way it always did, not fail on a routing field they never saw.
 * @param {string | null | undefined} view - The routing model's requested view.
 * @returns {'top-down' | 'eye-level'} A supported view.
 */
export function normalizeCadView(view) {
  return /** @type {any} */ (CAD_VIEWS).includes(view) ? /** @type {any} */ (view) : DEFAULT_CAD_VIEW;
}

// ── Prompt builders ─────────────────────────────────────────────────────────
//
// Shared by both views: the model must read real measurements off the plan rather than
// inventing a plausible-looking room. This is the part that makes the output a render OF
// THIS PLAN instead of a generic interior, so it is identical either way.
const DIMENSIONS_AND_SCALING_RULES = `CRITICAL REQUIREMENT - DIMENSIONS AND SCALING:
- CAREFULLY EXTRACT all dimension information from the floorplan blueprint:
  * Identify wall dimensions and thicknesses
  * Note door and window sizes and positions

- USE THE EXACT DIMENSIONS from the blueprint - do not estimate or guess
- MAINTAIN ACCURATE RELATIVE SIZES between different rooms, spaces, and elements
- Preserve the exact proportions: if one room is twice the size of another in the blueprint, it must be twice the size in the 3D render
- Ensure all elements (walls, doors, windows, furniture) are scaled proportionally to match the blueprint's dimensions
- Furniture must be sized appropriately relative to the room dimensions - a small room should have smaller furniture, a large room should have larger furniture`;

/**
 * The original top-down prompt, unchanged in wording. This is the default path, so it
 * stays byte-compatible with what shipped.
 * @param {boolean} hasFurniture - Whether furniture reference images accompany the request.
 * @returns {string} The assembled top-down prompt.
 */
function buildTopDownPrompt(hasFurniture) {
  let prompt = `You are an expert 3D visualization artist.

Analyze this top-down room blueprint image and create a top-down 3D render of the room.

CRITICAL REQUIREMENT - THE OUTPUT MUST BE TOP-DOWN:
- The camera/viewpoint MUST be positioned directly above the room, looking straight down (90-degree angle from horizontal)
- This is a TOP-DOWN view, also known as a bird's eye view or plan view
- The output image MUST show the room from above, as if you are looking down at a floor plan
- DO NOT use any angled perspective, side view, or isometric view - ONLY top-down
- The floor should be visible as the primary surface, with walls appearing as vertical lines or edges around the perimeter`;

  prompt += `\n\n${DIMENSIONS_AND_SCALING_RULES}`;

  if (hasFurniture) {
    prompt += `\n\nIMPORTANT: Additional furniture images have been provided. Include these furniture pieces in the 3D render based on the blueprint layout.
- Scale the furniture to match the room dimensions from the blueprint
- If the blueprint shows a 10ft x 12ft room, the furniture must be sized to fit proportionally within that space
- Place furniture appropriately within the room according to the blueprint's layout and exact scale
- When placing furniture, show it from the top-down perspective (as if looking down at the furniture from above)
- Ensure furniture sizes are realistic relative to the room dimensions shown in the blueprint`;
  }

  prompt += `\n\nRequirements:
- Generate a TOP-DOWN view (bird's eye view) looking STRAIGHT DOWN at the room - this is MANDATORY
- The viewing angle must be 90 degrees from horizontal (directly overhead)
- Show all walls, doors, windows, and furniture in 3D perspective but from the top-down angle
- Use appropriate colors and textures for different elements (walls, floor, furniture, etc.)
- Maintain the EXACT layout, dimensions, and proportions from the blueprint - every measurement must be accurate`;

  if (hasFurniture) {
    prompt += `\n- Include the furniture from the provided furniture images, placing them appropriately in the room according to the blueprint, showing them from the top-down perspective\n- Scale furniture to match the room dimensions - use the blueprint's scale to determine proper furniture sizes`;
  }

  prompt += `\n- Make it look like a professional 3D architectural visualization
- The output MUST be a top-down 3D render image - viewing the room from directly above
- REMEMBER: The output must show the room from above, not from any side or angled perspective
- REMEMBER: Dimensions and relative sizes from the blueprint are CRITICAL - they must be preserved accurately
- Preserve the full blueprint/layout in frame — do not crop out rooms, walls, or edges of the plan unless the user explicitly asked for a tighter crop`;

  return prompt;
}

/**
 * The eye-level prompt: a real-estate interior photograph taken standing inside one room
 * of the plan.
 *
 * Deliberately does NOT inherit the top-down builder's two closing framing lines
 * ("Preserve the full blueprint/layout in frame", "Match the input image aspect ratio").
 * Those preserve the INPUT's frame, which is right when the output is another view of the
 * whole plan and exactly wrong here — the output is a new photograph, not a reframing of
 * the drawing. Left in, they pull the render back toward the plan it came from.
 * @param {boolean} hasFurniture - Whether furniture reference images accompany the request.
 * @param {string | null} room - Which room on the plan to stand in (null = let the model choose the primary living space).
 * @returns {string} The assembled eye-level prompt.
 */
function buildEyeLevelPrompt(hasFurniture, room) {
  const target = room && room.trim()
    ? `the ${room.trim()}`
    : 'the primary living space (the largest main room on the plan)';

  let prompt = `You are an expert architectural visualization artist and real-estate photographer.

The image provided is a 2D top-down floor plan. Read it as a set of measurements and produce ONE photorealistic interior photograph taken INSIDE ${target}.

CRITICAL REQUIREMENT - THIS IS AN EYE-LEVEL INTERIOR PHOTOGRAPH:
- The camera stands INSIDE ${target}, at normal human eye height (about 1.5 m / 5 ft above the floor), held level.
- Shoot it the way a real-estate photographer would: stand in or near a corner, look across the room toward its most presentable wall, and use a wide but undistorted lens so the space reads as large and open.
- The result must look like a PHOTOGRAPH of a finished room — not a floor plan, not a bird's-eye or overhead view, not an isometric or cutaway diagram, and not a dollhouse model with the roof removed.
- Do NOT draw the floor plan, room labels, dimension lines, north arrows, scale bars, or any other drawing annotation anywhere in the image.
- Show the floor, the walls, and the ceiling meeting naturally, with a believable horizon and vanishing lines.`;

  prompt += `\n\n${DIMENSIONS_AND_SCALING_RULES}`;

  prompt += `\n\nCRITICAL REQUIREMENT - THE ROOM MUST MATCH THE PLAN:
- Build ${target} exactly as the plan describes it: same proportions, same wall positions and lengths, same ceiling height implied by the plan's scale.
- Put every door and window where the plan puts them, at the size the plan gives them, on the correct wall. Do not add a window to a wall the plan shows as solid, and do not omit one the plan shows.
- Respect what the plan says lies beyond each opening — a doorway into a hallway must show a hallway, not the outdoors.
- Light the room through its actual windows, in one coherent direction, with soft natural daylight.
- If the plan labels the room, honor that label: a room marked "kitchen" is photographed as a kitchen.`;

  prompt += `\n\nSTAGING:
- Furnish ${target} completely and tastefully for its purpose, in a broadly appealing contemporary style with a neutral palette.
- Arrange the furniture the way it would actually be used, leaving clear walking paths and honoring the room's real circulation between doors.`;

  if (hasFurniture) {
    prompt += `\n- Additional furniture images have been provided. Place those specific pieces in the room, at correct real-world scale for the plan's dimensions, and integrate them naturally into the arrangement and lighting.`;
  }

  prompt += `\n\n${REALISTIC_DEFECT_FREE_RULES}`;

  prompt += `\n\nDeliver a photorealistic, professionally photographed interior: sharp focus, detailed materials and textures, and natural real-estate photography lighting.`;

  return prompt;
}

/**
 * Converts a top-down blueprint/floor-plan into a render via Gemini — either a top-down
 * 3D floor plan or an eye-level interior photograph, per `view`.
 *
 * Uses the injected shared client and delegates image extraction to parseGeminiResponse
 * (which throws on a text-only or unexpected response shape). Not exported directly —
 * createCadHandling() binds `genAI`/`reviewImageQuality` and returns it as `blueprintTo3D`.
 * @param {any} genAI - The shared GoogleGenerativeAI client (throws when null).
 * @param {((url: string, opts?: any) => Promise<any>) | null} reviewImageQuality - The QA reviewer, or null to skip the quality gate.
 * @param {string|Buffer} blueprintImage - The top-down blueprint/floor-plan image as a data URL, bare base64 string, or Buffer.
 * @param {import('../types/image.js').BlueprintRenderOptions} [options] - Render options (mimeType, furnitureImages, additionalPrompt, view, room, stamp).
 * @returns {Promise<Buffer>} Buffer of the generated render.
 */
async function renderBlueprintTo3D(genAI, reviewImageQuality, blueprintImage, options = {}) {
  const {
    mimeType = null,
    furnitureImages = [],
    additionalPrompt = null,
    view: requestedView = DEFAULT_CAD_VIEW,
    room = null,
    stamp = null,
    onNative = null,
  } = options;
  const view = normalizeCadView(requestedView);

  if (DEBUG_MODE) {
    logger.debug(`=== BLUEPRINT RENDER (${view}${room ? `: ${room}` : ''}) ===\n`);
  }

  // Matches every other `if (!genAI)` guard in the codebase: an unset OR empty
  // GOOGLE_AI_API_KEY leaves the shared client null rather than half-configured,
  // so "Gemini is switched off" reads the same way here as it does everywhere else.
  if (!genAI) {
    throw new Error("Google AI client not configured. Set GOOGLE_AI_API_KEY to enable CAD floor-plan rendering.");
  }

  // Extract base64 and MIME type for blueprint
  const imageBase64 = extractBase64(blueprintImage);
  const detectedMimeType = mimeType || getMimeType(typeof blueprintImage === 'string' ? blueprintImage : 'image/png');

  // Build the content array starting with the blueprint image
  /** @type {Array<{ text?: string, inlineData?: { data: string, mimeType: string } }>} */
  const content = [
    {
      inlineData: {
        data: imageBase64,
        mimeType: detectedMimeType,
      },
    }
  ];

  // Add furniture images if provided
  const hasFurniture = Boolean(furnitureImages && furnitureImages.length > 0);
  if (hasFurniture) {
    if (DEBUG_MODE) {
      logger.debug(`Including ${furnitureImages.length} furniture image(s) in the render`);
    }
    for (let i = 0; i < furnitureImages.length; i++) {
      const furnitureImage = furnitureImages[i];
      const furnitureBase64 = extractBase64(furnitureImage.image);
      const furnitureMimeType = furnitureImage.mimeType || getMimeType(typeof furnitureImage.image === 'string' ? furnitureImage.image : 'image/png');

      content.push({
        inlineData: {
          data: furnitureBase64,
          mimeType: furnitureMimeType,
        },
      });
    }
  }

  let prompt = view === 'eye-level'
    ? buildEyeLevelPrompt(hasFurniture, room)
    : buildTopDownPrompt(hasFurniture);

  // Add additional prompt/instructions from the AI if provided
  if (additionalPrompt && additionalPrompt.trim()) {
    prompt += `\n\nADDITIONAL REQUIREMENTS FROM USER:
${additionalPrompt.trim()}

${view === 'eye-level'
      ? 'Please incorporate these requirements while keeping the eye-level interior photograph faithful to the floor plan.'
      : 'Please incorporate these requirements into the 3D render while maintaining the top-down perspective.'}`;
  }

  prompt += view === 'eye-level'
    ? `\n\nGenerate the interior photograph now. It must be an eye-level view from inside the room.`
    : `\n\nGenerate the 3D render now. Ensure it is a TOP-DOWN view.`;

  // Pin the output shape at the source rather than asking for it in prose. Top-down
  // reproduces the plan, so it takes the plan's own ratio; eye-level is a new photograph
  // and takes a photographic one. The old prompt line "Match the input image aspect
  // ratio" was the only control here, and a text instruction is not a control.
  const arPin = view === 'eye-level'
    ? EYE_LEVEL_ASPECT
    : await blueprintAspectPin(imageBase64);

  if (DEBUG_MODE) {
    logger.debug(`Sending request to Gemini... (aspect pin: ${arPin ? arPin.label : 'none'})`);
  }

  try {
    // Use Gemini 3 Pro Image (GA) — CAD floor-plan rendering is a reasoning-heavy task
    // where the Pro model's scene understanding earns its premium, so this stays on Pro
    // even though chat staging uses 3.1-flash.
    const model = genAI.getGenerativeModel({
      model: "gemini-3-pro-image",
      // Same generationConfig passthrough lib/staging/staging-generation.js uses; the SDK
      // forwards imageConfig verbatim to the REST endpoint.
      ...(arPin ? { generationConfig: { imageConfig: { aspectRatio: arPin.label } } } : {}),
    });

    // Add the prompt text to the content array
    content.push({ text: prompt });

    // NO reviewer is the SHIPPED configuration — server.js deliberately injects none, and
    // the note there records the measurement behind it. This branch is therefore the live
    // path, not a fallback; the reviewer branch is kept wired and specced so re-enabling
    // is one word.
    //
    // "Off" has to be a PASSING STUB rather than a null, because generateWithQualityRetry
    // requires a reviewFn. It is deliberately not marked `degraded`: that flag means
    // "shipped unreviewed because the reviewer BROKE" and lights up the same dashboard an
    // outage would, so switching the gate off on purpose must not look like one.
    //
    // When it IS on, each view brings its own instruction, because the reviewer's default
    // rubric grades "AI-generated INTERIOR real-estate photos" — right for eye-level, and
    // exactly wrong for top-down, which it would fail for having no horizon and an
    // overhead camera.
    const reviewer = typeof reviewImageQuality === 'function'
      ? (/** @type {string} */ url) => reviewImageQuality(url, { instruction: reviewInstructionFor(view, room, additionalPrompt) })
      : async () => ({ perfect: true, score: 100, reason: 'quality gate off for blueprint renders' });

    // One generation in the happy path; the loop only re-enters on a throw or a failed
    // review, and a retry is handed the previous verdict so it targets the named defect
    // instead of blindly re-rolling.
    const resultDataUrl = await generateWithQualityRetry(async (attempt, feedback) => {
      const attemptContent = feedback
        ? [...content.slice(0, -1), { text: prompt + qualityRetryFeedbackSuffix(feedback) }]
        : content;
      const result = await model.generateContent(attemptContent);
      const buffer = parseGeminiResponse(result.response);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }, {
      label: `cad-${view}`,
      reviewFn: reviewer,
      maxAttempts: CAD_QUALITY_MAX_ATTEMPTS,
      debug: DEBUG_MODE,
    });

    // Annotated: Buffer.from() infers the narrower Buffer<ArrayBuffer>, which the
    // reassignments below (sharp returns Buffer<ArrayBufferLike>) do not satisfy.
    /** @type {Buffer} */
    let finalBuffer = Buffer.from(resultDataUrl.split(',')[1], 'base64');

    // Safety net only — no-ops when the model honored the pin above. Centre-crops (never
    // stretches) an output that ignored it.
    if (arPin) {
      finalBuffer = await cropToAspectRatio(finalBuffer, arPin.ratio);
    }

    // Burn in the "virtually staged" disclosure. POSITION IS DELIBERATE: after the
    // quality gate (so the reviewer never grades the badge as a defect) and before the
    // delivery upscale, so the one call covers every copy of the image.
    //
    // NOT wrapped in try/catch on purpose — the stamp fails closed
    // (lib/image/stamp-disclosure.js). An unlabelled image the user believes carries a
    // disclosure is worse than a failed render.
    if (stamp && stamp.enabled) {
      const stamped = await stampVirtuallyStaged(
        `data:image/png;base64,${finalBuffer.toString('base64')}`,
        { lang: stamp.lang, style: stamp.style, scale: stamp.scale },
      );
      finalBuffer = Buffer.from(stamped.split(',')[1], 'base64');
    }

    // Hand the NATIVE result to anyone who asked for it, before the upscale below discards
    // it — the same hook and the same position processStaging uses.
    //
    // The gallery stores THIS, not the delivered image: `upscaleForDelivery` is lanczos
    // interpolation, so the delivered copy is several times the bytes carrying no extra
    // detail (render-persistence.js makes that a rule). It runs after the stamp so the
    // stored master is labelled too — that master is the copy an agent re-downloads months
    // later and publishes.
    //
    // Best-effort by construction: a persistence hook must never be able to fail a paid
    // render, so its throw is swallowed here rather than unwinding the generation.
    if (typeof onNative === 'function') {
      try {
        onNative(finalBuffer);
      } catch (hookError) {
        logger.error('[CAD] onNative hook threw; the render is unaffected:', hookError);
      }
    }

    // Enlarge the ~1 MP model output for delivery (interpolation only) and ship WebP, so
    // the larger image is a smaller payload than the PNG — the same treatment every
    // staged render gets. CAD output used to go out as raw model PNG.
    const delivered = await upscaleForDelivery(`data:image/png;base64,${finalBuffer.toString('base64')}`);
    return Buffer.from(delivered.split(',')[1], 'base64');
  } catch (error) {
    logger.error("Error generating 3D render:", error.message);
    throw error;
  }
}

/**
 * The plan's own aspect ratio, snapped to a bucket Gemini supports. Fails open to null
 * (no pin) rather than failing the render — an unpinned output is the old behaviour, and
 * the crop safety net is skipped along with it.
 * @param {string} imageBase64 - The blueprint's base64 payload.
 * @returns {Promise<{ label: string, ratio: number } | null>} The nearest supported ratio, or null.
 */
async function blueprintAspectPin(imageBase64) {
  try {
    const meta = await sharp(Buffer.from(imageBase64, 'base64')).metadata();
    // EXIF-oriented dimensions, so a rotated plan pins to the ratio it will actually
    // be displayed at rather than its stored one.
    const dims = orientedDimensions(meta);
    return dims ? nearestGeminiAspectRatio(dims.width, dims.height) : null;
  } catch (error) {
    if (DEBUG_MODE) {
      logger.debug('[CAD] could not read blueprint dimensions; rendering without an aspect pin:', error.message);
    }
    return null;
  }
}

/**
 * What the QA reviewer should judge this render against. The reviewer scores the image
 * against this sentence, so it has to describe the view that was actually asked for.
 * @param {'top-down'|'eye-level'} view - The render's view.
 * @param {string | null} room - The target room, when eye-level.
 * @param {string | null} additionalPrompt - The user's extra instructions, folded in when present.
 * @returns {string} The reviewer instruction.
 */
function reviewInstructionFor(view, room, additionalPrompt) {
  const extra = additionalPrompt && additionalPrompt.trim() ? ` The user also asked: "${additionalPrompt.trim()}".` : '';
  if (view === 'eye-level') {
    return `This is a photorealistic eye-level interior photograph of ${room && room.trim() ? `the ${room.trim()}` : 'a room'}, generated from a 2D floor plan. It should look like a real photograph taken standing inside the room, professionally furnished. It is a DEFECT if it is a floor plan, an overhead or bird's-eye view, an isometric or dollhouse cutaway, or if it contains drawing annotations such as room labels, dimension lines, or a scale bar.${extra}`;
  }
  return `This is a top-down (bird's-eye) 3D render of a furnished floor plan, generated from a 2D blueprint. The overhead camera and the absence of a horizon are CORRECT and must not be treated as defects — judge it on whether the layout matches a plausible floor plan, the rooms are furnished sensibly and to scale, and the geometry is clean.${extra}`;
}

/**
 * Extracts the generated image Buffer from a Gemini generateContent() `.response`.
 *
 * Branch ladder: first inlineData part → Buffer; text-only parts → throw (the model
 * returned prose, not an image); anything else → throw (unexpected shape). Exported
 * as a named function so the branches are unit-testable with a hand-built response
 * (no live API call). getMimeType/extractBase64 are exported for the same reason.
 * @param {{ candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data: string }, text?: string }> } }> }} response - A Gemini generateContent() `.response` object.
 * @returns {Buffer} Buffer decoded from the first inlineData image part.
 */
function parseGeminiResponse(response) {
  if (response && response.candidates && response.candidates[0]) {
    const candidate = response.candidates[0];
    const content = candidate.content;

    if (content && content.parts) {
      for (const part of content.parts) {
        if (part.inlineData && part.inlineData.data) {
          const imageBuffer = Buffer.from(part.inlineData.data, "base64");
          if (DEBUG_MODE) {
            logger.debug(`\n✓ 3D render generated successfully`);
          }
          return imageBuffer;
        }
      }

      const textParts = content.parts.filter(p => p.text);
      if (textParts.length > 0) {
        const text = textParts.map(p => p.text).join("\n");
        if (DEBUG_MODE) {
          logger.debug("Gemini response (text):", text.substring(0, 500));
        }
        throw new Error("Gemini returned text instead of an image. This model may not support image generation. Response: " + text.substring(0, 200));
      }
    }
  }

  if (DEBUG_MODE) {
    logger.debug("Full response:", JSON.stringify(response, null, 2).substring(0, 1000));
  }
  throw new Error("Unexpected response format from Gemini");
}

export { getMimeType, extractBase64, parseGeminiResponse };

// CLI support. Builds the shared clients the same way server.js does (repo-root
// __dirname, so the key.txt fallback resolves where the convention says it does)
// instead of reaching for a lib/staging/key.txt that never existed.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { fileURLToPath } = await import("url");
    const { createAiClients } = await import("../services/ai-clients.js");
    const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const { genAI } = createAiClients({ __dirname: rootDir, DEBUG_MODE });
    const { blueprintTo3D } = createCadHandling({ genAI });

    const argv = process.argv.slice(2);

    if (argv.length === 0) {
      // logger.INFO, not debug: the default log floor is `info`, so routing usage text
      // through logger.debug meant `node cad-handling.js` with no args printed NOTHING
      // and exited 1. Help that only appears when DEBUG is set is not help.
      logger.info("Usage: node cad-handling.js <blueprintImage> [outputImage] [--view top-down|eye-level] [--room \"living room\"]");
      logger.info("");
      logger.info("If only blueprint image is provided, output will be auto-generated as <name>-render.png");
      logger.info("");
      logger.info("Examples:");
      logger.info("  node cad-handling.js Room1.png");
      logger.info("  node cad-handling.js Room1.png output.png");
      logger.info("  node cad-handling.js Room1.png --view eye-level --room \"living room\"");
      process.exit(1);
    }

    const viewFlag = argv.indexOf('--view');
    const roomFlag = argv.indexOf('--room');
    // normalizeCadView, not a raw argv string: a typo'd --view renders the default
    // rather than being silently forwarded as an unknown view.
    const view = normalizeCadView(viewFlag !== -1 ? argv[viewFlag + 1] : DEFAULT_CAD_VIEW);
    const room = roomFlag !== -1 ? argv[roomFlag + 1] : null;
    const positional = argv.filter((a, i) =>
      !a.startsWith('--') && i !== viewFlag + 1 && i !== roomFlag + 1);

    const imagePath = positional[0];
    let outputPath = positional[1];

    // If no output path specified, auto-generate one
    if (!outputPath) {
      const parsedPath = path.parse(imagePath);
      outputPath = path.join(parsedPath.dir, `${parsedPath.name}-render${parsedPath.ext || ".png"}`);
    }

    try {
      // Read image file for CLI usage
      const imageBuffer = fs.readFileSync(imagePath);
      const mimeType = getMimeType(imagePath);
      const resultBuffer = await blueprintTo3D(imageBuffer, { mimeType, view, room });

      // Save to file
      const resolvedOutputPath = path.resolve(outputPath);
      await fs.promises.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await fs.promises.writeFile(resolvedOutputPath, resultBuffer);
      logger.info(`\n✓ Render saved to: ${resolvedOutputPath}`);
    } catch (error) {
      logger.error("Error:", error.message || error);
      if (error.stack) {
        logger.error(error.stack);
      }
      process.exit(1);
    }
  })();
}
