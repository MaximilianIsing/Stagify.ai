// Room clustering for multi-photo listings: label each uploaded photo with the room it
// shows, group the photos that show the SAME room, and pick the one frame per room whose
// staging becomes that room's design bible (lib/staging/design-bible.js).
//
// Why grouping is conservative: a photo forced into the wrong group is conditioned on
// another room's design bible, which cross-contaminates two rooms at once and is far
// harder to spot than an unassigned photo. So a photo whose label failed gets
// `roomKey = null` and waits for the operator, rather than being guessed into a group.
//
// The room-type vocabulary is imported from lib/staging/promptMatrix.js, never re-listed
// here — a hand-copied vocabulary is exactly how five copies of the language list once
// accumulated in this repo.
import { logger } from '../logger.js';
import { downscaleImage } from '../image/image-primitives.js';
import { promptMatrix } from './promptMatrix.js';

/**
 * The room type used when a photo shows something outside the staging vocabulary
 * (a facade, a garage, a stairwell). Kept out of promptMatrix because it has no
 * staging prompts — it exists so the labeller never has to invent a key.
 * @type {string}
 */
export const OTHER_ROOM_TYPE = 'Other';

/**
 * The closed set of room types the labeller may return: every promptMatrix key plus
 * `OTHER_ROOM_TYPE`. Derived, never hand-listed, so adding a room type to promptMatrix
 * automatically widens the labeller.
 * @type {string[]}
 */
export const ROOM_LABEL_TYPES = [...Object.keys(promptMatrix), OTHER_ROOM_TYPE];

/**
 * The labelling instruction. The room-type enum is interpolated from
 * `ROOM_LABEL_TYPES`, so the prompt and the accepted values cannot drift.
 * @type {string}
 */
export const ROOM_LABEL_PROMPT = [
  'You are sorting the photographs of one property listing by which room each photo shows.',
  '',
  'Answer with JSON containing exactly these fields:',
  `  roomType: EXACTLY one of these values, copied character for character — ${ROOM_LABEL_TYPES.map((t) => `"${t}"`).join(', ')}.`,
  `    Use "${OTHER_ROOM_TYPE}" for anything else (an exterior facade, garage, stairwell,`,
  '    hallway, closet, laundry, or a photo that shows no room at all).',
  '  roomLabel: a short lowercase human name that distinguishes THIS room from other',
  '    rooms of the same type in the same house — "primary bedroom", "second bedroom",',
  '    "upstairs bath", "kitchen", "basement family room". Two photos of the same room',
  '    must get the SAME roomLabel, and two different bedrooms must get DIFFERENT ones,',
  '    so base it on durable evidence: room size, window count and placement, flooring,',
  '    fixtures, built-ins, and whether it looks like the main or a secondary room.',
  '  isWide: true when this is a wide establishing shot showing most of the room, false',
  '    when it is a tight detail, corner, or close-up of one feature.',
  '  confidence: your confidence in roomType and roomLabel, from 0 to 1.',
  '',
  'Judge only what the photo shows. Reply with JSON only.',
].join('\n');

/**
 * Gemini `responseSchema` for the labelling call. `roomType` is an enum so the model
 * cannot invent a key the staging matrix has no prompts for.
 * @type {{ type: string, properties: Record<string, unknown>, required: string[] }}
 */
export const ROOM_LABEL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    roomType: { type: 'string', enum: ROOM_LABEL_TYPES },
    roomLabel: { type: 'string' },
    isWide: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['roomType', 'roomLabel', 'isWide', 'confidence'],
};

const MAX_ROOM_LABEL = 60;

/** @typedef {{ roomType: string, roomLabel: string, isWide: boolean, confidence: number }} RoomLabel */
/** @typedef {{ photoId: string | number, roomType?: string | null, roomLabel?: string | null }} RoomLabelInput */
/**
 * A hero candidate: the subset of `import('../types/projects.js').ProjectPhoto` this
 * ranking needs. `stageable` is widened to accept SQLite's raw 0/1 as well as a boolean,
 * and `frameRole` to a plain string, so a row can be passed straight through without a
 * conversion pass first.
 * @typedef {{ id: string | number, width?: number | null, height?: number | null, stageable?: number | boolean | null, frameRole?: string | null }} HeroCandidate
 */

/**
 * Slugify a free-text room label into the token used to build a room key: lowercase,
 * runs of anything non-alphanumeric collapsed to a single hyphen, no leading/trailing
 * hyphen. "Primary Bedroom" and "primary bedroom!" therefore land in the same group.
 * @param {unknown} value - Any label-ish value (non-strings yield '').
 * @returns {string} The slug, or '' when there is nothing sluggable.
 */
export function slugifyRoomLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ROOM_LABEL);
}

/**
 * Group labelled photos into rooms and assign each group a stable room key.
 *
 * Grouping is by room type + slugified room label, so two bedrooms with different labels
 * separate into `bedroom-1` and `bedroom-2`. Numbering follows INPUT ORDER (first group of
 * a type seen is 1), which makes repeated calls on the same input identical; reordering the
 * input can renumber the suffixes but never changes which photos share a key.
 *
 * A photo whose label failed (no room type) gets `roomKey = null` instead of being guessed
 * into a group — see the file header for why a wrong group is the worse failure.
 * @param {RoomLabelInput[] | null | undefined} labels - One entry per photo; a failed label carries a null/empty roomType.
 * @returns {Map<string | number, string | null>} photoId → room key, or null when unassigned.
 */
export function assignRoomKeys(labels) {
  /** @type {Map<string | number, string | null>} */
  const assigned = new Map();
  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, string>} */
  const groups = new Map();

  for (const entry of Array.isArray(labels) ? labels : []) {
    if (!entry || typeof entry !== 'object') continue;
    const photoId = entry.photoId;
    if (photoId === null || photoId === undefined || photoId === '') continue;
    const typeSlug = slugifyRoomLabel(entry.roomType);
    // No usable room type → the label failed. Leave it unassigned for the operator.
    if (!typeSlug) {
      assigned.set(photoId, null);
      continue;
    }
    // An empty roomLabel still groups (all unlabelled photos of a type share one group):
    // the model returns a label whenever it succeeds at all, and merging the handful that
    // came back blank is preferable to minting a room per photo.
    const groupId = `${typeSlug}|${slugifyRoomLabel(entry.roomLabel)}`;
    let key = groups.get(groupId);
    if (key === undefined) {
      const n = (counters.get(typeSlug) || 0) + 1;
      counters.set(typeSlug, n);
      key = `${typeSlug}-${n}`;
      groups.set(groupId, key);
    }
    assigned.set(photoId, key);
  }
  return assigned;
}

// Aspect ratio used for hero ranking; 0 for a photo with unknown or non-positive
// dimensions so it loses to any measurable frame but stays a candidate.
function aspectRatio(photo) {
  const w = Number(photo.width);
  const h = Number(photo.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return w / h;
}

/**
 * Pick the frame whose staging becomes this room's design bible.
 *
 * The widest aspect ratio among eligible frames wins: a wide shot contains the most
 * furniture, so it yields the richest bible. Frames the operator excluded
 * (`frameRole === 'excluded'`) and frames the upload gate rejected (`stageable === 0`)
 * are not eligible. An explicit `frameRole === 'hero'` wins outright — the operator has
 * seen the photos and their choice beats the heuristic (and beats a machine `stageable`
 * verdict; `frameRole` holds one value, so a frame cannot be both hero and excluded).
 * Ties break on the string form of `id`, so a rerun never flips the hero.
 * @param {HeroCandidate[] | null | undefined} photos - Candidate frames for one room.
 * @returns {string | number | null} The winning photo id, or null when no frame is eligible.
 */
export function pickHero(photos) {
  const list = (Array.isArray(photos) ? photos : []).filter(
    (p) => p && typeof p === 'object' && p.id !== null && p.id !== undefined && p.id !== '',
  );

  const better = (candidate, current) => {
    if (!current) return true;
    const dr = aspectRatio(candidate) - aspectRatio(current);
    if (dr !== 0) return dr > 0;
    return String(candidate.id) < String(current.id);
  };

  /** @type {HeroCandidate | null} */
  let override = null;
  for (const p of list) {
    if (p.frameRole === 'hero' && better(p, override)) override = p;
  }
  if (override) return override.id;

  /** @type {HeroCandidate | null} */
  let best = null;
  for (const p of list) {
    if (p.frameRole === 'excluded') continue;
    if (p.stageable === 0 || p.stageable === false) continue;
    if (better(p, best)) best = p;
  }
  return best ? best.id : null;
}

// Tolerant JSON extractor: structured-output mode returns bare JSON, but a model that
// ignores responseMimeType wraps it in ``` fences or prose. Deliberately module-local
// (design-bible.js keeps its own): each module owns the trust boundary for its own reply,
// and lib/staging/segment.js already carries the same few lines.
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

// flash-lite here, unlike the bible extractor: labelling runs once PER PHOTO (a 24-photo
// listing means 24 calls), so unit cost matters and the judgment is a glance. Thinking off
// for the same reason as everywhere else — it would eat the output budget.
const LABEL_MODEL = 'gemini-2.5-flash-lite';
const LABEL_MAX_TOKENS = 160;

/**
 * Build the per-photo room labeller bound to the injected Gemini client.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null }} deps - Injected Gemini client, typed structurally around the used `getGenerativeModel().generateContent` (the SDK's GenerationConfig type omits the `thinkingConfig` field this working call sets). Labelling returns null when it is null.
 * @returns {{ labelPhoto: (imageBuffer: Buffer) => Promise<RoomLabel | null> }} The labeller API.
 */
export function createRoomClustering({ genAI }) {
  /**
   * Label one uploaded photo with the room it shows. Fails open to null (a null client, a
   * sharp/decode failure, a thrown model error, or an unreadable reply), and the caller
   * leaves that photo unassigned rather than guessing a group.
   * @param {Buffer} imageBuffer - The uploaded photo bytes.
   * @returns {Promise<RoomLabel | null>} The label, or null on any failure.
   */
  async function labelPhoto(imageBuffer) {
    if (!genAI) {
      logger.debug('[Rooms] labelling skipped: Gemini client not configured');
      return null;
    }
    try {
      const processed = await downscaleImage(imageBuffer);
      const model = genAI.getGenerativeModel({
        model: LABEL_MODEL,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: LABEL_MAX_TOKENS,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
          responseSchema: ROOM_LABEL_RESPONSE_SCHEMA,
        },
      });
      const result = await model.generateContent([
        { text: ROOM_LABEL_PROMPT },
        { inlineData: { mimeType: 'image/jpeg', data: processed.toString('base64') } },
      ]);
      const response = await result.response;
      const parsed = parseModelJson(response.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn('[Rooms] photo left unlabelled: model reply was not JSON');
        return null;
      }
      const raw = /** @type {Record<string, unknown>} */ (parsed);
      const roomLabel = typeof raw.roomLabel === 'string' ? raw.roomLabel.trim().slice(0, MAX_ROOM_LABEL) : '';
      // An off-vocabulary roomType is honoured as "Other" rather than discarded: the model
      // did see a room, it just named something the staging matrix has no prompts for.
      const roomType = typeof raw.roomType === 'string' && ROOM_LABEL_TYPES.includes(raw.roomType)
        ? raw.roomType
        : OTHER_ROOM_TYPE;
      const confidence = Number(raw.confidence);
      return {
        roomType,
        roomLabel,
        isWide: Boolean(raw.isWide),
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      };
    } catch (error) {
      logger.warn(`[Rooms] photo left unlabelled: ${error && error.message}`);
      return null;
    }
  }

  return { labelPhoto };
}
