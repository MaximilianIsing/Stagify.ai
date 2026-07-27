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
