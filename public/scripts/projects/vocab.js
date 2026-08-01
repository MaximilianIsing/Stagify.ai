// The two vocabularies the Listing Studio's dropdowns hand to the server, and the ONLY
// place either one is written down on the frontend.
//
// WHY THIS FILE EXISTS AT ALL. `generatePrompt` looks the pair up as
// `promptMatrix[roomType]?.[furnitureStyle]` — case-sensitively, exactly — and falls back
// to a bare "Stage this <roomType> professionally." when either miss. Nothing anywhere
// reports the miss. So a dropdown whose `value` is not literally a matrix key does not
// fail; it silently degrades every render made through it, which is strictly worse than
// leaving the room type wrong, and the operator has no way to tell.
//
// The Listing Studio shipped with ten room types ('living room', 'bedroom', …) of which
// ZERO matched the matrix's ('Living room', 'Bedroom', …), and nine styles of which four
// ('mid-century modern', 'traditional', 'industrial', 'minimalist') had no entry and so
// collapsed to 'standard'.
//
// The rule this file enforces: THE `value` IS THE MATRIX KEY, verbatim. Display text is
// free to be friendlier (see ROOM_TYPE_LABELS), because nothing is looked up by it.
//
// The room-type set is also the backend's own labelling vocabulary — `ROOM_LABEL_TYPES`
// in lib/staging/room-clustering.js is `[...Object.keys(promptMatrix), 'Other']`, and the
// auto-clustering writes those exact strings onto `photo.roomType`. So the dropdown and
// the auto-label now speak the same language, and correcting a photo no longer downgrades
// it. Drift is test-enforced (test/i18n/room-types-i18n.test.js and
// test/frontend/projects/studio.test.js both compare these lists against the matrix).

/** The room type the backend uses for anything outside the matrix. Has no matrix entry
 *  by design — the server's own fallback prompt covers it. */
export const OTHER_ROOM_TYPE = 'Other';

/**
 * Every room type, in `promptMatrix` key order, with 'Other' last.
 *
 * KEEP THIS IN MATRIX ORDER AND SPELLING. It is compared key-for-key against
 * `Object.keys(promptMatrix)` by the drift guard.
 * @type {string[]}
 */
export const ROOM_TYPES = [
  'Bedroom',
  'Living room',
  'Dining room',
  'Kitchen',
  'Office',
  'Bathroom',
  'Outdoors',
  'Dorm',
  OTHER_ROOM_TYPE,
];

/**
 * Friendlier display text for a room type, where the matrix key is terse or ambiguous.
 * Anything absent here displays as its key. Display-only — never sent anywhere.
 * @type {Record<string, string>}
 */
export const ROOM_TYPE_LABELS = {
  Office: 'Office / study',
  Outdoors: 'Outdoors / exterior',
  Dorm: 'Dorm room',
  Other: 'Other (hallway, garage, stairs…)',
};

/**
 * Every furniture style, as `{ value: <matrix key>, label: <display text> }`.
 *
 * 'standard' and 'custom' are offered now; they were previously unreachable from the
 * Listing Studio even though they are the matrix's own default and its free-text mode.
 * 'custom' is the entry whose prompt text is literally "…the furniture and decor the user
 * asks for", so it only makes sense alongside the Additional instructions box — which is
 * what its label says.
 * @type {Array<{ value: string, label: string }>}
 */
export const FURNITURE_STYLES = [
  { value: 'standard', label: 'Standard (broad appeal)' },
  { value: 'modern', label: 'Modern' },
  { value: 'midcentury', label: 'Mid-century modern' },
  { value: 'scandinavian', label: 'Scandinavian' },
  { value: 'luxury', label: 'Luxury' },
  { value: 'coastal', label: 'Coastal' },
  { value: 'farmhouse', label: 'Farmhouse' },
  { value: 'custom', label: 'Custom — follow my instructions below' },
];

/** The server clamps `additionalPrompt` to this many characters (routes/projects.js). */
export const MAX_ADDITIONAL_PROMPT = 500;

/**
 * Legacy and near-miss room types mapped onto the matrix key that actually stages well.
 *
 * Two of these are the judgement calls the vocabulary change forced, and they are written
 * down rather than left to a `||`:
 *
 *   - `nursery`  → `Bedroom`.      A nursery IS a bedroom for staging purposes; the
 *                                  bedroom prompt (bed, nightstands, soft textiles) is
 *                                  the closest thing the matrix has.
 *   - `basement` → `Living room`.  A staged basement is a rec/family room, and the
 *                                  living-room prompt is what an agent wants there.
 *
 * The rest are case/spelling variants of a real key, including the ten values the studio
 * used to send. Keys are lowercase; lookup lowercases its input.
 * @type {Record<string, string>}
 */
export const ROOM_TYPE_ALIASES = {
  'living room': 'Living room',
  livingroom: 'Living room',
  lounge: 'Living room',
  'family room': 'Living room',
  basement: 'Living room',
  bedroom: 'Bedroom',
  nursery: 'Bedroom',
  'guest room': 'Bedroom',
  kitchen: 'Kitchen',
  'dining room': 'Dining room',
  diningroom: 'Dining room',
  bathroom: 'Bathroom',
  bath: 'Bathroom',
  office: 'Office',
  'home office': 'Office',
  study: 'Office',
  outdoors: 'Outdoors',
  outdoor: 'Outdoors',
  patio: 'Outdoors',
  balcony: 'Outdoors',
  dorm: 'Dorm',
  'dorm room': 'Dorm',
  other: OTHER_ROOM_TYPE,
};

/**
 * The matrix key for a room type that arrived from anywhere but this file's own dropdown
 * — an older photo row, a hand-edited value, a future backend label.
 *
 * Returns '' for something with no sensible mapping, which the caller shows as-is rather
 * than silently rewriting. Guessing wrong here would be the same class of bug this file
 * exists to fix, so an unknown value stays unknown.
 * @param {string|null|undefined} value
 * @returns {string} A `promptMatrix` key (or 'Other'), or '' when there is no match.
 */
export function normalizeRoomType(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (ROOM_TYPES.includes(raw)) return raw;
  return ROOM_TYPE_ALIASES[raw.toLowerCase()] || '';
}

/**
 * Display text for a room type: the friendly label when there is one, else the value.
 * @param {string} value
 * @returns {string}
 */
export function roomTypeLabel(value) {
  return ROOM_TYPE_LABELS[value] || value;
}
