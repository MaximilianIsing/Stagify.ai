// Prompt/data constants for the AI Designer, staging, QA review, and image
// gatekeeping flows. Extracted verbatim from server.js — pure data, no runtime
// dependencies. Keep these as the single source of truth for the wording the
// image/vision models see.

import { promptMatrix } from './promptMatrix.js';
import { ROOM_TYPE_CONSTRAINTS } from './room-constraints.js';
import {
  // AI_DESIGNER_DISCLOSURE_RULES is NOT imported here: its only consumer
  // (AI_DESIGNER_RESPONSE_ACTION_RULES) moved to ./designer-rules.js, which imports it
  // directly.
  DISCLOSURE_ROUTING_FIELD,
  DISCLOSURE_CONTRACT_FRAGMENT, DISCLOSURE_STAGING_BULLET,
} from './disclosure-rules.js';
import {
  AI_DESIGNER_RESPONSE_ACTION_RULES, AI_DESIGNER_MESSAGE_TAG_RULES,
  AI_DESIGNER_CAD_RULES, AI_DESIGNER_IMAGE_FRAMING_RULES, STAGIFY_SELF_KNOWLEDGE,
} from './designer-rules.js';
// The two-tier architecture lock generatePrompt() emits LAST. Lives in its own file for
// the same reason designer-rules.js does (this one is at the 650-line cap), and the
// reasoning for both the split and the position is documented there.
import { interiorPreservationRulesFor } from './preservation-rules.js';

// IMAGE_FRAMING_PRESERVATION_RULES used to live here and be shared with the Exterior Studio.
// It is deleted. Each studio now states its own framing rules inside its own preservation
// block — INTERIOR_PRESERVATION_RULES (./preservation-rules.js) and EXTERIOR_PRESERVATION_RULES
// (./exterior-prompts.js) — because the shared version contradicted both of them over whether
// the camera may move, and its interior-only wording made no sense on an exterior photo.

// The anti-AI-slop rules every photorealistic render needs: correct scale, grounded
// contact shadows, consistent perspective, no duplicated/melted geometry, one coherent
// light direction. Lives out here because generatePrompt() is no longer the only
// consumer — lib/staging/cad-handling.js's eye-level blueprint render needs exactly the
// same list, and a second hand-written copy would drift the moment either is tuned.
export const REALISTIC_DEFECT_FREE_RULES = `CRITICAL — REALISTIC, DEFECT-FREE STAGING (avoid the common AI failures):
- Scale every piece correctly relative to the room and to neighboring objects — no oversized or undersized furniture — and keep clear, walkable spacing between pieces.
- Sit all furniture flat on the floor with correct, grounded contact shadows — nothing floating, sinking into the floor, or tilting at an impossible angle.
- Respect the room's perspective and vanishing lines so furniture recedes naturally and squares up with the walls.
- Render each object once, whole and anatomically correct — no duplicated, extra, missing, merged, or warped legs, arms, or parts, and no melted or smeared geometry or textures.
- Use physically plausible, consistent materials and reflections under a single coherent lighting direction that matches the room's existing light.`;

export const DUAL_UPLOAD_ROOM_PROMPT_SUFFIX =
  ' CRITICAL: The first image is the user\'s actual room photo — preserve its exact architecture, walls, windows, doors, camera angle, lighting, and proportions. Place the furniture from the reference image(s) into THIS room only. Do not invent or substitute a different space. Preserve the full frame — do not crop or zoom.';

export const ADD_FURNITURE_PRESERVATION_SUFFIX =
  ' CRITICAL: The base photo is an already-staged room. Preserve this EXACT room — same architecture, walls, windows, camera angle, lighting, and all existing furniture and decor already visible. ONLY add the referenced furniture piece(s). Do not redesign the room or replace existing contents. Preserve the exact aspect ratio and full frame — do not crop or zoom.';

// Model-facing rule prose lives in ./designer-rules.js (this file hit the 650-line
// cap). Re-exported so the many importers of these names do not all have to change,
// and so there is still ONE place to look for "what does the Designer get told".
export {
  AI_DESIGNER_RESPONSE_ACTION_RULES,
  MESSAGE_TAG_PREFIXES,
  AI_DESIGNER_MESSAGE_TAG_RULES,
  AI_DESIGNER_CAD_RULES,
  AI_DESIGNER_IMAGE_FRAMING_RULES,
  STAGIFY_SELF_KNOWLEDGE,
} from './designer-rules.js';
// Same courtesy for the preservation block: one place to look for "what does the image
// model get told about the room", even though the text now lives next door.
export {
  INTERIOR_PRESERVATION_RULES,
  BATHROOM_PRESERVATION_RULES,
  interiorPreservationRulesFor,
  PERMANENT_ELEMENT_DEFINITION,
  ARCHITECTURE_REVIEW_CLAUSE,
  BATHROOM_ARCHITECTURE_REVIEW_CLAUSE,
  architectureReviewClauseFor,
} from './preservation-rules.js';

export const STAGIFY_LAUNCH_DATE = new Date(Date.UTC(2025, 7, 22)); // August 22, 2025

export const DESIGNER_ROUTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['response', 'memories', 'staging', 'generate', 'cad', 'imageRequest', 'recall'],
  properties: {
    response: { type: 'string', description: 'Natural-language reply shown to the user.' },
    memories: {
      type: 'object',
      additionalProperties: false,
      required: ['stores', 'forgets'],
      properties: {
        stores: { type: 'array', items: { type: 'string' } },
        forgets: { type: 'array', items: { type: 'string' } },
      },
    },
    staging: {
      type: ['array', 'null'],
      description: 'One entry per room to stage/modify (max 3). null when not staging.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shouldStage', 'roomType', 'additionalPrompt', 'removeFurniture', 'usePreviousImage', 'furnitureImageIndex', 'styleReference', 'disclosure'],
        properties: {
          shouldStage: { type: 'boolean' },
          // Must list every promptMatrix room type, plus 'Other' as the routing-only
          // escape hatch. A room type missing here is silently unreachable from chat:
          // the model falls back to 'Other', which has no matrix entry and so stages
          // from the generic prompt. test/i18n/room-types-i18n.test.js guards the drift.
          roomType: { type: 'string', enum: ['Living room', 'Bedroom', 'Kitchen', 'Bathroom', 'Dining room', 'Office', 'Outdoors', 'Dorm', 'Other'] },
          additionalPrompt: { type: 'string' },
          removeFurniture: { type: 'boolean' },
          usePreviousImage: { anyOf: [{ type: 'boolean' }, { type: 'integer' }], description: 'false = current image; otherwise the history index.' },
          furnitureImageIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          styleReference: { type: 'boolean' },
          // "Label as virtually staged". Shape and reasoning in ./disclosure-rules.js,
          // alongside the prose that tells the model when to fill it in — the two have to
          // agree, so they live together.
          disclosure: DISCLOSURE_ROUTING_FIELD,
        },
      },
    },
    generate: {
      type: ['array', 'null'],
      description: 'One entry per new image to generate from text (max 3). null when not generating.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shouldGenerate', 'prompt'],
        properties: {
          shouldGenerate: { type: 'boolean' },
          prompt: { type: 'string' },
        },
      },
    },
    cad: {
      type: ['array', 'null'],
      description: 'One entry per blueprint/floor-plan to CAD-stage (max 3). null when not CAD-staging.',
      items: {
        type: 'object',
        additionalProperties: false,
        // This schema is STRICT (additionalProperties:false + every property listed
        // here), so a new property that is not also added to `required` makes OpenAI
        // reject the whole request. `view`/`room` were added with that in mind.
        required: ['shouldProcessCAD', 'imageIndex', 'furnitureImageIndex', 'additionalPrompt', 'view', 'room', 'disclosure'],
        properties: {
          shouldProcessCAD: { type: 'boolean' },
          imageIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          furnitureImageIndex: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
          additionalPrompt: { type: 'string' },
          // Which of the two renders to produce. The CONSUMER defaults a missing/unknown
          // value to 'top-down' (lib/staging/cad-handling.js), not the schema — a routing
          // decision replayed from before this field existed must keep its old behaviour.
          view: {
            type: 'string',
            enum: ['top-down', 'eye-level'],
            description: "top-down = a furnished 3D floor plan seen from directly above (DEFAULT). eye-level = a photorealistic interior photo taken standing inside ONE room of the plan.",
          },
          room: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Which room on the plan to render. REQUIRED for eye-level; null for top-down.',
          },
          // Same "label as virtually staged" contract the staging entries use — an
          // eye-level render is a furnished depiction of a real listing, so it carries
          // the same disclosure obligation. See ./disclosure-rules.js.
          disclosure: DISCLOSURE_ROUTING_FIELD,
        },
      },
    },
    imageRequest: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['requestImage', 'imageIndex'],
          properties: {
            requestImage: { type: 'boolean' },
            imageIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
        { type: 'null' },
      ],
    },
    recall: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['shouldRecall', 'imageIndex'],
          properties: {
            shouldRecall: { type: 'boolean' },
            imageIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

export const DESIGNER_ROUTING_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'designer_routing', strict: true, schema: DESIGNER_ROUTING_SCHEMA },
};

// The QA rubrics (QUALITY_REVIEW_PROMPT, MASK_REVIEW_PROMPT) and the shared reply-format
// contract (reviewReplyFormat) moved to ./review-prompts.js — this file was at its 650-line
// ceiling. Re-exported so importers are unchanged.
export { QUALITY_REVIEW_PROMPT, MASK_REVIEW_PROMPT, reviewReplyFormat } from './review-prompts.js';

export const FURNITURE_ERASE_PROMPT = `You are an expert real-estate photo editor. Your ONLY job is to make this interior room completely EMPTY and unfurnished. Remove EVERY single piece of furniture and movable object — leave nothing behind.

REMOVE ALL OF THESE (this list is illustrative, not exhaustive — remove anything like them too):
- Seating: sofas, couches, armchairs, dining chairs, stools, benches, ottomans, bean bags.
- Tables & surfaces: coffee tables, dining tables, side/end tables, desks, console tables, nightstands.
- Storage & casegoods: cabinets, dressers, wardrobes, sideboards, bookshelves, shelving units, TV stands, freestanding shelves — INCLUDING large, heavy, or built-looking pieces that merely sit against a wall.
- Beds and all bedding, headboards, footboards, mattresses.
- Decor & textiles: rugs, curtains, drapes, blinds that aren't fixtures, throw pillows, blankets.
- Wall items: wall art, paintings, posters, hung mirrors, clocks, shelves with objects.
- Lighting & electronics: floor lamps, table lamps, freestanding TVs, monitors, speakers.
- Plants, vases, books, boxes, clutter, and every other movable or staged object, large or small.

CRITICAL RULES:
- Be thorough and complete. Do NOT leave any item behind because it looks large, expensive, heavy, or hard to remove. If it is furniture, decor, or a movable object, it goes — no exceptions unless explicitly told otherwise below.
- FREESTANDING vs BUILT-IN: Remove every freestanding piece even if it is tall, bulky, or pushed flush against a wall (e.g. a standalone cabinet, wardrobe, bookshelf, or dresser). Keep ONLY true architectural built-ins that are permanently part of the structure — fixed kitchen counters and the cabinetry attached to them, bathroom vanities and their fitted mirrors, fitted alcove shelving that is part of the wall, radiators, and fireplaces. When you genuinely cannot tell whether something is furniture or part of the room, LEAVE IT — a room with one extra cabinet can still be staged, a room missing a window cannot.
- Keep the room itself perfectly intact: walls, floor, ceiling, windows, doors, door/window frames, moldings, baseboards, trim, and the exact room geometry must stay UNCHANGED.
- WINDOWS ESPECIALLY: taking down curtains, drapes or blinds removes the FABRIC ONLY. The window behind them survives exactly — same position, same size, same frame, same glazing bars, same glass and same view through it. Never fill in, wall over, shrink or hide a window because its covering is gone. The same goes for a door once a curtain or screen is removed.
- Reconstruct the floor and wall areas that were hidden behind furniture so they look clean, continuous, and photorealistic — no ghosting, shadows, smudges, or leftover outlines of the removed items.
- Preserve the exact camera angle, perspective, framing, lighting, and aspect ratio. Do not crop, zoom, or re-frame.
- Do NOT add any new furniture, objects, or decor. The result must be a believable empty room ready to be staged.`;

export const EMPTY_ROOM_CHECK_PROMPT = `You are looking at a photo of an interior room. Decide whether the room is ALREADY essentially empty of furniture and decor — i.e. a vacant/unfurnished room with at most a few minor leftover items — versus a furnished or staged room containing furniture that would need to be removed.\nReply with EXACTLY "EMPTY: true" if the room is already basically empty, or "EMPTY: false" if it contains furniture/decor worth removing. Output nothing else.`;

// The upload gatekeeper's prompt and its rejection taxonomy moved to
// ./unstageable.js — the two must be edited together, and they no longer fit here.

// System prompt for the returning-user welcome-message generator (/api/welcome-message).
export const WELCOME_MESSAGE_SYSTEM =
  'You are a friendly AI assistant for Stagify.ai. Generate brief, personalized welcome messages.';

// Builds the personalized welcome-message prompt for a returning user, folding in
// any stored memories. Extracted verbatim from the /api/welcome-message handler.
/**
 * Build the returning-user welcome-message generation prompt, folding in stored memories.
 * @param {import('../types/staging.js').StoredMemory[]} [memories] - Stored user memories; each `.content` is folded into a numbered "User information" list (defaults to none).
 * @returns {string} The returning-user welcome-message generation prompt.
 */
export function buildWelcomeMessagePrompt(memories = []) {
  let memoriesContext = '';
  if (memories.length > 0) {
    memoriesContext = '\n\nUser information:\n';
    memories.forEach((memory, index) => {
      memoriesContext += `${index + 1}. ${memory.content}\n`;
    });
  }
  return `Generate a brief, friendly, personalized welcome message for a returning user of Stagify AI Designer.${memoriesContext}

The message should:
- Be warm and welcoming
- Reference something from their previous interactions if relevant
- Be concise (2-3 sentences)
- Mention that you're ready to help with room staging, design questions, or other requests
- Sound natural and conversational

Just return the message text, no additional formatting.`;
}

// Builds the /api/chat system instruction. Extracted verbatim from the handler.
/**
 * Build the full /api/chat system instruction string.
 * @param {{ imageContext: string, memories: import('../types/staging.js').StoredMemory[], dateContext: string, baseSelectionContext: string }} params - Destructured context pieces for the /api/chat system prompt.
 * @returns {string} The full /api/chat system instruction string.
 */
export function buildChatSystemInstruction({ imageContext, memories, dateContext, baseSelectionContext }) {
    let s = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    s += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    s += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    s += 'You can also answer questions about interior design and provide design advice. ';
    s += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    s += '\n- Have friendly, introductory conversations and get to know the user';
    s += '\n- Answer questions about room staging and interior design';
    s += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    s += '\n- Explain Stagify.ai features and functionality';
    s += '\n- Help with file uploads and image processing';
    s += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    s += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    s += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    s += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    s += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    s += imageContext;
    if (memories.length > 0) {
      s += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        s += `${index + 1}. ${memory.content}\n`;
      });
    }
    s += '\n\nYou must respond with a JSON object containing:';
    s += '\n- "response": Your text response to the user';
    s += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    s += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Outdoors"|"Dorm"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|...' + DISCLOSURE_CONTRACT_FRAGMENT + ' } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    s += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", "display", "describe", or "analyze" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    s += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    s += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description. This is a core capability - you can create brand new images from scratch based on user descriptions. Use generation when: (1) user wants to create a NEW image from scratch with no existing image involved, (2) user asks to "generate", "create", "draw", "make", or "design" a new image, (3) user describes a scene/room/space they want to see without uploading or referring to an existing image. DO NOT use generation when they uploaded an image or are referring to a previous image - use staging instead. You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    s += '\n\nIMPORTANT DISTINCTION - You have THREE image capabilities:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image. Staging adds furniture and decor to existing room photos.\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage". CAD-staging converts 2D floor plans into 3D staged renders.\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", "make", or "design" a new image, user describes a scene/room/space they want to see without uploading or referring to an existing image. Generation creates brand new images from scratch based on text descriptions - this is a core capability you have.';
    s += '\n\nSTAGING RULES (for room photos only):';
    s += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    s += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    s += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    s += '\n- Set "roomType": "Dorm" whenever the space is student housing - the user says dorm, dorm room, residence hall, hall of residence, halls, student accommodation/housing, university or college housing, or the photo shows the tell-tale signs (a lofted or raised twin bed on a plain metal frame, a built-in laminate desk with a hutch, a narrow institutional wardrobe, cinder-block walls). Prefer "Dorm" over "Bedroom" in those cases: the Dorm prompt keeps the university-issued desk, bed frame, wardrobe and dresser fixed and enforces small-room scale, which "Bedroom" does not.';
    s += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    s += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    s += '\n- Set "furnitureImageIndex" to the index of a furniture image from a previous message if the user wants to add a specific piece of furniture (e.g., "add that chair", "include the red sofa from before"). The furniture image will be sent to the staging system alongside the room image.';
    s += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    // Deliberately does NOT ask for architecture/framing prose. generatePrompt() appends
    // INTERIOR_PRESERVATION_RULES last, with authority over everything above it; a paraphrase
    // written here would be a second, weaker, per-turn-varying copy of the same rule — and the
    // version this replaced also granted a crop the lock denies. See AI_DESIGNER_IMAGE_FRAMING_RULES.
    s += '\n- The "additionalPrompt" should describe WHAT THE USER ASKED FOR, in detail — the furniture, style, mood, colours and any specific pieces. Do NOT add architecture-preservation, aspect-ratio or cropping instructions to it: the system appends those itself, last and with authority over everything else, so a paraphrase here only competes with them. Never state that a crop, zoom or re-frame is allowed — it is not, on any staging request.';
    s += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    s += DISCLOSURE_STAGING_BULLET;
    s += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    s += '\n\nIMAGE REQUEST RULES:';
    s += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    s += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    s += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    s += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    s += '\n\nRECALL RULES:';
    s += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    s += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    s += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    s += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    s += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    s += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    s += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    s += AI_DESIGNER_CAD_RULES;
    s += AI_DESIGNER_MESSAGE_TAG_RULES;
    s += AI_DESIGNER_RESPONSE_ACTION_RULES;
    s += AI_DESIGNER_IMAGE_FRAMING_RULES;
    s += STAGIFY_SELF_KNOWLEDGE;
    s += dateContext;
    s += baseSelectionContext;
  return s;
}

// Builds the /api/chat-upload core system instruction (image context + base-image
// selection are appended by the handler afterward). Extracted verbatim.
/**
 * Build the /api/chat-upload core system instruction (image + base-image context appended by the caller afterward).
 * @param {{ memories: import('../types/staging.js').StoredMemory[], dateContext: string }} params - Destructured context for the /api/chat-upload core system prompt.
 * @returns {string} The /api/chat-upload core system instruction string.
 */
export function buildChatUploadSystemInstruction({ memories, dateContext }) {
    let s = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    s += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    s += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    s += 'You can also answer questions about interior design and provide design advice. ';
    s += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    s += '\n- Have friendly, introductory conversations and get to know the user';
    s += '\n- Answer questions about room staging and interior design';
    s += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    s += '\n- Explain Stagify.ai features and functionality';
    s += '\n- Help with file uploads and image processing';
    s += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    s += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    s += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    s += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    s += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    if (memories.length > 0) {
      s += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        s += `${index + 1}. ${memory.content}\n`;
      });
    }
    s += '\n\nYou must respond with a JSON object containing:';
    s += '\n- "response": Your text response to the user';
    s += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    s += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Outdoors"|"Dorm"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|...' + DISCLOSURE_CONTRACT_FRAGMENT + ' } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    s += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", or "display" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    s += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description (ONLY use generation when the user wants to create a NEW image from scratch, NOT when they want to modify an existing room image. If they uploaded an image or are referring to a previous image, use staging instead). You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    s += '\n\nIMPORTANT DISTINCTION:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage"\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", or "make" an image of something that is NOT a room modification';
    s += '\n\nSTAGING RULES (for room photos only):';
    s += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    s += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    s += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    s += '\n- Set "roomType": "Dorm" whenever the space is student housing - the user says dorm, dorm room, residence hall, hall of residence, halls, student accommodation/housing, university or college housing, or the photo shows the tell-tale signs (a lofted or raised twin bed on a plain metal frame, a built-in laminate desk with a hutch, a narrow institutional wardrobe, cinder-block walls). Prefer "Dorm" over "Bedroom" in those cases: the Dorm prompt keeps the university-issued desk, bed frame, wardrobe and dresser fixed and enforces small-room scale, which "Bedroom" does not.';
    s += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    s += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    // Deliberately does NOT ask for architecture/framing prose. generatePrompt() appends
    // INTERIOR_PRESERVATION_RULES last, with authority over everything above it; a paraphrase
    // written here would be a second, weaker, per-turn-varying copy of the same rule — and the
    // version this replaced also granted a crop the lock denies. See AI_DESIGNER_IMAGE_FRAMING_RULES.
    s += '\n- The "additionalPrompt" should describe WHAT THE USER ASKED FOR, in detail — the furniture, style, mood, colours and any specific pieces. Do NOT add architecture-preservation, aspect-ratio or cropping instructions to it: the system appends those itself, last and with authority over everything else, so a paraphrase here only competes with them. Never state that a crop, zoom or re-frame is allowed — it is not, on any staging request.';
    s += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    s += DISCLOSURE_STAGING_BULLET;
    s += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    s += '\n\nIMAGE REQUEST RULES:';
    s += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    s += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    s += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    s += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    s += '\n\nRECALL RULES:';
    s += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD-staging renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    s += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    s += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    s += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    s += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    s += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    s += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    s += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    s += AI_DESIGNER_CAD_RULES;
    s += AI_DESIGNER_MESSAGE_TAG_RULES;
    s += AI_DESIGNER_RESPONSE_ACTION_RULES;
    s += AI_DESIGNER_IMAGE_FRAMING_RULES;
    s += STAGIFY_SELF_KNOWLEDGE;
    s += dateContext;
  return s;
}

/**
 * Generate styling prompt based on user preferences using a matrix system
 */
/**
 * Build the virtual-staging prompt for a room-type + furniture-style combination (looked up
 * in promptMatrix), appending any additional instructions and either a furniture-removal or
 * a keep-existing-furniture clause.
 * @param {string} roomType - Room-type key (e.g. 'Bedroom', 'Living room').
 * @param {string} [furnitureStyle] - Furniture-style key (e.g. 'modern', 'standard'); falls back to 'standard'.
 * @param {string} [additionalPrompt] - Extra user instructions appended to the base prompt.
 * @param {boolean | string} [removeFurniture] - Truthy → instruct removal of existing furniture; falsy → keep it and only add complementary pieces.
 * @returns {string} The assembled staging prompt.
 */
export function generatePrompt(roomType, furnitureStyle, additionalPrompt, removeFurniture) {

  // Add furniture removal instruction if requested. Callers pass a real boolean
  // (removeBool) in the live flow; older/string callers pass 'true' — accept both.
  removeFurniture = removeFurniture === true || removeFurniture === 'true';
  const furnitureRemovalText = removeFurniture
    ? "First, remove all existing furniture and decor from the room. Then, "
    : "CRITICAL — KEEP EXISTING FURNITURE: If the room already contains furniture or decor, you MUST preserve every existing piece exactly as it appears — do NOT remove, replace, delete, or relocate any furniture, decor, or belongings already in the photo. Keep their position, style, and appearance unchanged, and only add or rearrange NEW furnishings around what is already there to complete a professional staging. (If, and only if, the room is completely empty, stage it from scratch as normal.) ";

  // When furniture is being KEPT, the base staging text below is a full shopping
  // list ("Add a bed, matching nightstands, a dresser…"). Left unqualified the model
  // reads that as a from-scratch restage and swaps out what's already in the room —
  // the exact opposite of keeping it. This clause reframes that list as STYLE
  // guidance so existing pieces stay and only genuinely missing pieces get added.
  //
  // Scoped to the items the matrix asks it to ADD, and deliberately not to "anything named
  // above". Kitchen and Bathroom entries now OPEN with a keep-clause ("keeping the existing
  // cabinetry, counters, backsplash, sink and built-in appliances exactly as photographed"),
  // and the unscoped wording told the model to treat those as changeable style guidance —
  // flatly contradicting the sentence immediately before it.
  const keepFurnitureClarifier = removeFurniture
    ? ''
    : " IMPORTANT — because the existing furniture is being KEPT, treat the furniture and decor listed above FOR YOU TO ADD as a guide to the desired STYLE only, NOT a checklist of items to place from scratch. This does not loosen anything above that you were told to keep exactly as photographed — that still holds. Do NOT remove, replace, or swap out furniture that is already in the room. Only ADD new complementary pieces in that style to fill empty or sparse areas, and leave every existing item exactly where and how it is.";
  
  // Build the base prompt
  let basePrompt = `Stage this ${roomType} professionally.`;
  
  // If custom style with additional prompt, use the additional prompt as the main instruction
  if (furnitureStyle === 'custom' && additionalPrompt && additionalPrompt.trim()) {
    basePrompt = additionalPrompt.trim();
  } else {
    // Get the specific prompt for this room type and style combination (fallback).
    //
    // 'custom' with an EMPTY box resolves to `standard`, not to the matrix's own 'custom'
    // entry. That entry reads "Stage this <room> with the furniture and decor the user asks
    // for" — which, when the user asked for nothing, is a null instruction that leaves the
    // model to improvise the whole room, architecture included. The picker lets anyone
    // select Custom and type nothing, so this is a reachable state, not a theoretical one.
    const effectiveStyle = furnitureStyle === 'custom' ? 'standard' : furnitureStyle;
    basePrompt = promptMatrix[roomType]?.[effectiveStyle] || promptMatrix[roomType]?.['standard'] || basePrompt;
  }
  
  // Room types with non-negotiable rules (e.g. a dorm's fixed university-issued desk and
  // bed frame) emit an extra block here, after the removal clause so it outranks it.
  const roomConstraints = ROOM_TYPE_CONSTRAINTS[roomType]
    ? `\n\n${ROOM_TYPE_CONSTRAINTS[roomType]}`
    : '';

  // Build the complete prompt
  let prompt = `${furnitureRemovalText}${basePrompt}${keepFurnitureClarifier}${roomConstraints}

${REALISTIC_DEFECT_FREE_RULES}

TARGETED-EDIT RULE (when the user is refining an already-staged image):
- If the request is a specific change (e.g. "make the sofa leather", "warmer lighting", "swap the rug"), apply ONLY that change and keep EVERYTHING else identical — same furniture, decor, placement, colors, camera angle, and lighting as the input image. Do not re-stage the room from scratch or move/replace items that were not mentioned.

Deliver a photorealistic, professionally staged result: sharp focus, detailed textures, and professional photography lighting.`;

  // The user's own words. Scoped deliberately to the STYLE guidance — this used to read
  // "Prioritize the following above everything else", which sat ~2,500 characters after
  // the architecture rule and therefore told the model, in as many words, that "make it
  // feel bright and open" outranked "do not resize the windows". It obliged.
  if (furnitureStyle !== 'custom' && additionalPrompt && additionalPrompt.trim()) {
    prompt += ` Prioritize the following over the style guidance above: ${additionalPrompt.trim()}`;
  }

  // LAST, and that position is the whole point — see ./preservation-rules.js. The block
  // claims authority over everything above it including the free text just appended, and
  // a claim like that is only true if nothing follows it. Do not move this, and do not
  // append anything after it. test/staging/prompts.test.js pins the ordering.
  prompt += `\n\n${interiorPreservationRulesFor(roomType)}`;

  return prompt;
}

// The quality-retry loop hands each regeneration the previous attempt's QA verdict
// so the retry can TARGET the specific defect instead of blindly re-rolling. The
// reviewer names the problem on a "WHY: ..." line (reviewImageQuality always asks
// for it now); we lift that out and, failing that, fall back to a generic nudge.
/**
 * Build a corrective prompt suffix from the previous attempt's QA verdict so a
 * regeneration targets the named defect instead of re-rolling blindly. Parses the
 * reviewer's "WHY: ..." line out of its raw `reason`; falls back to a generic nudge
 * when no specific defect text is present. Returns '' when there is no usable
 * feedback (first attempt, a null verdict, or a passing image).
 * @param {{ perfect?: boolean, score?: number, reason?: string } | null} [review] - The previous attempt's QA result (as returned by reviewImageQuality).
 * @returns {string} A corrective suffix to append to the generation prompt (empty when not applicable).
 */
export function qualityRetryFeedbackSuffix(review) {
  if (!review || review.perfect) return '';
  const raw = typeof review.reason === 'string' ? review.reason : '';
  const m = raw.match(/WHY:\s*(.+)/i);
  const defect = m && m[1] ? m[1].trim() : '';
  const problem = defect
    ? `the following specific problem: "${defect}"`
    : 'a visible quality defect';
  return `\n\nAUTOMATED QA — REVISION NEEDED: A previous attempt at this image was rejected for ${problem}. Produce a NEW result that specifically fixes that issue while still obeying every rule above. Do not repeat that mistake.`;
}

// The model has no idea what today's date is, so left alone it guesses (e.g.
// "today is 2023, so Stagify launches in the future"). Give it the real current
// date plus the already-computed age so it never has to do date math itself.
/**
 * Build the current-date context block (launch date + today's date) injected into system
 * prompts so the model can reason about time.
 * @returns {string} The date-context prompt block.
 */
export function getStagifyDateContext() {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  const todayStr = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;

  let ageStr;
  if (now < STAGIFY_LAUNCH_DATE) {
    ageStr = 'Stagify has not launched yet';
  } else {
    let months = (now.getUTCFullYear() - STAGIFY_LAUNCH_DATE.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - STAGIFY_LAUNCH_DATE.getUTCMonth());
    if (now.getUTCDate() < STAGIFY_LAUNCH_DATE.getUTCDate()) months -= 1;
    if (months < 1) {
      ageStr = 'Stagify is less than a month old';
    } else if (months < 12) {
      ageStr = `Stagify is about ${months} month${months === 1 ? '' : 's'} old`;
    } else {
      const years = Math.floor(months / 12);
      const rem = months % 12;
      ageStr = `Stagify is about ${years} year${years === 1 ? '' : 's'}` +
        (rem ? ` and ${rem} month${rem === 1 ? '' : 's'}` : '') + ' old';
    }
  }
  return `\n\nCURRENT DATE (authoritative — use this and do NOT assume any other date): Today is ${todayStr}. ` +
    `Stagify launched on August 22, 2025, so as of today, ${ageStr}. ` +
    `When asked how old Stagify is, state that age; never say it launches in the future.`;
}

// When the extra image(s) are an aesthetic/style reference rather than specific
// furniture to place, instruct the model to emulate the look — not copy objects.
/**
 * Build the prompt suffix describing how many style-reference images were attached.
 * @param {number} count - Number of style-reference images.
 * @returns {string} The style-reference prompt suffix (empty when count is 0).
 */
export function styleReferencePromptSuffix(count) {
  if (count <= 0) return '';
  const listText =
    count === 1
      ? 'The second image is'
      : 'The additional images after the room photo are';
  return `\n\nIMPORTANT: ${listText} a STYLE REFERENCE, not furniture to copy. Match its overall aesthetic — color palette, materials, mood, and design style — when staging the room. Do NOT copy its exact objects, layout, room, or camera angle. The first image is the room to stage; keep that room's architecture, dimensions, windows, and viewpoint unchanged.`;
}

/**
 * Build the prompt suffix describing the attached mask-edit reference image.
 * @param {{ region?: string, boundary?: string }} [loc] - The locator wording used by
 *   the caller so this suffix names the SAME region/boundary as the main prompt (e.g.
 *   the magenta outline on the normal path). Defaults to the plain white-mask wording.
 * @returns {string} The mask-reference prompt suffix.
 */
export function maskReferencePromptSuffix(loc) {
  const region = loc?.region || 'the white masked region';
  const boundary = loc?.boundary || 'the white boundary';
  return `\n\nIMPORTANT — REFERENCE IMAGE: A final reference image is provided as the LAST image (after the room photo and the highlighted room). Treat it as the visual source for the user's instruction above — typically the specific furniture, decor, object, fixture, material, or finish they want applied inside ${region}. Recreate the referenced subject so it is clearly the SAME item — keep its design, colors, materials, textures, proportions, and distinctive details. Its IDENTITY is what must stay faithful, NOT its camera angle or orientation: you SHOULD and MUST freely ROTATE, turn, and re-angle the subject — even showing it from a completely different side than the reference photo — whenever that is needed to fit the highlighted area and sit naturally in the room. Re-orient it to match the room's perspective and vanishing lines and to rest correctly on the floor, surface, or along the wall the user indicates (for example, turn a sofa shown head-on in the reference so it runs ALONG the wall in proper receding perspective, rather than facing the camera). Never refuse to rotate or re-angle the object just to keep the reference's original viewpoint — preserving the reference camera angle at the cost of a natural fit is WRONG. Then adapt it to the scene so it looks naturally photographed in place — match the highlighted area's perspective, scale, lighting direction, shadows, and reflections, ground it realistically with correct contact shadows and no floating, and render it as a fully opaque, solid object — never semi-transparent, see-through, or ghosted. Use ONLY the physical object/subject from the reference image — treat it as a clean cut-out and extract just that object. COMPLETELY DISCARD everything in the reference that is not the object itself: its background and backdrop (including any plain white, grey, gradient, or studio backdrop), the floor or surface it stands on in the reference, its own lighting, framing, watermarks, surrounding objects, and any transparent or empty padding. NEVER copy, paint, extend, or bleed the reference's background or backdrop into the room — do NOT add a white, pale, or colored patch, panel, slab, rug, or floor area taken from the reference, and do NOT mistake the reference's backdrop for floor, wall, or surface. The object must sit directly on the room's OWN existing floor or surface, surrounded only by the room's existing content, with fresh contact shadows that match the room's lighting. Apply the result strictly within ${region} and blend its edges seamlessly with the surroundings. If the referenced subject is a rug, carpet, flooring, or other flat surface covering, it must cover ONLY ${region} and stop at ${boundary} — do NOT spread it across the rest of the floor or wall, no matter how large such an item usually is. Otherwise size the referenced subject so the WHOLE of it — including any legs, overhang, and contact shadow — fits completely inside ${region} with a small margin from the edge; scale it down as needed and never let any part reach, touch, or cross ${boundary}, or it will be cut off. Do not change anything outside ${region}. The OUTPUT image MUST keep the EXACT same width, height, and aspect ratio as the FIRST (room) image — never resize, crop, stretch, or reshape the output to match the reference image's dimensions.`;
}

// Ordinal words for the reference images that follow the room photo (image 1). Up to
// 5 furniture refs are supported (see stagingProcessUpload / normalizeFurnitureBuffers),
// i.e. images 2–6, so we need "second" … "sixth".
const REFERENCE_IMAGE_ORDINALS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];

/**
 * Join ordinal words into a natural-language list with an Oxford comma
 * ('second' / 'second and third' / 'second, third, and fourth' / …).
 * @param {string[]} words - Ordinal words to join.
 * @returns {string} The joined phrase (empty string for an empty list).
 */
function joinOrdinals(words) {
  if (words.length <= 1) return words[0] || '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

/**
 * Build the prompt suffix describing attached furniture-reference images.
 * @param {number} count - Number of furniture-reference images.
 * @param {boolean} [preserveExistingStaging=false] - When true, instruct that existing staging be preserved while incorporating the references.
 * @returns {string} The furniture-reference prompt suffix (empty when count is 0).
 */
export function furnitureReferencePromptSuffix(count, preserveExistingStaging = false) {
  if (count <= 0) return '';
  // The room photo is image 1; the references are images 2..(count+1). Enumerate ALL of
  // them so 4–5 refs aren't silently undercounted (the old text stopped at "fourth",
  // telling the model the 4th/5th reference wasn't furniture).
  const refWords = Array.from({ length: count }, (_, i) => REFERENCE_IMAGE_ORDINALS[i] || `#${i + 2}`);
  const listText = count === 1 ? 'The second image' : `The ${joinOrdinals(refWords)} images`;
  const pieceWord = count === 1 ? 'piece' : 'pieces';
  let suffix = `\n\nIMPORTANT: ${listText} provided after the room photo ${count === 1 ? 'is' : 'are'} reference furniture ${pieceWord} that the user wants incorporated into the staged room. Match each item's style, color, and appearance as closely as possible. Use all reference images as guidance for what to place in the space. Use ONLY the furniture object(s) themselves — treat each reference as a clean cut-out. COMPLETELY DISCARD everything in the reference photos that is not the furniture: any plain white, grey, gradient, or studio backdrop, the floor or surface the item sits on in the reference, its own lighting, framing, watermarks, and surrounding objects. NEVER copy, paint, or bleed a reference's background into the room — do NOT add a white, pale, or colored patch, panel, slab, rug, or floor area from it, and do NOT mistake a reference's backdrop for floor, wall, or surface. Place each piece directly onto the room's own existing floor or surface, with fresh contact shadows that match the room's lighting.`;
  if (preserveExistingStaging) {
    suffix +=
      '\n\nCRITICAL: The first image is an ALREADY-STAGED ROOM. Keep every existing element in that photo exactly as shown — same walls, windows, layout, camera angle, lighting, and all furniture/decor already present. ONLY add the reference furniture piece(s). Do not generate a different room. Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the original photo.';
  }
  return suffix;
}
