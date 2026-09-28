/* Stagify.ai — #faq, what stands in each room of the architectural sheet.
 *
 * Data only. It moved out of home-faq-plan.js when that file hit the 650-line cap, and
 * this is the piece that should go: it is a table, it is the part most likely to be
 * edited by someone laying out a room rather than changing behaviour, and it has no
 * dependency on the module it came from. home-faq-plan.js re-exports FURNITURE so the
 * import in test/frontend/home-faq-plan.test.js — which owns every rule that keeps these
 * numbers honest — did not have to move with it.
 */

/**
 * Furniture per room: `[symbol, fx, fy, widthMetres, depthMetres, quarterTurn?]`, where
 * fx/fy are the item's CENTRE as a fraction of the room.
 *
 * SIZES ARE REAL METRES, not fractions, because the rooms are different shapes — a sofa
 * scaled to "20% of the room" would be a different sofa in every room, which is the tell
 * that gives away a fake plan. Note this only became true when the symbols got
 * `preserveAspectRatio="none"`: before that every one was letterboxed to its smaller side,
 * so a 2.4 x 0.9 m sofa drew as a 0.9 m square and these numbers were decorative.
 *
 * WIDTH AND DEPTH ARE ALWAYS THE ON-PLAN FOOTPRINT, before and after any turn. The
 * optional sixth entry rotates the SYMBOL, in quarter turns clockwise, and mountRoom swaps
 * the box it draws into so the piece still lands in exactly the rectangle these two numbers
 * describe. That keeps one meaning for the sizes, which is what lets the spec check
 * overhang, label-band and door-swing clearance without knowing anything about rotation.
 *
 * Everything is drawn facing SOUTH, so the turn is the piece's facing: 90 faces west, 180
 * faces north, 270 faces east. A backed piece against a wall wants its back TO the wall.
 *
 * Exported so the test can assert that every room in the markup has an entry, that every
 * symbol it names exists in index.html's <defs>, that nothing overhangs a wall, that
 * nothing intrudes into the label band at the top of the room, and that every turn is a
 * quarter one.
 *
 * @type {Record<string, Array<[string, number, number, number, number] | [string, number, number, number, number, number]>>}
 */
export const FURNITURE = {
  // Living room: sofa facing a media unit, armchair turned in at the side.
  //
  // NO RUGS ANYWHERE, and it is worth saying why once here rather than rediscovering it.
  // A rug is a floor finish, so the only way to draw it is a broken outline — and at the
  // size a room actually renders (~180px across, ~35px per metre) a dashed rectangle
  // stops reading as a finish and reads as a checkered box around the seating, competing
  // with the furniture standing on it instead of sitting under it. Three rooms carried
  // one; all three look cleaner without.
  basics: [
    ['fp-sofa', 0.375, 0.505, 2.3, 0.9],
    ['fp-coffee', 0.36, 0.755, 1.1, 0.6], ['fp-tv', 0.36, 0.935, 1.5, 0.4, 180],
    ['fp-armchair', 0.7, 0.6, 0.9, 0.85, 90], ['fp-lamp', 0.76, 0.9, 0.5, 0.5],
    ['fp-plant', 0.085, 0.47, 0.6, 0.6],
  ],
  // Study: desk facing the room, chair pushed in.
  turnaround: [
    ['fp-desk', 0.42, 0.5, 1.9, 0.85],
    ['fp-chair', 0.42, 0.75, 0.75, 0.75, 180], ['fp-nightstand', 0.72, 0.5, 0.6, 0.5],
    ['fp-lamp', 0.66, 0.9, 0.5, 0.5], ['fp-plant', 0.9, 0.88, 0.65, 0.65],
  ],
  // Dining: table with a chair drawn up on each side.
  pricing: [
    ['fp-table', 0.58, 0.6, 1.6, 0.9], ['fp-chair', 0.315, 0.6, 0.7, 0.7, 270],
    ['fp-chair', 0.86, 0.6, 0.7, 0.7, 90],
    ['fp-plant', 0.9, 0.9, 0.6, 0.6], ['fp-lamp', 0.1, 0.915, 0.5, 0.5],
  ],
  // Sitting room: sofa and armchair facing each other over a coffee table.
  studios: [
    ['fp-sofa', 0.55, 0.49, 2, 0.85],
    ['fp-coffee', 0.55, 0.7, 1, 0.5], ['fp-armchair', 0.55, 0.888, 0.85, 0.75, 180],
    ['fp-plant', 0.1, 0.9, 0.6, 0.6],
  ],
  // The deep room: a study at the top, a sitting area below it.
  control: [
    ['fp-desk', 0.5, 0.45, 1.8, 0.8], ['fp-chair', 0.5, 0.575, 0.75, 0.75, 180],
    ['fp-sofa', 0.52, 0.705, 2, 0.9], ['fp-coffee', 0.52, 0.818, 1, 0.55],
    ['fp-armchair', 0.2, 0.93, 0.85, 0.8],
    ['fp-plant', 0.9, 0.93, 0.6, 0.6],
  ],
  // Bedroom: bed between two nightstands, wardrobe on the far wall, chair by the window.
  photos: [
    ['fp-bed', 0.32, 0.6, 1.7, 2.1],
    ['fp-nightstand', 0.09, 0.45, 0.5, 0.45], ['fp-nightstand', 0.55, 0.45, 0.5, 0.45],
    ['fp-wardrobe', 0.32, 0.94, 2.2, 0.6, 180], ['fp-armchair', 0.85, 0.55, 0.9, 0.85, 90],
    ['fp-lamp', 0.87, 0.72, 0.5, 0.5], ['fp-plant', 0.86, 0.93, 0.65, 0.65],
  ],
  // The one round table on the sheet. Nine rooms of rectangles read as a grid of boxes
  // however well each box is drawn, so one room gets a different geometry.
  disclosure: [
    ['fp-round', 0.58, 0.645, 1.15, 1.15], ['fp-chair', 0.33, 0.645, 0.65, 0.65, 270],
    ['fp-chair', 0.83, 0.645, 0.65, 0.65, 90],
    ['fp-plant', 0.92, 0.9, 0.55, 0.55],
  ],
  privacy: [
    ['fp-desk', 0.6, 0.5, 1.7, 0.8], ['fp-chair', 0.6, 0.78, 0.75, 0.75, 180],
    ['fp-plant', 0.3, 0.89, 0.6, 0.6],
    ['fp-lamp', 0.3, 0.6, 0.45, 0.45],
  ],
  // Kitchen and dining: a run with a sink and a hob, table below it.
  whyStagify: [
    ['fp-counter', 0.5, 0.43, 3.4, 0.65], ['fp-sink', 0.28, 0.43, 0.6, 0.45],
    ['fp-hob', 0.7, 0.43, 0.6, 0.45], ['fp-table', 0.5, 0.7, 1.5, 0.9],
    ['fp-chair', 0.5, 0.5625, 0.7, 0.7], ['fp-chair', 0.5, 0.8375, 0.7, 0.7, 180],
    ['fp-plant', 0.9, 0.93, 0.6, 0.6],
  ],
};
