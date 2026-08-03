// What a staged render is called — the ONE derivation, used by both pages that show one.
//
// The owner's gallery (scripts/gallery/view.js) and the public share page
// (scripts/share/view.js) have to agree: the share link's heading is the same label the
// owner sees over the same photo in their own gallery, and two copies of a rule like
// "<Style> <Room type>" drift the first time either page is touched.
//
// It lives at the top of scripts/ rather than inside either folder because the share page
// deliberately shares nothing else with the app: no i18n, no locale data, no styles.css.
// That is why the fallback for a render with no name and no room type is a PARAMETER —
// the gallery passes its translated string, the share page passes plain English, and
// neither has to reach into the other's world to do it.

/**
 * A furniture style as a person would write it.
 *
 * The stored value is a slug (`luxury`, `midcentury`), because that is what the studio's
 * <select> submits and what promptMatrix.js keys off. Printing it raw is how the detail
 * panel came to say "Style: modern" under a heading that says "Modern Bedroom".
 *
 * Capitalised rather than looked up in a language pack, and that is the deliberate half:
 * this string is joined to `roomType`, which is server data and never translated. "Lujo
 * Bedroom" is a worse answer than "Luxury Bedroom" — half a name in each language reads
 * like a bug, where one consistent language reads like a default the owner can replace.
 *
 * @param {string} [style] @returns {string}
 */
export function styleLabel(style) {
  const slug = String(style ?? '').trim();
  if (!slug) return '';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * What to call this render when its owner has not named it.
 *
 * `<Style> <Room type>` — "Luxury Bedroom" — because those are the two things the owner
 * chose, and together they are the shortest phrase that distinguishes two renders of the
 * same room. Degrades a term at a time: no style leaves the room type alone, neither
 * leaves the caller's fallback.
 *
 * Derived on read rather than stored at insert, so it is not frozen: restyling the
 * default later re-labels every unnamed render instead of only the new ones.
 *
 * @param {any} entry - Anything carrying `furnitureStyle` and `roomType`.
 * @param {string} [fallback] - Shown when there is neither.
 * @returns {string}
 */
export function defaultName(entry, fallback = 'Staged room') {
  const style = styleLabel(entry?.furnitureStyle);
  const room = String(entry?.roomType ?? '').trim();
  if (style && room) return `${style} ${room}`;
  return room || fallback;
}

/**
 * What this render is called: the owner's own name, or the derived default.
 *
 * @param {any} entry - Anything carrying `name`, `furnitureStyle` and `roomType`.
 * @param {string} [fallback]
 * @returns {string}
 */
export function entryName(entry, fallback = 'Staged room') {
  const own = String(entry?.name ?? '').trim();
  return own || defaultName(entry, fallback);
}
