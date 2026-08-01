// The DESIGN BIBLE: the locked, per-room description of the furniture that a hero
// frame was actually staged with, so every OTHER frame of the same room can be
// conditioned on it instead of hallucinating a fresh living room per photo.
//
// Shape is driven by one requirement: it must be CHECKABLE PER ITEM. Furniture is a
// list of `pieces` keyed by `slot` rather than prose, so the consistency reviewer can
// score "sofa: match / rug: mismatch" and a retry can target the named slot.
//
// FAIL-OPEN IS DIFFERENT HERE. Every other Gemini reviewer in this codebase
// (lib/image/image-review.js) fails open SILENTLY because it is a *gate*: letting a
// borderline image through costs nothing worse than a slightly worse render. A design
// bible is not a gate, it is a *promise* — "every photo of this room shows the same
// furniture". So when extraction fails we return null AND log at warn, and the caller
// MUST record "no bible for this room" and surface that in the UI. Swallowing the
// failure would mean shipping visibly inconsistent frames under a "consistent listing"
// label, which is worse than shipping no claim at all.
//
// Consumed by: the listing pipeline (extract once per room, off the hero frame) and
// lib/staging/prompts.js (bibleSummaryLines → the injected prompt block).
import { logger } from '../logger.js';

/**
 * Schema version stamped onto every bible. Bump when the document shape changes so a
 * persisted bible from an older release can be detected rather than misread.
 * @type {number}
 */
export const BIBLE_SCHEMA_VERSION = 1;

/**
 * The palette slots we keep, in the canonical order used by both `normalizeBible` and
 * `bibleSummaryLines`. Iterating this array (instead of the model's key order) is what
 * makes the summary block byte-stable across extractions.
 * @type {readonly string[]}
 */
const PALETTE_KEYS = ['walls', 'primary', 'secondary', 'accent', 'metal', 'wood'];

/**
 * The lighting slots we keep, in canonical order. Same determinism argument as PALETTE_KEYS.
 * @type {readonly string[]}
 */
const LIGHTING_KEYS = ['direction', 'temperature', 'timeOfDay'];

// Trust-boundary caps. Model output lands straight in a prompt for every later frame,
// so each free-text field is bounded: a runaway "identity" would crowd out the rest of
// the bible in the support-frame prompt, and 400 chars is already far more than a
// reproducible description needs.
const MAX_IDENTITY = 400;
const MAX_PLACEMENT = 200;
const MAX_NEGATIVE = 160;
const MAX_SLOT = 40;
const MAX_SWATCH = 120;   // one palette / lighting value
const MAX_PIECES = 14;
const MAX_NEGATIVES = 8;

/** @typedef {import('../types/projects.js').DesignBible} DesignBible */
/** @typedef {import('../types/projects.js').BiblePiece} BiblePiece */

/**
 * Gemini `responseSchema` for the extraction call (structured-output mode: the installed
 * @google/generative-ai 0.24.1 forwards `generationConfig` wholesale, so `responseSchema`
 * rides through to the API).
 *
 * Deliberately does NOT declare `version`, `roomKey`, `roomType` or `furnitureStyle`:
 * those are stamped server-side by `normalizeBible` from the caller's context. If the
 * model could emit `roomKey` it could redirect a bible onto another room, silently
 * cross-contaminating two rooms' furniture.
 * @type {{ type: string, properties: Record<string, unknown>, required: string[] }}
 */
export const DESIGN_BIBLE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    palette: {
      type: 'object',
      properties: {
        walls: { type: 'string' },
        primary: { type: 'string' },
        secondary: { type: 'string' },
        accent: { type: 'string' },
        metal: { type: 'string' },
        wood: { type: 'string' },
      },
      required: ['walls', 'primary', 'secondary', 'accent', 'metal', 'wood'],
    },
    lighting: {
      type: 'object',
      properties: {
        direction: { type: 'string' },
        temperature: { type: 'string' },
        timeOfDay: { type: 'string' },
      },
      required: ['direction', 'temperature', 'timeOfDay'],
    },
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'string' },
          identity: { type: 'string' },
          placement: { type: 'string' },
          critical: { type: 'boolean' },
        },
        required: ['slot', 'identity', 'placement', 'critical'],
      },
    },
    negatives: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['palette', 'lighting', 'pieces', 'negatives'],
};

/**
 * The extraction instruction. Exported so a test can pin the rules that matter: the ban
 * on camera-relative wording in `identity`, the fact-not-adjective demand, the
 * `critical` threshold, and the 3–8 negatives.
 * @type {string}
 */
export const BIBLE_EXTRACTION_PROMPT = [
  'You are writing the locked DESIGN BIBLE for one staged room of a real-estate listing.',
  'Other photographs of THIS SAME room, taken from other positions, will be staged later',
  'and conditioned on nothing but the words you write here. Describe the furniture and',
  'finishes that are ACTUALLY in the image.',
  '',
  'pieces — one entry per distinct piece of furniture or decor you can see.',
  '  slot: a short lowercase noun naming the piece\'s ROLE in the room ("sofa", "rug",',
  '    "coffee-table", "bed", "nightstands", "artwork-above-sofa"). Use each slot at',
  '    most once.',
  '  identity: the piece\'s REPRODUCIBLE identity. Give countable, checkable facts:',
  '    form and seat count, upholstery material and weave or texture, colour, leg count',
  '    plus leg shape plus leg material, cushion count, rug pile height and weave, wood',
  '    species and finish, metal finish, door or drawer count. Vague adjectives',
  '    ("stylish", "cozy", "modern", "elegant", "beautiful") are worthless here because',
  '    they constrain nothing — replace every adjective with a fact.',
  '    NEVER use camera-relative or angle-dependent language in identity: no "on the',
  '    left", "in the foreground", "nearest the camera", "behind the frame", "at the back',
  '    of the shot". The next photo of this room is taken from somewhere else, where',
  '    those words are wrong or meaningless.',
  '  placement: where the piece sits relative to the ARCHITECTURE — walls, windows,',
  '    doorways, fireplace, kitchen island, stairs. For example "against the long wall',
  '    opposite the window". This is the one field where relative wording belongs.',
  '  critical: true ONLY for the large, defining pieces whose substitution would be',
  '    immediately obvious — seating, beds, rugs, dining and coffee tables, cabinetry,',
  '    large case goods. false for plants, throw pillows, books, candles, trays, vases',
  '    and other small accessories.',
  '',
  'palette — one short phrase per slot: walls, primary, secondary, accent, metal, wood.',
  'lighting — direction (relative to the room, e.g. "window on the long wall"),',
  '  temperature (e.g. "warm daylight ~4800K"), and timeOfDay.',
  '',
  'negatives — 3 to 8 short "no ..." phrases naming what must NOT appear in any other',
  '  photo of this room. Spend real effort here: in practice, naming the wrong thing',
  '  suppresses drift better than describing the right thing does. Name the specific',
  '  substitution a generator would plausibly reach for — "no tufted or chesterfield',
  '  upholstery" when this sofa is smooth, "no chrome or black metal" when these legs',
  '  are walnut, "no patterned or high-pile rug" when this one is flat sisal.',
  '',
  'Describe only what you can actually see. Do not invent pieces that are not in the',
  'photo, and do not describe the photograph itself (no "this image shows", no framing,',
  'cropping or composition notes). Reply with JSON only.',
].join('\n');

// Parse a `data:<mime>;base64,...` URL into a Gemini inlineData part; null when the
// string is not a base64 data URL, so we can bail instead of sending garbage.
// (Same parser as lib/image/image-review.js.)
function dataUrlToPart(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
}

// Tolerant JSON extractor: structured-output mode should hand back bare JSON, but a
// model that ignores responseMimeType wraps it in ``` fences or prose. Strip fences,
// then fall back to the outermost {...}. Same shape of defence as lib/staging/segment.js.
function parseModelJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(body);
  } catch { /* fall through to the outermost-object scan */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Coerce anything to a trimmed string capped at `max`. Objects/arrays/null all collapse
// to '' rather than "[object Object]" because `String(x || '')` is only applied to
// primitives here — see clampText's typeof guard.
function clampText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value || '').trim().slice(0, max);
}

// Normalize a slot name: lowercase, spaces → hyphens, drop everything outside [a-z0-9-].
// Slots are identifiers (the consistency reviewer scores per slot and a retry names one),
// so they must survive a JSON round-trip and a CSV column untouched.
function normalizeSlot(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, MAX_SLOT);
}

// Keep only the known keys of a palette/lighting sub-object, in canonical order, dropping
// empties. A missing or non-object input yields {} rather than throwing: an extraction
// that nailed the furniture but skipped the palette is still worth keeping.
function pickSwatches(source, keys) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const key of keys) {
    const value = clampText(/** @type {Record<string, unknown>} */ (source)[key], MAX_SWATCH);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Turn untrusted model output into a valid DesignBible, or reject it.
 *
 * This is where every trust boundary for the feature lives: field types, length caps,
 * slot identifiers, list caps, and — most importantly — the fact that the room identity
 * comes from the CALLER, never from the model.
 * @param {unknown} raw - Parsed model output (any shape, including junk).
 * @param {{ roomKey?: string, roomType?: string, furnitureStyle?: string }} [ctx] - Room identity, stamped onto the result. Never read from `raw`.
 * @returns {DesignBible | null} A valid bible, or null when `raw` is not an object or has no usable pieces.
 */
export function normalizeBible(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);

  /** @type {BiblePiece[]} */
  const pieces = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  const rawPieces = Array.isArray(src.pieces) ? src.pieces : [];
  for (const entry of rawPieces) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = /** @type {Record<string, unknown>} */ (entry);
    const slot = normalizeSlot(item.slot);
    const identity = clampText(item.identity, MAX_IDENTITY);
    // A piece with no slot cannot be scored or retried, and one with no identity says
    // nothing reproducible — either way it is noise in every downstream prompt.
    if (!slot || !identity) continue;
    /** @type {BiblePiece} */
    const piece = {
      slot,
      identity,
      placement: clampText(item.placement, MAX_PLACEMENT),
      critical: Boolean(item.critical),
    };
    const existingIndex = seen.get(slot);
    if (existingIndex === undefined) {
      seen.set(slot, pieces.length);
      pieces.push(piece);
      continue;
    }
    // Duplicate slot. The surviving entry keeps the FIRST occurrence's position (so
    // ordering stays a function of the model's own emission order and the summary block
    // is stable), but a critical:true duplicate SUPERSEDES a critical:false one.
    // Criticality drives the per-slot consistency gate: keeping the non-critical version
    // would silently exempt a defining piece from review, whereas keeping the critical
    // version at worst buys a stricter check on a minor piece.
    if (piece.critical && !pieces[existingIndex].critical) pieces[existingIndex] = piece;
  }
  if (!pieces.length) return null;

  const rawNegatives = Array.isArray(src.negatives) ? src.negatives : [];
  /** @type {string[]} */
  const negatives = [];
  for (const value of rawNegatives) {
    const text = clampText(value, MAX_NEGATIVE);
    if (text) negatives.push(text);
    if (negatives.length >= MAX_NEGATIVES) break;
  }

  return {
    // Room identity is stamped from the caller's context, NEVER from `raw`. A model that
    // could set roomKey could point this bible at a different room and cross-contaminate
    // two rooms' furniture; version is ours for the same reason.
    version: BIBLE_SCHEMA_VERSION,
    roomKey: clampText(ctx.roomKey, MAX_SLOT * 2),
    roomType: clampText(ctx.roomType, 60),
    furnitureStyle: clampText(ctx.furnitureStyle, 40),
    palette: pickSwatches(src.palette, PALETTE_KEYS),
    lighting: pickSwatches(src.lighting, LIGHTING_KEYS),
    // Critical pieces FIRST, then the cap. Slicing in the model's own emission order let
    // the cap delete exactly the pieces that matter: a room where the model happened to
    // list 14 accessories before the sofa and the bed came out with ZERO critical pieces,
    // which then cascades — `designBiblePromptSuffix` emits no "MUST match exactly" block,
    // `reviewDesignConsistency` early-returns "no critical pieces" as passing, and the
    // room's frames are recorded as continuity-clean without anything having been compared.
    //
    // A stable partition, not a sort: within each group the model's order is preserved,
    // because it tends to emit the most prominent piece of each kind first. This is also
    // what makes `criticalSlots` and the prompt's critical/secondary split agree with the
    // stored order rather than merely happening to.
    pieces: [...pieces.filter((p) => p.critical), ...pieces.filter((p) => !p.critical)].slice(0, MAX_PIECES),
    negatives,
  };
}

/**
 * The slots the consistency reviewer must score, in bible order. These are the pieces
 * whose substitution would be obvious to a buyer scrolling the listing.
 * @param {DesignBible | null | undefined} bible - A normalized bible (or null).
 * @returns {string[]} The `slot` of every critical piece; empty for a null bible.
 */
export function criticalSlots(bible) {
  if (!bible || !Array.isArray(bible.pieces)) return [];
  return bible.pieces.filter((p) => p && p.critical).map((p) => p.slot);
}

/**
 * Render the bible as a deterministic block of plain-text lines: room, palette, lighting,
 * critical pieces, non-critical pieces, then negatives.
 *
 * Ordering is a CONTRACT — lib/staging/prompts.js builds the injected support-frame
 * prompt from these lines, and a test pins the exact output for a fixture so the two
 * cannot drift. Palette and lighting iterate the canonical key arrays rather than the
 * object's own key order, so the block is byte-stable regardless of how the model (or a
 * JSON round-trip) ordered them.
 * @param {DesignBible | null | undefined} bible - A normalized bible (or null).
 * @returns {string[]} Plain-text lines; empty array for a null/piece-less bible.
 */
export function bibleSummaryLines(bible) {
  if (!bible || !Array.isArray(bible.pieces) || !bible.pieces.length) return [];
  /** @type {string[]} */
  const lines = [];

  const style = bible.furnitureStyle ? ` (${bible.furnitureStyle} style)` : '';
  lines.push(`Room: ${bible.roomType || 'unspecified'}${style}`);

  const palette = PALETTE_KEYS
    .map((k) => (bible.palette && bible.palette[k] ? `${k} ${bible.palette[k]}` : ''))
    .filter(Boolean);
  if (palette.length) lines.push(`Palette: ${palette.join('; ')}`);

  const lighting = LIGHTING_KEYS
    .map((k) => (bible.lighting && bible.lighting[k] ? `${k} ${bible.lighting[k]}` : ''))
    .filter(Boolean);
  if (lighting.length) lines.push(`Lighting: ${lighting.join('; ')}`);

  const pieceLine = (p) => {
    const tail = p.placement ? ` | placement: ${p.placement}` : '';
    return `- ${p.slot}: ${p.identity}${tail}`;
  };
  const critical = bible.pieces.filter((p) => p.critical);
  const minor = bible.pieces.filter((p) => !p.critical);
  if (critical.length) {
    lines.push('Locked pieces (must be the same objects in every photo of this room):');
    for (const p of critical) lines.push(pieceLine(p));
  }
  if (minor.length) {
    lines.push('Secondary pieces (keep consistent, minor variation tolerated):');
    for (const p of minor) lines.push(pieceLine(p));
  }
  if (bible.negatives && bible.negatives.length) {
    lines.push('Never include:');
    for (const n of bible.negatives) lines.push(`- ${n}`);
  }
  return lines;
}

// gemini-2.5-flash, NOT flash-lite: extraction runs ONCE PER ROOM (not per frame), so
// its cost is a rounding error while its quality decides whether every other frame of
// that room is consistent. Thinking is off — with thinking ON the output-token budget is
// spent on reasoning and starves the visible JSON (see lib/staging/segment.js).
const BIBLE_MODEL = 'gemini-2.5-flash';
const BIBLE_MAX_TOKENS = 2048;

/**
 * Build the design-bible extractor bound to the injected Gemini client.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null }} deps - Injected Gemini client, typed structurally around the used `getGenerativeModel().generateContent` (the SDK's strict content-part and GenerationConfig types reject these dynamically-built payloads and the newer `thinkingConfig` field). Extraction returns null when it is null.
 * @returns {{ extractBible: (heroDataUrl: string, ctx: { roomKey?: string, roomType?: string, furnitureStyle?: string }) => Promise<DesignBible | null> }} The extractor API.
 */
export function createDesignBible({ genAI }) {
  /**
   * Extract the locked design bible from a staged hero frame.
   *
   * Returns null — and logs the reason at warn — on a null client, a thrown model error,
   * an unparseable reply, or a normalizeBible rejection. The caller MUST treat null as
   * "consistency was not enforced for this room" and say so in the UI; see the file
   * header for why this failure cannot be silent.
   * @param {string} heroDataUrl - The staged hero image as a base64 `data:` URL.
   * @param {{ roomKey?: string, roomType?: string, furnitureStyle?: string }} ctx - Room identity, stamped onto the result instead of being read from the model.
   * @returns {Promise<DesignBible | null>} The bible, or null on any failure.
   */
  async function extractBible(heroDataUrl, ctx) {
    const roomKey = (ctx && ctx.roomKey) || '(unknown room)';
    if (!genAI) {
      logger.warn(`[Bible] extraction skipped for ${roomKey}: Gemini client not configured — record "no bible" for this room`);
      return null;
    }
    const imagePart = dataUrlToPart(heroDataUrl);
    if (!imagePart) {
      logger.warn(`[Bible] extraction failed for ${roomKey}: hero frame is not a base64 data URL`);
      return null;
    }
    try {
      const model = genAI.getGenerativeModel({
        model: BIBLE_MODEL,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: BIBLE_MAX_TOKENS,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
          responseSchema: DESIGN_BIBLE_RESPONSE_SCHEMA,
        },
      });
      const result = await model.generateContent([{ text: BIBLE_EXTRACTION_PROMPT }, imagePart]);
      const response = await result.response;
      const parsed = parseModelJson(response.text());
      if (!parsed) {
        logger.warn(`[Bible] extraction failed for ${roomKey}: model reply was not JSON`);
        return null;
      }
      const bible = normalizeBible(parsed, ctx || {});
      if (!bible) {
        logger.warn(`[Bible] extraction failed for ${roomKey}: model JSON had no usable pieces`);
        return null;
      }
      return bible;
    } catch (error) {
      logger.warn(`[Bible] extraction failed for ${roomKey}: ${error && error.message}`);
      return null;
    }
  }

  return { extractBible };
}
