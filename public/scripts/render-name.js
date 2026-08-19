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
 * What each studio other than the interior one is called, and where its qualifier comes
 * from.
 *
 * `namesRender` separates two things this table used to conflate: what a tool is
 * CALLED, and whether that tool NAMES the render. They came apart the day the public
 * API arrived — see the `api` entry.
 *
 * The interior flow is ABSENT on purpose: it is the one surface where the owner picked both
 * halves of the name themselves, so it keeps `<Style> <Room type>` and needs no rule.
 *
 * These four ids duplicate `RENDER_SOURCES` in lib/data/render-extra.js, and the
 * duplication is unavoidable rather than sloppy — a browser module cannot import from lib/,
 * and nothing in lib/ imports from public/. test/data/render-extra.test.js asserts the two
 * sets match in both directions, which is what makes the copy safe to keep.
 *
 * English, like `styleLabel` above and for the same reason: this joins onto server data
 * that is never translated, and half a name in each language reads like a bug.
 */
const SOURCE_RULES = {
  exterior: { label: 'Exterior', namesRender: true, qualifier: (entry) => String(entry?.qualifier ?? '').trim() },
  masking: { label: 'Masking Studio', namesRender: true, qualifier: (entry) => String(entry?.qualifier ?? '').trim() },
  // The designer's room type is a guess the routing model made, and it defaults to "Other"
  // (lib/chat/chat-staging.js). "AI Designer — Other" is worse than "AI Designer", so an
  // unhelpful guess degrades to no qualifier at all rather than being printed.
  designer: {
    label: 'AI Designer',
    namesRender: true,
    qualifier: (entry) => {
      const room = String(entry?.roomType ?? '').trim();
      return room.toLowerCase() === 'other' ? '' : room;
    },
  },
  // The public API. LABEL ONLY — `namesRender` is false, and that is the whole point
  // of the flag.
  //
  // The label earns its place: an API render lands in the owner's gallery beside renders
  // a colleague made by hand, and "Made with: API" is the only thing that tells the two
  // apart. But the NAME must not come from here, for two reasons. The API runs the
  // interior pipeline with the caller's own room and style, so `<Style> <Room type>`
  // already describes it better than "API" would. And `defaultName` also feeds the
  // heading of the PUBLIC share page (public/scripts/share/view.js), where an anonymous
  // client opening a link to their staged living room would be shown the word "API".
  //
  // No `qualifier`: room and style are already columns, and render-extra.js only stores
  // what no column carries. Nothing calls it either — `defaultName` skips the whole
  // branch when `namesRender` is falsy.
  api: { label: 'API', namesRender: false },
};

/**
 * The sources that have a rule above, exported so the drift guard can see them.
 *
 * `test/data/render-extra.test.js` asserts this plus `'interior'` equals `RENDER_SOURCES`
 * exactly, in both directions — which is what makes the duplicated vocabulary safe, and
 * what fails the build the day a fifth studio is added to lib/ and forgotten here.
 */
export const NAMED_SOURCES = Object.freeze(Object.keys(SOURCE_RULES));

/**
 * What to print in the detail panel's "Made with" row, or `''` to omit the row.
 *
 * Interior renders get `''` on purpose: the panel already lists their Room and Style, which
 * says the same thing at more use. The row earns its place on the other three, where those
 * two rows are empty and nothing else on the panel says where the image came from.
 *
 * @param {string} [source] @returns {string}
 */
export function sourceLabel(source) {
  return SOURCE_RULES[String(source ?? '')]?.label ?? '';
}

/**
 * Append the source photo's filename stem, when the entry carries one.
 *
 * This is what tells twenty renders of twenty different houses apart — the settings alone
 * cannot, because a user who never opens the dropdowns gets "Standard Bedroom" on all of
 * them. `·` rather than the em dash above, and the difference is meant: `—` joins a tool to
 * the setting it was run with, `·` appends where the photo came from.
 *
 * The share page's manifest never carries `sourceName` (routes/share-public.js says why),
 * so this is simply a no-op there — no branch, no second rule.
 *
 * @param {string} name @param {any} entry @returns {string}
 */
function withSourceName(name, entry) {
  const stem = String(entry?.sourceName ?? '').trim();
  return stem ? `${name} · ${stem}` : name;
}

/**
 * What to call this render when its owner has not named it.
 *
 * Two shapes, chosen by which tool made it:
 *
 *   interior  `<Style> <Room type>`      "Luxury Bedroom"
 *   anything  `<Studio> — <qualifier>`   "Exterior — Golden hour"
 *
 * ...and both then get the source photo's stem appended. The interior shape is first
 * because those are the two things the owner chose, and together they are the shortest
 * phrase that distinguishes two renders of the same room. The others have no style and no
 * room type worth printing — an exterior has no furniture, a masking session has neither —
 * so naming them after the tool and its one distinguishing setting is the closest
 * equivalent.
 *
 * Degrades a term at a time, in both shapes: no qualifier leaves the studio's name alone,
 * no style leaves the room type alone, neither leaves the caller's fallback. An entry with
 * no `source` at all — which is EVERY row written before this shipped — takes the interior
 * path unchanged, so nothing in an existing gallery gets renamed.
 *
 * Derived on read rather than stored at insert, so it is not frozen: restyling the default
 * later re-labels every unnamed render instead of only the new ones. The one exception is
 * `qualifier`, which the server computes once and stores — see lib/data/render-extra.js for
 * why that is a smaller compromise than a fourth copy of the exterior preset labels living
 * in a file the share page has to import.
 *
 * @param {any} entry - Anything carrying `source`, `qualifier`, `sourceName`,
 *   `furnitureStyle` and `roomType`.
 * @param {string} [fallback] - Shown when there is nothing else.
 * @returns {string}
 */
export function defaultName(entry, fallback = 'Staged room') {
  const rule = SOURCE_RULES[String(entry?.source ?? '')];
  // `namesRender`, not mere existence: a source may have a label for the "Made with"
  // row and still want the `<Style> <Room type>` ladder below. See SOURCE_RULES.api.
  if (rule?.namesRender) {
    const qualifier = rule.qualifier(entry);
    return withSourceName(qualifier ? `${rule.label} — ${qualifier}` : rule.label, entry);
  }
  const style = styleLabel(entry?.furnitureStyle);
  const room = String(entry?.roomType ?? '').trim();
  if (style && room) return withSourceName(`${style} ${room}`, entry);
  return room ? withSourceName(room, entry) : fallback;
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
