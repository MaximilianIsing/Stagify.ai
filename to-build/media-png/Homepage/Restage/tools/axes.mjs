// Variation axes for the #restage pool, and the two prompt clauses that keep renders usable.
//
// These values are the SAFE set. The pool's first sixty renders were generated from an
// earlier set whose values are recorded in ../manifest.json for provenance but are
// deliberately NOT reused here, because several of them are what broke:
//
//   * layouts naming the LEFT wall ("a sectional along the left wall", "tucked into the far
//     corner") — the open doorway recess is in that wall, so the model treats it as spare
//     wall and paints over it. Eight of the ten renders ever rejected used one.
//   * accents naming a wall without saying WHICH ("a tall leaning mirror against the wall
//     beside the window") — that is how a mirror ends up hung across the doorway.
//   * `rug: "no rug at all"` — crossed with a sparse arrangement it produces a room that
//     reads as unstaged. FULL_ROOM overrides it below.
//
// So: every layout here anchors seating on the back wall, the window side, or the middle of
// the room, and every wall-mounted accent names the BACK wall explicitly.
//
// The values come from two generations. Both are kept and drawn from as one pool — the
// generator checks each candidate recipe against the manifest, so there is no need to track
// which generation a value belongs to.

export const STYLES = ['standard', 'modern', 'midcentury', 'scandinavian', 'luxury', 'coastal', 'farmhouse'];

/** Phrased as a clause: the directive says `Use ${palette}.` */
export const PALETTES = [
  // generation 2
  'a soft butter and sage palette of pale yellow, sage green and warm white',
  'an inky palette of deep indigo, bone white and pale ash wood',
  'a plaster palette of limewash beige, chalk white and pale terracotta',
  'a burgundy palette of oxblood, dusty rose and warm taupe',
  'a chocolate palette of espresso brown, caramel and clotted cream',
  'a mineral palette of pale sage, soft clay and unbleached cotton',
  'a graphite palette of gunmetal grey, pale grey and blonde ash',
  'a saffron palette of golden yellow, warm white and pale honey wood',
  'a sea glass palette of soft aqua, sand and weathered white',
  'a plum palette of aubergine, mushroom grey and pale oak',
  'a copper palette of burnished copper, cream and dark walnut',
  'a spa palette of eucalyptus green, pale grey and bleached wood',
  'a chalk and denim palette of washed blue, soft white and raw pine',
  'a toffee palette of warm tan, biscuit and antique gold',
  // generation 3 — phrased as furniture/textile colour, never wall colour, because
  // HARD_ARCHITECTURE forbids repainting and naming a wall tone invites the model to try
  'furniture and textiles in ink black, bone white and pale ash — a graphic monochrome scheme',
  'furniture and textiles in tobacco brown, brass and cream, with a 1970s warmth',
  'furniture and textiles in celadon green, pale straw and unbleached linen',
  'furniture and textiles in oxidised teal, sand and pale birch',
  'furniture and textiles in raspberry, warm cream and honey oak',
  'furniture and textiles in charcoal, oatmeal and blackened steel — a quiet industrial scheme',
  'furniture and textiles in ochre, chalk white and pale terracotta, with a Mediterranean feel',
  'furniture and textiles in dusty lavender, soft grey and pale maple',
  'furniture and textiles in racing green, tan leather and antique brass',
  'furniture and textiles in persimmon orange, warm white and light walnut',
  'furniture and textiles in stone grey, ivory and pale limestone — an almost colourless scheme',
  'furniture and textiles in denim blue, ecru and weathered pine',
  'furniture and textiles in cocoa, blush and soft gold',
  'furniture and textiles in olive, bone and dark bronze',
  'furniture and textiles in butter yellow, sky blue and white — a light, cheerful scheme',
  'furniture and textiles in aubergine, silver grey and smoked oak',
  'furniture and textiles in clay red, cream and pale rattan, with a desert southwest feel',
  'furniture and textiles in seafoam, driftwood grey and chalk',
  'furniture and textiles in mustard, deep teal and warm walnut',
  'furniture and textiles in espresso, oat and burnished copper',
];

export const LAYOUTS = [
  'a low-profile sofa centred on the back wall with a pair of round swivel chairs in front of it and a wide clear walkway kept along the left-hand side of the room',
  'a curved sofa floating in the middle of the room facing the back wall, with a slim console table behind it and the left-hand side of the room left open',
  'a daybed under the window on the right and a pair of club chairs facing it across a round coffee table',
  'a modular sofa broken into two facing loveseats set on the diagonal in the centre of the room',
  'a long low sofa on the back wall, a nested pair of small coffee tables, and a single lounge chair angled in from the right-hand side',
  'a reading nook in the right-hand corner by the window with a wingback chair and ottoman, plus a two-seat sofa on the back wall',
  'a sofa on the back wall flanked by two narrow plant stands, with a pouf and a low bench used instead of a coffee table',
  'a wide sectional set against the back wall and opening toward the camera, with the walkway along the left-hand wall kept completely clear',
  'a pair of swivel chairs near the window and a three-seat sofa set at a right angle against the back wall',
  'a sofa set slightly off centre on the back wall with an oversized floor cushion and a slim round side table',
  'a three-seat sofa on the back wall facing the camera with two small accent chairs pulled up on the right-hand side',
  'a chaise longue angled toward the window and a compact two-seat sofa on the back wall, the centre of the floor left open',
  'a deep two-piece sectional set against the back wall opening toward the camera, with a wide clear walkway kept along the left-hand side',
  'a pair of facing three-seat sofas either side of a long coffee table, both floated in from the walls, centred in the room',
  'a single long sofa on the back wall with four small stools and a bench scattered in front of it',
  'a sofa on the back wall with a round table and two dining-height chairs set in the right-hand corner by the window',
  'a corner sofa in the RIGHT-hand corner nearest the window, with two armchairs facing it from the centre of the room',
  'a low platform sofa on the back wall, a long slim coffee table, and a single sculptural chair angled from the right',
  'a symmetrical pair of loveseats facing each other across the centre, with a console against the back wall behind one of them',
  'a lounge chair and ottoman claiming the window corner, with a three-seat sofa square against the back wall',
  'a curved conversation group pulled well forward of the back wall, leaving a clear band of floor behind it',
  'a sofa on the back wall, two swivel chairs facing it from the foreground with their backs to the camera, and a low table between',
  'a chaise and a two-seat sofa set at right angles in the right half of the room, with the left half kept as open floor',
  'a generous sectional wrapping the back-right corner, with a pouf and a nesting table set in front',
  'a sofa centred on the back wall flanked by two tall plants, with a pair of low armchairs angled in from either side',
  'a reading-room arrangement: two wing chairs and a small sofa around a central ottoman used as a table',
];

export const MATERIALS = [
  'a ribbed corduroy sofa in a warm solid tone',
  'brushed cotton canvas upholstery with a relaxed drape',
  'shearling-look boucle on the chairs with a smooth linen sofa',
  'aged cognac leather with a soft patina',
  'crisp cotton twill upholstery with tailored welted seams',
  'a nubby heathered wool blend with blackened metal legs',
  'polished travertine and pale ash tables with plain cotton seating',
  'brushed stainless and smoked glass tables with wool upholstery',
  'raw oak frames with washed heavy linen cushions',
  'plush chenille in a solid muted tone',
  'quilted cotton upholstery with turned wooden legs',
  'a boucle sofa in a solid tone with dark stained wood legs',
  'a channel-tufted velvet sofa with a low sheen',
  'washed Belgian linen with deliberately rumpled slipcovers',
  'pebbled leather seating with a matte finish',
  'a heavy basketweave cotton with contrast piping',
  'cane-backed chair frames in dark wood with flat woven cushions',
  'brushed mohair upholstery with a short dense pile',
  'oiled teak frames with thick canvas cushions',
  'a ribbed velvet sofa with fluted detailing and blackened metal feet',
  'raw silk cushions on pale lacquered frames',
  'a slubbed wool tweed with visible flecks',
  'burnished leather with turned oak legs and brass castors',
  'brushed cotton velvet with a deep buttoned back',
];

export const RUGS = [
  'a large ribbed wool rug in a solid warm tone',
  'a hand-knotted rug with an abstract painterly pattern',
  'a natural sisal rug with a wide cotton border',
  'a shaggy Moroccan-style rug in undyed wool',
  'a tonal striped flatweave rug',
  'a round rug centred under the coffee table, leaving the oak floor visible around it',
  'a vintage overdyed rug in a single saturated colour',
  'a soft cotton dhurrie in a faded two-tone check',
  'a thick undyed wool rug with a deep pile',
  'a flatweave rug with a bold oversized geometric block pattern',
  'a fine antique-style rug with a faded medallion',
  'a two-tone rug split diagonally across its width',
  'a tightly woven seagrass rug with a leather border',
  'a soft washed cotton rug in a single dusty tone',
  'a hide-look rug layered over a larger natural fibre base',
  'a rug with a narrow contrasting stripe running along each long edge',
  'a hand-tufted rug with an irregular painterly wash of colour',
  'a chunky braided wool rug in a heathered tone',
  'a pale rug with a fine grid of tonal squares',
];

export const LIGHTS = [
  'a slim column floor lamp with a linen drum shade beside the sofa',
  'a cluster of three slender floor lamps at different heights in the right-hand corner',
  'a low sculptural mushroom lamp on the console plus a small brass picture light on the back wall',
  'a large paper lantern floor lamp beside the window',
  'a black articulated floor lamp arcing over the reading chair',
  'a pair of ceramic table lamps with pleated shades',
  'a slender curved floor lamp with a small metal shade reaching over the coffee table',
  'warm table lighting: two small lamps plus a tray of candles on the coffee table',
  'a wide-shaded floor lamp beside the window and a small task lamp on the console',
  'a tall globe floor lamp on a slim stem beside the sofa',
  'a pair of shaded lamps on matching side tables plus a small picture light on the BACK wall',
  'an oversized drum-shaded floor lamp in the right-hand corner',
  'a jointed wooden floor lamp reaching over the reading chair',
  'two squat ceramic table lamps with wide linen shades',
  'a slim brass floor lamp by the window and a small glass lamp on the console',
  'a large arched floor lamp sweeping in from the right-hand side',
  'a trio of small table lamps at different heights across the console and side tables',
  'a paper-shaded standing lamp beside the sofa plus candlelight on the coffee table',
  'a low wide-shaded lamp on the console and a tall slim lamp in the window corner',
  'a sculptural alabaster table lamp and a plain floor lamp behind the seating',
];

export const ACCENTS = [
  'a triptych of three matching canvases centred on the BACK wall',
  'a tall plant in a woven basket in the right-hand corner by the window and a small trailing plant on the console',
  'a low bookshelf set against the BACK wall styled with books and two ceramic vessels',
  'a single large round mirror centred on the BACK wall',
  'a stack of art books and a sculptural bowl on the coffee table, with the walls left bare',
  'a pair of tall narrow canvases side by side on the BACK wall and a floor basket of rolled throws',
  'a wide horizontal landscape painting centred on the BACK wall above the sofa',
  'an olive tree in a terracotta pot beside the window and one small framed print on the BACK wall',
  'a narrow console against the BACK wall holding a table lamp, books and a framed photograph',
  'a woven textile hung on the BACK wall above the sofa and a ceramic garden stool used as a side table',
  'a slim ladder shelf in the right-hand corner with trailing greenery, and one framed print on the BACK wall',
  'one very large single canvas dominating the BACK wall, and a low bowl on the coffee table',
  'a grid of nine small identical frames centred on the BACK wall',
  'a long low sideboard against the BACK wall styled with ceramics, books and a lamp',
  'two tall potted palms flanking the window, and a single framed print on the BACK wall',
  'a pair of round mirrors side by side on the BACK wall above the sofa',
  'open shelving against the BACK wall holding books, a small sculpture and trailing greenery',
  'a wide framed black-and-white photograph on the BACK wall and a stack of magazines on the ottoman',
  'a tall narrow plant in the right-hand corner, a bowl of lemons on the table, and one canvas on the BACK wall',
  'an asymmetric cluster of four frames of different sizes on the BACK wall',
  'a slim console on the BACK wall with a tall vase of branches and two small framed prints above it',
  'a large woven basket of throws beside the sofa and a single wide landscape canvas on the BACK wall',
  'a pair of ceramic table lamps bracketing a framed abstract on the BACK wall, with a tray of objects below',
  'a leaning artwork resting on a low bookshelf against the BACK wall, with a plant beside it',
];

/**
 * Recipe for candidate `i`. The strides are coprime to their axis lengths so the axes stay
 * out of phase; the generator additionally rejects any recipe already in the manifest, so
 * `i` is a search cursor, not a slot number — callers walk it upward until they have enough
 * unused recipes.
 */
export function pick(i) {
  return {
    style: STYLES[i % STYLES.length],
    palette: PALETTES[i % PALETTES.length],
    layout: LAYOUTS[(i * 3) % LAYOUTS.length],
    material: MATERIALS[(i * 5) % MATERIALS.length],
    rug: RUGS[(i * 7) % RUGS.length],
    light: LIGHTS[(i * 4) % LIGHTS.length],
    accent: ACCENTS[(i * 6) % ACCENTS.length],
  };
}

/** Stable identity of a recipe, for de-duplication against the manifest. */
export function recipeKey(v) {
  return [v.style, v.palette, v.layout, v.material, v.rug, v.light, v.accent].join('|');
}

/**
 * Keeps the room itself intact. The occlusion ban in the middle is not redundant with the
 * "do not wall it over" clause: two rejected renders left the doorway structurally present
 * and parked a large plant in the opening, which reads as "the doorway was removed" at
 * thumbnail size just the same.
 */
export const HARD_ARCHITECTURE =
  ' ABSOLUTELY CRITICAL — DO NOT ALTER THE ROOM ITSELF. There is an open doorway recess in ' +
  'the left-hand wall. It MUST remain an open, visible, unobstructed opening of exactly the ' +
  'same size, shape and position as in the source photo. Do NOT wall it over, do NOT fill it ' +
  'with flat wall, and do NOT hang or lean artwork, a mirror, shelving or a bookcase across ' +
  'it. Do NOT place a plant, lamp, sofa or any other furniture in front of it or inside it — ' +
  'leave the floor in that opening clear. Likewise keep the window on the right, the ceiling, ' +
  'the crown molding, the recessed ceiling lights, the baseboards, the wall colour and the ' +
  'oak floor exactly as they appear in the source photo — do NOT restain or recolour the ' +
  'floor, and do NOT add blinds, shutters or curtains to the window. Keep the camera framing ' +
  'identical. Add furniture only. Change nothing structural.';

/**
 * The anti-sparseness clause. A one-line "furnish generously" lost eight times out of
 * twenty-six: the architecture survived and the model then put two chairs in an empty room
 * with a bare back wall. Naming an inventory fixed all eight on the retry.
 *
 * The lettering ban rides along because the same pass produced a farmhouse render carrying a
 * mangled "HOME SWEET HOME" sign — any words in frame are a coin flip.
 */
export const FULL_ROOM =
  ' The room must be COMPLETELY and RICHLY furnished — a finished, professionally staged, ' +
  'move-in-ready living room, never a half-empty one. Include ALL of the following: a full-size ' +
  'sofa, at least two additional seats (armchairs, a loveseat or a chaise), a coffee table, at ' +
  'least one side table, a large area rug that sits under the whole seating group, framed ' +
  'artwork hung on the BACK wall, at least two lamps, styled objects on the coffee table, and ' +
  'at least one large plant. The BACK WALL MUST NOT BE LEFT BARE. Fill the floor area; do not ' +
  'leave a large empty expanse of bare boards in the foreground.' +
  ' NO text, lettering, signage, slogans, monograms, book titles or written words anywhere in ' +
  'the image — every surface stays wordless.';

/** The full `additionalPrompt` for one render. */
export function directive(v) {
  const rug = v.rug.startsWith('no rug') ? 'a large area rug that anchors the whole seating group' : v.rug;
  return [
    `Use ${v.palette}.`,
    `Arrange the room as follows: ${v.layout}.`,
    `Use ${v.material}.`,
    `Floor covering: ${rug}.`,
    `Lighting: ${v.light}.`,
    `Decor: ${v.accent}.`,
    FULL_ROOM,
    'Make this arrangement clearly distinct from any other staging of this room.',
    HARD_ARCHITECTURE,
  ].join(' ');
}
