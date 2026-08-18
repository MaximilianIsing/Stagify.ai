// Per-room-type hard rules — the constraints a room carries no matter which furniture
// style is picked. Sibling of promptMatrix.js: that file holds the *style* layer (what
// furniture to add), this one holds the *rules* layer (what must not change).
//
// Why these are NOT in promptMatrix, which would be the obvious home: generatePrompt()
// has two paths that skip or outrank a matrix entry, and a constraint placed there is
// silently lost on both.
//   • furnitureStyle === 'custom' replaces the matrix text wholesale with the user's own
//     prompt, so matrix-resident rules vanish exactly when someone types a freeform
//     request.
//   • The remove-furniture clause is prepended BEFORE the matrix text, so "remove all
//     existing furniture" would outrank anything the matrix says about keeping something.
// generatePrompt appends these after both, so they apply to every style and get the last
// word. See docs/guides/architecture.md#staging-prompt-assembly.

/**
 * Extra hard rules appended for room types that carry constraints the generic staging
 * prompt cannot express. Keyed by the same room-type key as promptMatrix; a room type
 * with no entry simply contributes nothing.
 * @type {Record<string, string>}
 */
export const ROOM_TYPE_CONSTRAINTS = {
  /* A bathroom with no plumbing in it is not a bathroom. Bathroom is the one room type
     permitted to have fixtures INSTALLED (see BATHROOM_PRESERVATION_RULES in
     ./preservation-rules.js, which is the block that actually grants it — this entry is the
     positive instruction that block makes room for).

     WHY THE RULE IS HERE AND NOT IN promptMatrix, which is where the style wording lives:
     both of this file's stated reasons bite on exactly this rule.
       - `furnitureStyle === 'custom'` replaces the matrix entry with the user's own words, so
         a customer typing "make it spa-like" against their real bathroom would otherwise get
         the relaxed lock with NO keep-clause anywhere in the prompt — and a second toilet.
       - `removeFurniture: true` prepends "First, remove all existing furniture and decor",
         which would outrank a keep-clause sitting in the matrix text after it. The hero
         generator passes exactly that flag.
     Emitted at step 4, after both, so it survives both.

     THE ORDER OF THE TWO CASES IS DELIBERATE: keep-what-exists comes first, because that is
     the sentence protecting a real customer's photograph, and the install case is written as
     an exception to it rather than the other way round. */
  'Bathroom': `CRITICAL — BATHROOM FIXTURES (applies to every style, including a free-text request, and outranks any instruction above to remove what is already in the room):
- KEEP WHAT IS ALREADY THERE. Any bath, shower, shower enclosure or screen, basin, taps, vanity, WC or fitted mirror visible in the photograph must survive exactly as photographed — same position, size, shape, material and finish. Never remove one, never relocate one, never swap one for a nicer one, and NEVER ADD A SECOND of something the room already has. A bathroom that already has a basin needs no basin.
- ONLY IF THE ROOM HAS NONE may you install them. A room with no sanitaryware at all that is being staged as a bathroom should be given the fixtures a real bathroom needs — a bath and/or a shower with its enclosure, a basin with taps, a vanity and a WC — in the furniture style asked for above.
- ANYTHING YOU INSTALL GOES AGAINST SOLID WALL. Stand it on the existing floor, against existing opaque wall. Never place, build or extend a fixture over, across or in front of a window, door, wall opening or glazed wall, and never cover, shrink, wall over or hide one to make space. If a fixture will not fit without touching an opening, use a smaller fixture — never a changed room.
- NO NEW WALLS, AND THAT INCLUDES THE ONE A SHOWER WOULD NEED. Do not build, add, extend, thicken or clad a wall, partition, stud wall, half wall, tiled surround, backing panel or alcove in order to mount, enclose, support or hide a fixture. A shower screen or enclosure may only be fixed to a wall that is ALREADY in the photograph, and a vanity or basin may only stand against one. Glazing is not a wall: never tile, panel, clad or build against a window or a glazed wall.
- IF THERE IS NOWHERE LEGAL TO PUT A SHOWER, DO NOT PUT ONE IN. Where no existing solid wall is long enough to take an enclosure, fit a freestanding bath instead and leave the shower out entirely. A bathroom with a bath and no shower is a correct result; a bathroom with an invented wall is not, and is worse than no bathroom at all.
- DO NOT RESHAPE THE ROOM TO SUIT THE PLUMBING. No moved or added walls, no changed ceiling height, no altered room shape or dimensions, and no new window or skylight, however much better the bathroom would look with one.
- A SHOWER CURTAIN NEEDS SOMETHING TO HANG FROM. Only add one where there is a bath or an enclosure to hang it on; never suspend one from the ceiling.
- NOTHING ELSE BECOMES INSTALLABLE. Backsplashes, counters, built-in cabinetry, built-in appliances, ceiling lights, pendants, chandeliers and wall lights remain forbidden, and wall and floor materials elsewhere in the room stay exactly as photographed.`,

  // A college dorm is university property: the student cannot swap the issued furniture,
  // so a staging that restyles it is useless to them no matter how good it looks.
  'Dorm': `CRITICAL — FIXED UNIVERSITY-ISSUED FURNITURE (overrides every other instruction above, including any request to remove existing furniture):
- The following pieces are FIXED university property and MUST be preserved exactly as they appear in the photo — same model, material, finish, color, proportions, hardware and position: the desk (and any attached hutch, shelf or drawers), the bed frame including its posts, rails, headboard, footboard and any loft/bunk hardware, the built-in or freestanding wardrobe/closet unit, and the dresser.
- Do NOT replace, restyle, refinish, repaint, resize, upgrade, remove or relocate any of those pieces. Do not swap the issued desk for a nicer desk or the metal bed frame for an upholstered one. Their institutional, utilitarian look is correct and must survive into the final image.
- If the room is bare and one of those pieces is absent, add a plain standard-issue version of it — simple metal or laminate construction, neutral finish, no ornament — placed against a wall in a sensible dorm layout, then treat it as fixed and style around it exactly as above.
- Everything else is fair game: bedding and pillows, rugs, lamps and string lights, desk chair, desk accessories, storage bins and baskets, hamper, mirror, wall art, photos, curtains and plants. Achieve the entire style transformation through these moveable, removable, damage-free items.
- Hang wall decor with removable, damage-free mounting only. Do not paint walls, add wallpaper, or install anything requiring permanent fixings.

CRITICAL — DORM SCALE AND FOOTPRINT (dorm rooms are small; getting scale wrong here is the most damaging error):
- Treat the room as genuinely small. Judge the size of every added item against the FIXED issued furniture already in frame — a standard twin/twin-XL bed is about 38 inches wide and a standard dorm desk about 24 inches deep, so use them as the measuring stick for the rug, chair, storage and decor.
- Do not enlarge the room, push back walls, or widen the floor to make furnishings fit. If a piece will not fit, use a smaller piece — never a bigger room.
- Size the rug to the actual open floor between the bed and the desk; it must not slide under the fixed furniture or run wall to wall unless the floor genuinely allows it.
- Keep a clear, walkable path from the door to the bed, desk and window, and leave the desk chair room to pull out. Do not block the door, the closet doors or the window.
- Favor the vertical, space-saving solutions real students use — over-door hooks, stacking bins, under-bed storage, wall shelves, clip lamps — over floor-hogging furniture. Do not add a sofa, coffee table, dining set, king or queen bed, or any piece a dorm room could not physically hold.`,
};
