// The manifest, narrowed to something the renderer can trust.
//
// WHY THIS EXISTS. Everything on this page comes from one anonymous GET, and the page has
// no session, no retry and no error console anybody will read. So the boundary is treated
// the way a parser boundary should be: one function turns whatever arrived into a value
// with fixed types, and the render layer below it never writes `?.` or `|| ''` again.
//
// The coercions are not decoration. Three of them carry real behaviour:
//
//  1. `showBefore` is TRUE ONLY IF IT IS LITERALLY `true`. It gates whether the original,
//     unstaged photo of somebody's home is fetched at all. A truthy-ish check would turn a
//     stray `"false"` into a disclosure the seller did not agree to, so the default when
//     the field is anything else is "do not show".
//  2. A frame without a `renderId` is DROPPED, not rendered as a broken image. There is
//     nothing to display and no second chance.
//  3. `photoId` survives only when `showBefore` is on. Nulling it here rather than at the
//     img tag means there is exactly one place the before/after decision is made, and a
//     later "just render the slider" change cannot re-open the fetch.

/**
 * @typedef {object} ShareFrame
 * @property {string} renderId - The staged image to show.
 * @property {string|null} photoId - The original, or null when there is no before view.
 * @property {number|null} width - Intrinsic width, for the img's width attribute.
 * @property {number|null} height - Intrinsic height.
 * @property {string} arLabel - Human aspect-ratio label ("3:2"), or ''.
 */

/**
 * @typedef {object} ShareRoom
 * @property {string} key
 * @property {string} label
 * @property {ShareFrame[]} frames
 */

/**
 * @typedef {object} ShareAgent
 * @property {string} name
 * @property {string} email
 * @property {string} phone
 */

/**
 * @typedef {object} ShareListing
 * @property {string} title
 * @property {string} address
 * @property {string} headline
 * @property {string} note
 * @property {boolean} showBefore
 * @property {ShareAgent} agent
 * @property {ShareRoom[]} rooms
 * @property {number} frameCount
 * @property {string} disclosure
 */

/** The sentence shown when the manifest carries no disclosure of its own. */
export const DEFAULT_DISCLOSURE =
  'Photos on this page have been virtually staged. Furnishings and decor are digital '
  + 'renderings and are not included with the property.';

/**
 * Coerce any value to a trimmed string. `null`/`undefined`/objects become ''.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Coerce to a positive integer, or null. Used for the img width/height attributes, which
 * are what stop a 40-frame page from reflowing as each image lands.
 * @param {unknown} value
 * @returns {number|null}
 */
function dimension(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * @param {any} raw
 * @param {boolean} showBefore
 * @returns {ShareFrame|null}
 */
function normalizeFrame(raw, showBefore) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const renderId = text(src.renderId);
  if (!renderId) return null;
  const photoId = text(src.photoId);
  return {
    renderId,
    photoId: showBefore && photoId ? photoId : null,
    width: dimension(src.width),
    height: dimension(src.height),
    arLabel: text(src.arLabel),
  };
}

/**
 * @param {any} raw
 * @param {boolean} showBefore
 * @param {number} index - Position in the manifest, used to name an unlabelled room.
 * @returns {ShareRoom}
 */
function normalizeRoom(raw, showBefore, index) {
  const src = raw && typeof raw === 'object' ? raw : {};
  /** @type {ShareFrame[]} */
  const frames = [];
  for (const candidate of Array.isArray(src.frames) ? src.frames : []) {
    const frame = normalizeFrame(candidate, showBefore);
    if (frame) frames.push(frame);
  }
  return {
    key: text(src.key) || `room-${index + 1}`,
    label: text(src.label) || 'Room',
    frames,
  };
}

/**
 * Narrow a `GET /api/share/<token>` body's `listing` into a {@link ShareListing}.
 *
 * Total: every input, including `null`, produces a listing. An empty `rooms` is a
 * legitimate state (the share exists, nothing is staged yet) and the caller renders the
 * empty state for it — it is not an error.
 *
 * Rooms whose frames all dropped out are removed too: an empty section heading reads as a
 * loading bug to a buyer, and there is nothing under it to wait for.
 *
 * @param {any} raw - The `listing` object from the manifest.
 * @returns {ShareListing}
 */
export function normalizeListing(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const showBefore = src.showBefore === true;
  const agentSrc = src.agent && typeof src.agent === 'object' ? src.agent : {};
  const rooms = (Array.isArray(src.rooms) ? src.rooms : [])
    .map((room, index) => normalizeRoom(room, showBefore, index))
    .filter((room) => room.frames.length > 0);

  return {
    title: text(src.title),
    address: text(src.address),
    headline: text(src.headline),
    note: text(src.note),
    showBefore,
    agent: {
      name: text(agentSrc.name),
      email: text(agentSrc.email),
      phone: text(agentSrc.phone),
    },
    rooms,
    // Counted from what will actually be drawn, not taken from the manifest: the two
    // disagree exactly when a frame was dropped above, and the number on the page should
    // describe the page.
    frameCount: rooms.reduce((total, room) => total + room.frames.length, 0),
    disclosure: text(src.disclosure) || DEFAULT_DISCLOSURE,
  };
}

/**
 * Whether the agent block has anything worth rendering a card for.
 * @param {ShareAgent} agent
 * @returns {boolean}
 */
export function hasAgent(agent) {
  return Boolean(agent && (agent.name || agent.email || agent.phone));
}
