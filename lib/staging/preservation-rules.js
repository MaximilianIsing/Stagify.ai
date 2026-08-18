// The hard rules for interior staging: what a render may NEVER change about the room it
// was handed. Sibling of promptMatrix.js (the *style* layer, what furniture to add) and
// room-constraints.js (per-room-type rules); this file is the *property* layer, and it
// applies to every room type and every style.
//
// WHY THIS IS ITS OWN FILE, and why the block is emitted LAST:
//
// Staging used to bury these rules in the middle of generatePrompt()'s output and then
// append the user's free-text box under the words "Prioritize the following above
// everything else". A model reading that resolves the conflict exactly as instructed —
// "make it feel bright and open" outranked "do not resize the windows", and it enlarged
// them. The block now comes last and says, in its first line, that it outranks everything
// above it including the user's own words. Whichever block speaks last wins the argument;
// that is the same discipline ROOM_TYPE_CONSTRAINTS relies on to survive a remove-furniture
// request.
//
// This is the interior sibling of EXTERIOR_PRESERVATION_RULES in ./exterior-prompts.js.
// The two are deliberately NOT shared: that one names rooflines, driveways, kerbs and
// neighbouring properties, none of which exist in a bedroom. They share a shape, not a
// string — keep the two-tier structure and the override wording in sync by hand, and
// change both when the reasoning changes.

/**
 * What "permanent" means, in one place.
 *
 * Exists because promptMatrix.js and the preservation block below used to disagree: the
 * block forbade changing "fixtures" while the matrix ordered the model to ADD them ("a
 * walk-in shower", "subway tile backsplash", "chandelier lighting"). Both files now point
 * at this definition, so the two cannot drift into contradicting each other again.
 * @type {string}
 */
export const PERMANENT_ELEMENT_DEFINITION =
  'An element is PERMANENT if it is plumbed in, hard-wired, or fixed to the structure of ' +
  'the building — walls, windows, doors, openings, ceilings, floors, columns, beams, trim, ' +
  'baseboards, built-in cabinetry and counters, sinks, taps, baths, showers, toilets, ' +
  'vanities, ceiling and wall lights, and built-in appliances. Everything else — furniture, ' +
  'rugs, textiles, lamps that plug in, art, plants and accessories — is MOVABLE.';

/**
 * The machine-checkable form of the definition above: nouns a promptMatrix entry may never
 * tell the model to ADD. It is the same list of things, in the form a guard can scan for —
 * keep the two in step, because the prose is what the model reads and this is what the
 * build enforces.
 *
 * Scanned by test/staging/prompt-matrix-permanence.test.js. The previous version of this
 * rule was a comment in promptMatrix.js, and a comment does not block a deploy: the
 * bathroom prompts were cleaned of toilets and shower curtains and still shipped ordering
 * walk-in showers and floating vanities, because nothing checked.
 *
 * Deliberately NOT a ban on the words themselves — "keep the existing backsplash exactly as
 * photographed" is precisely what these prompts SHOULD say. The guard checks the verb.
 * @type {readonly string[]}
 */
export const PERMANENT_ELEMENT_NOUNS = Object.freeze([
  'backsplash', 'shower', 'shower door', 'shower enclosure', 'shower screen',
  'bathtub', 'bath tub', 'tub', 'basin', 'washbasin', 'wash basin', 'wc', 'water closet',
  'sink', 'faucet', 'tap', 'toilet', 'vanity', 'countertop', 'counter', 'kitchen island',
  'built-in', 'cabinetry', 'oven', 'dishwasher', 'microwave', 'wine cooler', 'range hood',
  'pendant lighting', 'pendant light', 'chandelier', 'ceiling light', 'wall light',
  'recessed lighting', 'statement lighting', 'lighting fixture', 'light fixture',
  'skylight', 'window', 'doorway', 'archway', 'fireplace', 'radiator', 'staircase',
  'wallpaper', 'natural lighting', 'crown molding', 'wainscoting', 'flooring',
]);

/**
 * The two-tier lock, emitted LAST by generatePrompt() and worded to outrank every
 * instruction above it, including the user's own free text.
 *
 * The split into two tiers is the whole design, and it mirrors EXTERIOR_PRESERVATION_RULES:
 *
 *  - TIER 1 is the structure of the property. No request reaches it. A staged photo that
 *    moves a wall or closes up a window depicts a home that does not exist, and an agent
 *    can publish it — so this tier is absolute regardless of what anyone typed.
 *
 *  - TIER 2 is surface finish (paint, wallpaper, flooring material). It is preserved BY
 *    DEFAULT but an explicit request may change it, which is what keeps the "Additional
 *    prompting" box worth having: "paint the walls sage" still works, while "make it bright
 *    and open" cannot move a wall.
 *
 * Tier 2 — and ONLY tier 2 — yields to a rule above it. That carve-out exists because this
 * block speaks last and therefore wins every argument, which is right for structure and
 * wrong for finish: ROOM_TYPE_CONSTRAINTS['Dorm'] forbids painting the walls (a student
 * cannot repaint university property), and without "AND no rule above forbids it" a dorm
 * user who typed "paint the walls sage" would get painted walls. Tier 1 keeps no such
 * carve-out — no room-type rule has any business moving a wall.
 *
 * WHY FRAMING LIVES HERE rather than in its own section. It used to be emitted separately,
 * as `CRITICAL — IMAGE FRAMING` in the middle of the prompt, and that section granted the
 * camera an exception: "move it ONLY if the user explicitly asked for a closer or different
 * crop". This block then denied it with no exception at all — and, speaking last, won. The
 * result was a rule nobody had decided: "zoom in on the seating area" was silently refused.
 * Two sections both claiming to own the camera is how that happens, so there is now one.
 * The camera is tier 1 (absolute) by decision: `render-persistence.js` stores the pristine
 * upload as the gallery's `before` image, and a re-cropped render would no longer line up
 * with it in the before/after slider.
 *
 * The Exterior Studio had the identical bug and was fixed the same way:
 * `EXTERIOR_PRESERVATION_RULES` in ./exterior-prompts.js now carries its own FRAMING section,
 * worded for a building rather than a room. The constant the two used to share is deleted —
 * sharing one wording across both studios is what let interior language ("ceiling line",
 * "placing new furniture") end up in a prompt about a facade.
 *
 * The window/door rule is phrased as a COUNT rather than as a list of nouns to "keep exactly
 * as they appear". A countable constraint is one the model can check itself against; an
 * abstract one it cannot. The partly-hidden clause is there because the most common way a
 * window disappears is that furniture was placed in front of where it used to be and the
 * model then had no reason to draw it at all.
 *
 * A factory rather than a constant, because there are now two variants of this block and one
 * of them is Bathroom's. Assembling both from this single template is what stops them
 * drifting: everything outside the two slots is physically the same string.
 * @param {string} fixtureClause - Tail of the structural bullet, naming which fixtures may never be added.
 * @param {string} installBullet - The whole "do not install / may install" bullet.
 * @returns {string} The assembled architecture lock.
 */
const interiorRules = (fixtureClause, installBullet) => `CRITICAL — PRESERVE THE ARCHITECTURE EXACTLY (this section overrides EVERY instruction above it, including any request in the user's own words):
- This is a photograph of a REAL room that a buyer will walk into. The edit may change the furniture. It must NEVER change the room.
- Do not add, remove, move, resize or reshape ANY permanent element: walls, windows, window frames, doors, doorways, door frames, wall openings, arches, skylights, ceilings, floors, room shape and dimensions, columns, beams, moldings, baseboards, trim, radiators, vents, fireplaces, stairs, built-in cabinetry and shelving, counters${fixtureClause}. Their number, position, size, shape and proportions must survive exactly.
- COUNT THEM: the output must contain the same number of windows, doors and wall openings as the input photo, in the same positions, at the same sizes, and with the same panes, frames and glazing bars. Never fill in, wall over, shrink, enlarge, duplicate or relocate one — and never add one either, however much better the room would look with it. A window or door that is PARTLY HIDDEN behind furniture in the input is still a window or door in the output — draw it, do not close it up.
${installBullet}
- Where furniture is removed, rebuild only what it was hiding, continuing the surrounding wall, floor and trim exactly as they appear elsewhere in the photograph. Uncovering a surface is never permission to improve, clean, resurface or modernise it.

FRAMING — the shot is fixed too, and no request may change it:
- Do not change the room's structure or layout, its ceiling height, or the camera's position, angle, lens, zoom or framing. No request may re-crop, zoom, or re-frame the photograph.
- Output the image at the EXACT same aspect ratio, orientation and canvas dimensions as the input photo, with the geometry undistorted — no stretching, squashing, letterboxing or padding.
- Keep the FULL scene from the input in frame — every edge and corner, and the entire ceiling line, floor line, and all walls that appear in the original must stay visible.
- Fit every staging change INSIDE the existing frame, scaling and placing new furniture so the entire original room stays visible and in frame.

DEFAULT-PRESERVE (change these ONLY if the user explicitly asked for it above, AND no rule above forbids it):
- Wall colours, paint, wallpaper, wall textures and materials; floor materials, finishes and patterns; and the finishes of existing permanent fixtures.`;

/* THE SECOND BAN, and the one it is easy to miss. The structural bullet above lists the
 * elements that may not be ADDED, and "plumbed or hard-wired fixtures" is one of them — so
 * relaxing only the install bullet below would leave the block ordering a bath in one
 * sentence and forbidding it two sentences earlier. A prompt that contradicts itself is
 * precisely what this file exists to stop, and the model resolves such a contradiction by
 * picking whichever side it likes. Both slots move together or neither does. */
const DEFAULT_FIXTURE_CLAUSE = ', and plumbed or hard-wired fixtures';
const BATHROOM_FIXTURE_CLAUSE = ', and hard-wired light fittings (the plumbing fixtures permitted below are the sole exception, and only on the terms stated there)';

/* The default install bullet: nothing permanent may be brought into existence. This is the
 * text every room type but Bathroom gets, and it is unchanged from when it lived inline. */
const NO_INSTALL_BULLET =
  '- Do not install anything permanent that is not already there: no new sink, tap, bath, shower, shower enclosure or screen, toilet, vanity, backsplash, counter, built-in cabinetry, built-in appliance, ceiling light, pendant, chandelier or wall light. If the room needs one to read as what it is, it is already in the photograph — keep that one.';

/* THE ONE CARVE-OUT, and the history behind it is why it is worded this tightly.
 *
 * Every Bathroom prompt used to open "Add a <style> toilet", and the model obliged — including
 * on the hardwood floor of a photo that was never a bathroom. Shower curtains got hung from
 * ceilings for want of an enclosure, and asked for a walk-in shower the model built one OVER A
 * WINDOW. On 2026-08-17 the fixtures were struck from the prompts and banned here.
 *
 * That fixed the damage and created a different problem: a room with no plumbing in it cannot
 * be staged as a bathroom at all, because "stage this as a bathroom" collapses into "decorate
 * this room". Staging a bathroom is a thing this product offers, so the answer is a permission
 * scoped to exactly that — not the blanket "Add a toilet" that caused the original mess.
 *
 * THREE THINGS KEEP IT SAFE, and none of them may be softened without re-reading the above:
 *   1. It is CONDITIONAL. Fixtures may only be created when the room has none. A real
 *      bathroom photo keeps the fixtures it has and must never receive a second set.
 *   2. WINDOWS AND DOORS ARE STILL UNTOUCHABLE. The COUNT bullet above still applies in full,
 *      and this bullet says again, in the sentence a model is most likely to be reading while
 *      it places a shower, that nothing may be built over an opening. That is the failure that
 *      actually happened.
 *   3. NOTHING ELSE MOVES. Backsplashes, counters, built-in cabinetry and appliances, and
 *      every kind of hard-wired light stay banned, and wall/floor MATERIALS remain
 *      DEFAULT-PRESERVE below — a bathroom may be installed, but the room is not retiled. */
const BATHROOM_INSTALL_BULLET =
  '- SANITARYWARE IS THE ONE EXCEPTION, and only when the room has none. If the photograph already shows a bath, shower, shower enclosure or screen, basin, taps, vanity, mirror or WC, keep every one of them exactly as photographed — do NOT add a second of anything, and do not replace, resize, restyle, or relocate what is there. ONLY IF the room contains no sanitaryware at all may you install it: a bath and/or a shower with its enclosure, a basin with taps, a vanity, and a WC, so the room reads as a real bathroom. Anything you install must stand on the existing floor against an existing solid wall — you may NOT build, extend, clad or tile a wall, partition or surround to mount it against, and if no existing solid wall will take a shower enclosure then fit a bath and no shower rather than inventing somewhere to put one. Nothing installed may be placed over, across, or in place of a window, door or wall opening, and nothing may cover, shrink or replace one — a fixture in front of a window is the single worst outcome here, worse than a room that does not read as a bathroom. Everything else remains forbidden: no new backsplash, counter, built-in cabinetry, built-in appliance, ceiling light, pendant, chandelier or wall light.';

/**
 * The architecture lock for every room type except Bathroom.
 * @type {string}
 */
export const INTERIOR_PRESERVATION_RULES = interiorRules(DEFAULT_FIXTURE_CLAUSE, NO_INSTALL_BULLET);

/**
 * The architecture lock for Bathroom staging: identical to INTERIOR_PRESERVATION_RULES in
 * every respect but the install bullet, because both are assembled from the same template.
 * Assembling rather than copying is the point — a second hand-maintained copy of a
 * twelve-clause block drifts, and the clause it drifts on is the one nobody re-reads.
 * @type {string}
 */
export const BATHROOM_PRESERVATION_RULES = interiorRules(BATHROOM_FIXTURE_CLAUSE, BATHROOM_INSTALL_BULLET);

/**
 * Pick the architecture lock for a room type. `generatePrompt()` calls this instead of
 * reaching for a constant, so the choice is made in exactly one place.
 * @param {string | null} [roomType] - Room-type key as promptMatrix spells it.
 * @returns {string} The preservation block to emit last.
 */
export function interiorPreservationRulesFor(roomType) {
  return roomType === 'Bathroom' ? BATHROOM_PRESERVATION_RULES : INTERIOR_PRESERVATION_RULES;
}

/**
 * The REVIEWER-facing half of the rule above, appended to the quality rubric only when
 * reviewImageQuality was handed the original photo as well as the render (`sourceDataUrl`).
 *
 * It lives here, next to the block it verifies, because the two must say the same thing:
 * a rule the prompt forbids and the reviewer does not check is a rule that silently stops
 * being enforced. Edit them together.
 *
 * WHY IT EXISTS AT ALL. The staging reviewer used to be shown the OUTPUT ALONE. It could
 * not tell a correctly staged room from one whose window had been replaced by blank wall —
 * given nothing to compare against, the second is simply a photo of a room with no window,
 * and it scored PERFECT and shipped. The retry loop beneath it worked the whole time; it
 * was grading the wrong question.
 *
 * Two deliberate choices in the wording:
 *   • It suspends the rubric's closing "Do NOT nitpick. When in doubt, ACCEPT." That
 *     leniency is right for a slightly-odd cushion and catastrophically wrong here, so the
 *     exemption is stated outright rather than left for the model to infer.
 *   • The verdict is a COUNT of windows/doors/openings, not a judgement of whether the room
 *     "looks like" the original. Counting is a question a vision model answers reliably;
 *     holistic similarity is one it does not — and a staged room is SUPPOSED to look
 *     different, so anything vaguer flags every successful render.
 *
 * A factory for the same reason as interiorRules above — the Bathroom variant differs by one
 * inserted sentence and must not be a hand-maintained copy of the rest.
 * @param {string} roomClause - Room-specific sentence, or '' for the default clause.
 * @returns {string} The assembled reviewer clause.
 */
const architectureReviewClause = (roomClause) =>
  '\n\nARCHITECTURE CHECK — this is the ONE thing you must be STRICT about. Every leniency ' +
  'instruction above ("do not nitpick", "when in doubt accept", "a result that reasonably ' +
  'fulfills the request is good") applies to the staging, and NONE of it applies here.\n' +
  'The staged image must depict the SAME REAL ROOM as the original. Furniture, decor, rugs, ' +
  'art, plants and lighting mood are all EXPECTED to change — that is the whole point, so ' +
  'never flag those. But the room itself must not.\n' +
  roomClause +
  // Without this, the reviewer's own "judge against the request" line licenses the exact
  // drift this clause exists to catch: a render that enlarged a window genuinely does
  // "reasonably fulfil" a request like "make it brighter and more open", and the two
  // instructions sit hundreds of characters apart with nothing connecting them.
  'NO REQUEST CAN EXCUSE THIS. The user\'s request never makes an architecture change ' +
  'acceptable, however it was phrased. Asking for a room that is brighter, more open, more ' +
  'spacious, or airier is a request about STAGING AND LIGHT, never a licence to enlarge, add ' +
  'or remove a window, door or wall. If the request could only have been satisfied by ' +
  'changing the room, the correct answer is "changed".\n' +
  'Compare the two images and answer:\n' +
  '- Do they contain the SAME NUMBER of windows, doors and wall openings, in the same ' +
  'positions and at the same sizes? A window or door that is newly covered over, filled in, ' +
  'shrunk, enlarged, moved, duplicated, or invented is a FAILURE. A window that is merely ' +
  'partly hidden behind newly added furniture is FINE.\n' +
  '- Are the walls, ceiling, floor, room shape, built-in cabinetry, counters, fireplace, ' +
  'stairs, columns, beams and trim in the same places, at the same proportions, in the same ' +
  'materials and colours?\n' +
  '- Is the camera in the same position, at the same angle and framing?';

/**
 * The reviewer-facing clause for every room type except Bathroom.
 * @type {string}
 */
export const ARCHITECTURE_REVIEW_CLAUSE = architectureReviewClause('');

/* The reviewer half of BATHROOM_INSTALL_BULLET, and it is NOT cosmetic — leave it off and the
 * permission granted above half-works, in the most expensive way available.
 *
 * ../image/image-review.js computes `perfect` as `/PERFECT: true/ && architectureDrift !== true`
 * and then `score = Math.min(score, 20)` whenever drift is reported. A bathroom render that
 * correctly installed a basin reads as an architecture change to a reviewer told to check that
 * built-in cabinetry has not moved — so without this, every such render would be capped at 20,
 * drag the quality-retry loop through its full budget on every single generation, and write a
 * false architecture-drift row into the render-outcome CSV, poisoning the drift RATE that
 * column exists to measure.
 *
 * It grants exactly what the prompt grants and not one clause more: new sanitaryware is
 * expected, and a fixture over a window is still a failure. That symmetry is the rule stated in
 * ./review-prompts.js — what the prompt forbids and what the reviewer checks must say the same
 * thing. Edit the two together. */
const BATHROOM_REVIEW_CLAUSE_FRAGMENT =
  'THIS RENDER WAS STAGED AS A BATHROOM, and that changes exactly one thing about the check ' +
  'below. If the original photo contained no sanitaryware, then a bath, shower and its ' +
  'enclosure or screen, basin, taps, vanity or WC appearing in the staged image is EXPECTED ' +
  'and is NOT an architecture change — do not flag it, and do not count a newly added vanity ' +
  'as built-in cabinetry. Everything else is judged exactly as strictly as ever: the walls, ' +
  'windows, doors, wall openings, ceiling, floor, room shape, columns, beams and camera must ' +
  'all be unchanged, and a fixture placed over, across, or in place of a window or door IS a ' +
  'FAILURE.\n';

/**
 * The reviewer-facing clause for Bathroom staging.
 * @type {string}
 */
export const BATHROOM_ARCHITECTURE_REVIEW_CLAUSE = architectureReviewClause(BATHROOM_REVIEW_CLAUSE_FRAGMENT);

/**
 * Pick the reviewer clause for a room type — the mirror of interiorPreservationRulesFor, and
 * the reason both selectors live in this file rather than at their call sites.
 * @param {string | null} [roomType] - Room-type key as promptMatrix spells it.
 * @returns {string} The architecture clause to append to the quality rubric.
 */
export function architectureReviewClauseFor(roomType) {
  return roomType === 'Bathroom' ? BATHROOM_ARCHITECTURE_REVIEW_CLAUSE : ARCHITECTURE_REVIEW_CLAUSE;
}
