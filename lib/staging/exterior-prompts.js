// Exterior Studio prompts — the curb-appeal tool's vocabulary, its QA rubric, and its
// own upload gatekeeper.
//
// WHY THIS IS A SEPARATE FILE FROM prompts.js
// Two reasons, and the second is the load-bearing one:
//   1. prompts.js sits at ~626 of its 650-line eslint ceiling. The ratchet is deliberate
//      (eslint.config.js says split, never raise), which is also how room-constraints.js
//      came to exist.
//   2. Nothing here shares a code path with generatePrompt(). Interior staging ADDS
//      furniture to a room; this REMOVES things from a photograph and relights it. The
//      two prompts agree on almost nothing except "do not move the camera", so folding
//      exteriors into the room-type matrix would mean a room type whose every style
//      entry had to say "actually, ignore the furniture".
//
// WHAT THIS TOOL DELIBERATELY WILL NOT DO
// Sky replacement and time-of-day relighting are photo-level edits an MLS treats as
// routine enhancement. Regrading a lawn, erasing power lines or resurfacing a driveway
// are not: they change the property a buyer walks up to, and the listing agent — not us —
// is the one answering for it under NAR Article 12. So those are absent from the controls
// AND forbidden in EXTERIOR_PRESERVATION_RULES, because a free-text box that can talk the
// model into them is the same product with an extra step.

import { IMAGE_FRAMING_PRESERVATION_RULES } from './prompts.js';

/**
 * Time-of-day relighting clauses, keyed by the wire value the browser submits.
 *
 * `keep` maps to an EMPTY string, and every preset table here follows that rule: an
 * unselected option must contribute silence, not a sentence. "Leave the lighting
 * unchanged" reads to an image model as an instruction to do something about the
 * lighting, which is how a no-op preset ends up subtly regrading the exposure.
 * @type {Record<string, string>}
 */
export const TIME_OF_DAY_PRESETS = {
  keep: '',
  morning:
    'Relight the scene as clear MID-MORNING light: sun fairly low and warm but not orange, '
    + 'long soft shadows falling consistently in one direction, bright even illumination on the '
    + 'facade, and a fresh cool cast in the shaded areas.',
  midday:
    'Relight the scene as bright MIDDAY sun: high sun, crisp short shadows directly beneath '
    + 'eaves and overhangs, strong even light across the facade, vivid but natural colour, and '
    + 'no blown-out highlights on light-coloured siding or roofing.',
  goldenHour:
    'Relight the scene as GOLDEN HOUR, roughly an hour before sunset: low warm directional '
    + 'sun raking across the facade, long soft shadows, warm highlights on the roofline and '
    + 'trim, gently glowing windows, and rich saturated colour in the landscaping. Keep it '
    + 'photographic — warm, not orange-tinted or over-graded.',
  dusk:
    'Relight the scene as DUSK / twilight, shortly after sunset: deep blue ambient sky, the '
    + 'facade lit by warm interior light glowing through the windows and by the property\'s own '
    + 'exterior fixtures, soft ambient shadows, and a balanced exposure that keeps the '
    + 'architecture clearly readable rather than silhouetted. Only light windows and fixtures '
    + 'that already exist in the photo — do not add new lamps, uplights or fittings.',
};

/**
 * Sky and weather clauses, keyed by the wire value the browser submits.
 * @type {Record<string, string>}
 */
export const SKY_PRESETS = {
  keep: '',
  clearBlue:
    'Replace the sky with a clean CLEAR BLUE sky: an even gradient, deeper at the top and '
    + 'lighter toward the horizon, with no clouds and no haze.',
  lightClouds:
    'Replace the sky with a bright blue sky carrying soft scattered CUMULUS CLOUDS — white, '
    + 'well-formed and unobtrusive, arranged naturally rather than tiled or repeating.',
  dramatic:
    'Replace the sky with a DRAMATIC but believable sky: layered cloud with real depth and '
    + 'visible structure, breaks of brighter sky behind it, and directional light consistent '
    + 'with the shadows already on the property. Keep it a real photograph, not a composite.',
};

/**
 * Optional removal clauses, keyed by the request flag that enables each one.
 *
 * THE PRINCIPLE THAT DECIDES WHAT MAY JOIN THIS TABLE: every entry removes something that
 * is in the PHOTOGRAPH but is not part of the PROPERTY. A neighbour's van, a wheelie bin,
 * a pedestrian, last night's snow and this morning's rain are all conditions of the day
 * the shutter happened to fire; none of them is what the buyer is being sold, and none of
 * them will be there when that buyer walks up. Anything bolted to the ground — planting,
 * power lines, driveway surface, paint — fails that test and is forbidden outright in
 * EXTERIOR_PRESERVATION_RULES rather than merely absent from here. See the file header.
 *
 * THIS TABLE IS THE WIRING POINT. buildExteriorPrompt iterates its keys, the browser posts
 * a checkbox whose `name` is the key, and test/i18n/exterior-options-i18n.test.js fails the
 * build unless every key has both a checkbox in the markup and a translated label in all
 * eleven packs. So a sixth removal is an entry here plus markup plus strings — never a
 * forgotten `if`.
 *
 * @type {Record<string, string>}
 */
export const CLEANUP_CLAUSES = {
  removeVehicles:
    'Remove every parked car, truck, van, motorcycle, trailer, boat and bicycle from the '
    + 'frame, including any parked at the kerb or on a neighbouring driveway. Reconstruct '
    + 'whatever they were covering — driveway, kerb, road surface, grass or planting — so it '
    + 'continues naturally and matches the surrounding material, texture and wear.',
  removeClutter:
    'Remove temporary clutter and movable objects: wheelie bins and recycling boxes, garden '
    + 'hoses and reels, sprinklers, children\'s toys, bicycles, scooters, rubbish bags, '
    + 'cardboard, ladders, tools, buckets, loose furniture, for-sale and contractor signage, '
    + 'stray cones, and anything left out on the drive, path, porch or lawn. Reconstruct the '
    + 'surface underneath each one so it matches its surroundings.',
  removePeople:
    'Remove every person from the frame: anyone standing, walking, sitting or working on the '
    + 'property, on the pavement or in the road, anyone visible in a doorway or through a '
    + 'window, any dog or pet with them, and any reflection of the photographer in glazing, '
    + 'glass doors or parked vehicles. Reconstruct whatever each one was standing in front '
    + 'of — wall, door, planting, path or street — so it continues naturally behind them. Do '
    + 'not replace them with anyone else, and leave no silhouette, blur, cast shadow or '
    + 'part-limb behind.',
  removeSnow:
    'Remove lying snow, slush and ice from the scene: from the driveway, paths, steps, lawn, '
    + 'beds, hedges, walls, roof and gutters, together with any snow banked at the kerb or '
    + 'shovelled into piles. Reconstruct each surface as it plausibly continues from the '
    + 'parts of it already visible in the photograph, matching their material, colour, '
    + 'texture, wear and condition. KEEP THE SEASON — this is the same day with the snow '
    + 'cleared, not a summer photograph: bare trees and shrubs stay bare, dormant or brown '
    + 'grass stays dormant and brown, and nothing is greened up, replanted, or brought into '
    + 'leaf or flower.',
  removeWetWeather:
    'Dry the scene off: remove falling rain and drizzle, visible rain streaks, raindrops and '
    + 'water spots on the lens, standing puddles, and the dark wet patches and reflective '
    + 'sheen on the driveway, paths, road, steps, patio and walls, so each of those surfaces '
    + 'reads as dry in its own material and colour. Clear the flat, dull haze that wet '
    + 'weather puts over the scene. Change ONLY the water: the sky, the time of day, the '
    + 'season and the direction of the light all stay as they are unless something above '
    + 'asked for them to change.',
};

/**
 * The generic realism block — the exterior counterpart of generatePrompt()'s
 * "REALISTIC, DEFECT-FREE STAGING" rules, aimed at the failure modes sky replacement and
 * relighting actually produce rather than the ones furniture placement does.
 */
const EXTERIOR_REALISM_RULES = `CRITICAL — PHOTOREALISTIC RESULT (avoid the common failures of this kind of edit):
- Light the whole scene from ONE consistent direction. Every shadow on the building, driveway, planting and street must agree with each other and with the sun implied by the sky.
- Match the new sky to the scene: its brightness, colour temperature and contrast must be consistent with how the facade is lit. A brilliant sky over a flatly-lit house reads as fake instantly.
- Keep the horizon and roofline edges clean and hard. No halos, glow, fringing or soft smears where the sky meets the roof, chimneys, aerials, gutters, foliage or wires.
- Where sky shows THROUGH something — tree canopy, railings, pergolas, balustrades, window reflections — it must show through there too, at the same brightness.
- Keep reflections honest: windows, glass doors, wet surfaces and paintwork should reflect the new sky and lighting rather than the old one.
- Preserve the photograph's own character: existing grain, focus, depth of field and lens perspective. Do not smooth, over-sharpen, over-saturate or apply a stylised colour grade.
- Render every object once, whole and undistorted. No duplicated or warped windows, doors, columns, railings, or roof detail, and no melted or smeared brick, siding, render, stone or roofing texture.`;

/**
 * The hard rules. Emitted LAST and worded to outrank everything above it — including the
 * user's own free text — for exactly the reason ROOM_TYPE_CONSTRAINTS is emitted after
 * the removal clause: whichever block speaks last wins the argument.
 *
 * The split into two tiers is the whole design. Tier 1 is the property itself, and no
 * request may reach it. Tier 2 is surface finish, which mirrors generatePrompt()'s own
 * architecture block ("unless the user explicitly requested it") so the free-text box is
 * still worth having.
 */
export const EXTERIOR_PRESERVATION_RULES = `CRITICAL — PRESERVE THE PROPERTY EXACTLY (this section overrides EVERY instruction above it, including any request in the user's own words):
- This is a photograph of a REAL property that a buyer will stand in front of. The edit may change the photograph. It must NEVER change the property.
- Do not add, remove, move, resize or reshape ANY permanent element: walls, roofline, roof pitch, chimneys, dormers, gables, windows, doors, garage doors, porches, steps, columns, railings, balconies, extensions, outbuildings, fences, walls, gates, driveways, paths or kerbs. Their number, position, size, shape and proportions must survive exactly.
- Do not change the building's footprint, height, storey count, or the camera's position, angle, lens or framing.
- Do not re-landscape the property. Lawns, beds, shrubs, hedges and trees keep their existing extent, shape, height and health — do not green up, mow, trim, replant, add or remove them, and do not repair bare patches, weeds or worn ground.
- Do not remove or alter permanent infrastructure: power lines, telephone lines, poles, utility boxes, meters, satellite dishes, aerials, vents, downpipes, gutters, air-conditioning units, street lights, signs or road markings.
- Do not resurface, clean, repair or re-point driveways, paths, patios, roofing, brickwork, render or cladding. Existing stains, moss, cracks, wear and weathering stay exactly as photographed.
- Where you were asked ABOVE to remove something — a vehicle, clutter, a person, snow, standing water — you may rebuild only what that thing was hiding, continuing the surrounding material, colour, texture, wear and condition exactly as they appear elsewhere in the photograph. Uncovering a surface is never permission to improve it: what comes back must be the same driveway, path, step or lawn on the same day, not a cleaner, newer, greener or better-kept one. If you cannot tell what was underneath, match the nearest visible stretch of the same surface.
- Do not alter house numbers, street signs, name plates or any other text, and do not alter neighbouring properties, their vehicles on their own land, or anything beyond the boundary except as explicitly permitted above.
- Do not add people, pets, vehicles, furniture, planting, decoration or staging of any kind.

DEFAULT-PRESERVE (change these ONLY if the user explicitly asked for it above):
- Paint and stain colours, siding, cladding and roofing materials and finishes, and door and window frame colours.`;

/**
 * One enhancement request, as the browser posts it and every function below reads it.
 *
 * @typedef {object} ExteriorOptions
 * @property {string} [timeOfDay] - Wire value from {@link TIME_OF_DAY_PRESETS}; `'keep'` or absent means the row was off.
 * @property {string} [sky] - Wire value from {@link SKY_PRESETS}; `'keep'` or absent means the row was off.
 * @property {boolean} [removeVehicles] - Clear parked cars, vans, trailers and bikes.
 * @property {boolean} [removeClutter] - Clear bins, hoses, toys, tools and signage.
 * @property {boolean} [removePeople] - Clear people, their pets, and the photographer's reflection.
 * @property {boolean} [removeSnow] - Clear lying snow and ice, keeping the season otherwise intact.
 * @property {boolean} [removeWetWeather] - Dry off rain, puddles and wet surfaces.
 * @property {string} [additionalPrompt] - The user's own words from the free-text box.
 */

/**
 * Resolve a preset key against its table, falling back to the no-op entry.
 *
 * Unknown keys resolve to silence rather than throwing: this runs on a paid render path
 * off a request body, and an unrecognised preset should cost the user a plainer photo,
 * not a 500.
 * @param {Record<string, string>} table - One of the preset tables above.
 * @param {unknown} key - The submitted wire value.
 * @returns {string} The clause, or '' when unset, unknown, or the explicit no-op.
 */
function clauseFrom(table, key) {
  return (typeof key === 'string' && table[key]) || '';
}

/**
 * Which removal flags this request turned on, in CLEANUP_CLAUSES declaration order.
 *
 * Read off the table rather than named one-by-one so the prompt, the QA summary and the
 * gallery name cannot disagree about which flags exist — the bug shape that made
 * TIME_OF_DAY_LABELS a drift-guarded table instead of three inline `if`s. Declaration
 * order is the order the panel shows the rows in, and the order both descriptions read
 * them out, so a request reads back the way it was filled in.
 * @param {ExteriorOptions} options - The submitted request.
 * @returns {string[]} The enabled keys of {@link CLEANUP_CLAUSES}.
 */
function enabledRemovals(options) {
  const flags = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
  return Object.keys(CLEANUP_CLAUSES).filter((key) => flags[key]);
}

/**
 * Build the full Exterior Studio prompt.
 *
 * Assembly order is load-bearing and mirrors generatePrompt()'s discipline:
 *   1. what to do (presets, then cleanup),
 *   2. the user's own words,
 *   3. realism + framing,
 *   4. the hard rules, LAST, so they outrank 1–3.
 * @param {ExteriorOptions} [options] - The submitted enhancement request.
 * @returns {string} The assembled prompt.
 */
export function buildExteriorPrompt(options = {}) {
  const { additionalPrompt = '' } = options;

  /** @type {string[]} */
  const edits = [];
  const timeClause = clauseFrom(TIME_OF_DAY_PRESETS, options.timeOfDay);
  const skyClause = clauseFrom(SKY_PRESETS, options.sky);
  if (timeClause) edits.push(timeClause);
  if (skyClause) edits.push(skyClause);
  for (const key of enabledRemovals(options)) edits.push(CLEANUP_CLAUSES[key]);

  const extra = typeof additionalPrompt === 'string' ? additionalPrompt.trim() : '';

  // ONLY what was asked for. The controls are opt-in — a request that names nothing but
  // "remove the bin bags" must not also relight the scene, because the user did not ask
  // for that and the photo they get back has to be one they can publish.
  //
  // The generic correction pass is therefore the LAST resort, not a floor added to every
  // request: it fires only when neither a control nor the free-text box said anything.
  // Something has to be asked for, or the model hands the input straight back and the
  // render is billed for a no-op.
  let requested;
  if (edits.length) {
    requested = edits.map((clause) => `- ${clause}`).join('\n');
  } else if (extra) {
    requested = `- ${extra}`;
  } else {
    requested = '- Make a light, natural correction pass only: even out the exposure, straighten the '
      + 'verticals if they are visibly leaning, and clear any haze. Change nothing else.';
  }

  // Appended only when it is not already the whole request, so the free text is never
  // stated twice.
  const userSection = extra && edits.length
    ? `\n\nALSO APPLY, and prioritise this over the list above where they conflict: ${extra}`
    : '';

  return `You are an expert real-estate photo editor preparing the exterior photograph of a property for a listing. Apply the following enhancements to this photograph, and make NO other changes:

${requested}${userSection}

${EXTERIOR_REALISM_RULES}

CRITICAL — IMAGE FRAMING:
${IMAGE_FRAMING_PRESERVATION_RULES}

${EXTERIOR_PRESERVATION_RULES}

Deliver a photorealistic result that looks like the same photograph taken on a better day: sharp, natural, and indistinguishable from an unedited professional listing photo.`;
}

/**
 * The two human-readable forms of each option, keyed by the same wire value as the preset
 * tables above.
 *
 * TWO COLUMNS RATHER THAN TWO TABLES, and that is the whole point. `phrase` is a sentence
 * fragment for `describeExteriorRequest`, which reads as prose ("…: golden-hour light, a
 * clear blue sky"). `title` is a NAME, for the gallery entry — "Exterior — a clear blue sky"
 * would be wrong, and "Exterior — Golden hour" is what belongs on a card. They are different
 * registers of the same fact, so they belong in one row where a missing one is visible.
 *
 * `keep` is absent from both, exactly as it contributes no prompt clause above: an
 * unselected option contributes silence.
 *
 * The count of vocabularies in this file therefore stays at two, not four. There is a third
 * copy in the language packs (`exteriorStudio.time.*`, `exteriorStudio.skyOptions.*`) which
 * is what the CONTROLS show, and it cannot be shared — those are translated and these are
 * not, because a gallery name that is half English reads like a bug. What keeps all of them
 * honest is test/staging/exterior-prompts.test.js, which fails when a preset gains a clause
 * without gaining a name.
 *
 * @type {Record<string, { phrase: string, title: string }>}
 */
export const TIME_OF_DAY_LABELS = {
  morning: { phrase: 'mid-morning light', title: 'Mid-morning' },
  midday: { phrase: 'bright midday sun', title: 'Midday' },
  goldenHour: { phrase: 'golden-hour light', title: 'Golden hour' },
  dusk: { phrase: 'dusk / twilight', title: 'Dusk' },
};

/**
 * Sky options, same shape as {@link TIME_OF_DAY_LABELS}.
 *
 * The titles are lower-case because they are only ever the SECOND term in a joined
 * qualifier ("Dusk, clear sky"), and `describeExteriorQualifier` capitalises the first
 * character of whatever it ends up with — so a sky-only request still reads "Clear sky".
 *
 * @type {Record<string, { phrase: string, title: string }>}
 */
export const SKY_LABELS = {
  clearBlue: { phrase: 'a clear blue sky', title: 'clear sky' },
  lightClouds: { phrase: 'a blue sky with light clouds', title: 'light clouds' },
  dramatic: { phrase: 'a dramatic sky', title: 'dramatic sky' },
};

/**
 * Removal flags, same shape as {@link TIME_OF_DAY_LABELS}.
 *
 * These were two inline string literals inside describeExteriorRequest, and a third in
 * describeExteriorQualifier, for exactly as long as there were two flags. At five that
 * stops being cheaper than a table: a sixth removal added to CLEANUP_CLAUSES would have
 * reached the prompt — the part that costs money and is therefore noticed — while the QA
 * summary, the CSV row and the gallery card all silently pretended it had not been asked
 * for. The pairing is pinned by the same drift guard that already covers the presets.
 *
 * Titles are lower-case for the reason {@link SKY_LABELS}'s are: describeExteriorQualifier
 * capitalises the first character of whatever it assembles, so storing them capitalised
 * would only matter if one were ever the SECOND term — which cannot happen, because the
 * qualifier reaches for a removal only when no preset named one.
 *
 * @type {Record<string, { phrase: string, title: string }>}
 */
export const CLEANUP_LABELS = {
  removeVehicles: { phrase: 'parked vehicles removed', title: 'vehicles removed' },
  removeClutter: { phrase: 'temporary clutter removed', title: 'clutter removed' },
  removePeople: { phrase: 'people removed', title: 'people removed' },
  removeSnow: { phrase: 'snow cleared', title: 'snow cleared' },
  // The one row whose phrase and title genuinely diverge, and the reason the table has two
  // columns. "…: rain and wet ground dried off" is right in a sentence; "Exterior — Dried
  // off" on a card leaves the reader asking what was.
  removeWetWeather: { phrase: 'rain and wet ground dried off', title: 'rain removed' },
};

/**
 * What to call this render in the gallery — the one setting that distinguishes it.
 *
 * Every exterior render used to be called "Exterior", because the row carries
 * `roomType: 'Exterior'` and no furniture style at all. This is the term that makes twenty
 * of them tellable apart.
 *
 * Time and sky first, because those are the two the user came here to change. Cleanup flags
 * are the FALLBACK rather than another term: "Exterior — Golden hour, clear sky, vehicles
 * removed" is longer than the card can show, and the relight is the more distinguishing
 * fact. A request that only removes clutter still gets something better than a bare
 * "Exterior".
 *
 * Deliberately does NOT include `additionalPrompt`. That is the owner's free text, it is
 * already published in the detail panel and searchable, and an arbitrary sentence truncated
 * to 48 characters makes a worse name than the preset does.
 *
 * @param {ExteriorOptions} [options] - The submitted enhancement request.
 * @returns {string} `''` when nothing was opted into, which leaves the name as "Exterior" —
 *   exactly what every exterior render was called before, so no regression.
 */
export function describeExteriorQualifier(options = {}) {
  /** @type {string[]} */
  const parts = [];
  const time = typeof options.timeOfDay === 'string' ? TIME_OF_DAY_LABELS[options.timeOfDay]?.title : '';
  const sky = typeof options.sky === 'string' ? SKY_LABELS[options.sky]?.title : '';
  if (time) parts.push(time);
  if (sky) parts.push(sky);
  if (!parts.length) {
    // The FIRST enabled removal only. A card has one line, and "Exterior — vehicles
    // removed, clutter removed, people removed, snow cleared" is a name that distinguishes
    // nothing because it no longer fits.
    const [first] = enabledRemovals(options);
    if (first) parts.push(CLEANUP_LABELS[first].title);
  }
  const joined = parts.join(', ');
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : '';
}

/**
 * A one-line plain-English summary of the request.
 *
 * Feeds the QA reviewer's "the user's request was …" clause and the CSV prompt log, so the
 * reviewer judges against what was asked rather than against its own taste — the same job
 * `additionalPrompt` does on the interior path.
 * @param {ExteriorOptions} [options] - The submitted enhancement request.
 * @returns {string} A short human-readable summary.
 */
export function describeExteriorRequest(options = {}) {
  /** @type {string[]} */
  const parts = [];
  const time = typeof options.timeOfDay === 'string' ? TIME_OF_DAY_LABELS[options.timeOfDay]?.phrase : '';
  const sky = typeof options.sky === 'string' ? SKY_LABELS[options.sky]?.phrase : '';
  if (time) parts.push(time);
  if (sky) parts.push(sky);
  for (const key of enabledRemovals(options)) parts.push(CLEANUP_LABELS[key].phrase);

  const extra = typeof options.additionalPrompt === 'string' ? options.additionalPrompt.trim() : '';
  if (extra) parts.push(extra);

  return parts.length
    ? `Enhance this exterior property photo: ${parts.join(', ')}`
    : 'Enhance this exterior property photo with a light, natural correction pass';
}

/**
 * The QA rubric for an exterior render.
 *
 * QUALITY_REVIEW_PROMPT opens with "AI-generated interior real-estate photos" and lists
 * interior failures (warped furniture, extra legs). Pointed at a facade it grades against
 * the wrong rubric entirely — and, worse, is silent about the defects this edit actually
 * produces, which are all at the roofline/sky boundary. Same lenient posture, same reply
 * format, so the retry loop's PERFECT/SCORE/WHY parsing is unchanged.
 */
export const EXTERIOR_REVIEW_PROMPT =
  'You are a LENIENT QA reviewer for AI-enhanced EXTERIOR real-estate photos (a house or '
  + 'building photographed from outside). Your ONLY job is to catch GLARING, obvious defects '
  + '— the kind anyone would notice at a glance and that make the photo look broken or fake: '
  + 'a halo, glow or smeared edge where the sky meets the roofline, foliage or wires; sky '
  + 'visible through solid walls or roofing, or opaque where it should show through trees and '
  + 'railings; shadows on the building that contradict the sky\'s light direction; duplicated, '
  + 'warped or melted windows, doors, columns, railings or roof detail; smeared brick, siding '
  + 'or roofing texture; obviously impossible geometry or perspective; unreadable garbled '
  + 'text on signage or house numbers; or a leftover fragment of an object that was supposed '
  + 'to be removed — a cast shadow, a limb or a patch of snow left where the thing itself is '
  + 'gone; or an area rebuilt after a removal that plainly does not match the surface around '
  + 'it. '
  + 'Be lenient with everything else: minor imperfections, subtle oddities, soft details, or '
  + 'anything only noticeable on close inspection are FINE and must PASS. Do NOT nitpick, and '
  + 'do NOT judge the property itself — peeling paint, a worn driveway, an untidy lawn or a '
  + 'parked car left in frame are the subject, not defects. When in doubt, ACCEPT.\n'
  + 'Reply on the FIRST line with exactly "PERFECT: true" (no glaring defect) or '
  + '"PERFECT: false" (at least one glaring, obvious defect).\n'
  + 'If and only if it is NOT perfect, add a SECOND line "SCORE: <0-100>" rating how '
  + 'close it is despite the issue(s) (higher = fewer/milder issues).';

/**
 * The Exterior Studio's upload gatekeeper.
 *
 * WHY THIS EXISTS RATHER THAN REUSING STAGEABLE_IMAGE_CHECK_PROMPT
 * The interior gate rejects `5 = a car or other vehicle`, and its accept-list names
 * "patio, balcony, deck, yard, terrace, porch" but no facade or street view. Pointed at
 * this feature's canonical input — a front elevation with a car on the drive — it would
 * reject the exact photo the tool exists to fix, as VEHICLE or as UNRELATED_OBJECT.
 *
 * The DIGITS ARE DELIBERATELY THE SAME as unstageable.js's taxonomy, with 5 simply absent
 * from the list rather than renumbered. That file's header warns that a prompt drifting
 * from its taxonomy silently mislabels rejections; sharing one digit→meaning map across
 * both gates is what makes that impossible here. It also means no new
 * `errors.unstageable.*` keys and so no 11-pack translation change.
 */
export const EXTERIOR_CHECK_PROMPT =
  'You are the upload gatekeeper for a tool that enhances EXTERIOR photographs of real '
  + 'estate. Treat the image as VALID if it shows the outside of a building or its grounds '
  + 'in any form, including:\n'
  + '- A house, apartment block, or commercial building photographed from outside — front '
  + 'elevation, rear, side, or an angled or street view.\n'
  + '- A driveway, garden, yard, lawn, patio, deck, porch, terrace, balcony, pool area, '
  + 'courtyard, or any other outdoor part of a property.\n'
  + '- An aerial or drone view of a property and its plot.\n'
  + 'A photo is STILL VALID when parked cars, bins, hoses, toys, signage or clutter appear '
  + 'in it, even prominently — removing those is exactly what this tool does, so they are '
  + 'never a reason to reject. It is also still valid if a person happens to be in frame, if '
  + 'the property is covered in snow, if it is raining or the ground is wet, if the weather '
  + 'is poor, or if the photo is dull, grey or badly exposed — those are all conditions this '
  + 'tool is asked to clear, so they are reasons the photo was uploaded, not reasons to '
  + 'reject it.\n'
  + 'Reject ONLY when the image is clearly not a building exterior or property grounds at '
  + 'all.\n'
  + 'Reply with EXACTLY one line, "CODE: <n>", where <n> is a single digit picked from '
  + 'this list:\n'
  + '0 = VALID — a building exterior or property grounds. Also use 0 whenever you are '
  + 'unsure.\n'
  + '1 = a person fills the frame (selfie, portrait, headshot)\n'
  + '2 = an animal or pet fills the frame\n'
  + '3 = food or drink\n'
  + '4 = a screenshot, document, page of text, or meme\n'
  + '6 = some other object, product, or an INDOOR room — not a building exterior\n'
  + 'Output nothing else.';

/**
 * Digits from the shared taxonomy that this gate must never reject on, whatever the
 * grader replies.
 *
 * EXTERIOR_CHECK_PROMPT does not offer `5`, but a grader that ignores the list and answers
 * from the interior taxonomy it has seen a thousand times would reject a driveway photo as
 * VEHICLE — the single most likely false rejection this feature has, and one that would
 * look like a random flake rather than a bug. Belt and braces: the reviewer drops these
 * and treats the upload as valid.
 * @type {ReadonlySet<string>}
 */
export const EXTERIOR_IGNORED_CODES = new Set(['5']);
