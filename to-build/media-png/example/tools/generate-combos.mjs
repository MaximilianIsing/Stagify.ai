// The hero style/room grid generator.
//
// The homepage hero lets a visitor pick a room type AND a furniture style, and shows the
// matching render of ONE room: public/media-webp/example/Original.webp. That needs a photo
// for every combination, so this script builds the whole grid by driving the repo's own
// pipeline (createStagingGeneration().processStaging), exactly like the #restage pool
// generator at to-build/media-png/Homepage/Restage/tools/generate.mjs does. Every image is
// therefore genuine Stagify output built from lib/staging/promptMatrix.js, which is the
// point: the hero is a claim about what the product does, so it has to BE what the product
// does. Only virtual-staging-handler.js is bypassed (auth, rate limits, DB writes, R2).
//
//   node to-build/media-png/example/tools/generate-combos.mjs            # fill every gap
//   node to-build/media-png/example/tools/generate-combos.mjs --only bedroom
//   node to-build/media-png/example/tools/generate-combos.mjs --redo modern-kitchen
//   node to-build/media-png/example/tools/generate-combos.mjs --list
//   node to-build/media-png/example/tools/generate-combos.mjs --rebuild   # no API calls
//
// Resumable by design: a combination whose .webp already exists is skipped, so an
// interrupted run costs nothing to restart. Use --redo to re-roll one you have rejected.
//
// Writes the PNG master plus the whole srcset ladder (see CANDIDATES):
//   to-build/media-png/example/<style>-<room>.png          the master, native 1248x832
//   public/media-webp/example/<style>-<room>.webp          canonical / no-srcset fallback
//   public/media-webp/example/<style>-<room>-{900,1872,2496}.webp
//
// --rebuild RE-CUTS THE SERVED FILES FROM THE PNG MASTERS AND CALLS NO API. Reach for it
// whenever CANDIDATES changes: the rooms are already decided, and re-rendering to change an
// encoder setting would throw away curated output and roll new rooms for no reason.
//
// Outdoors and Dorm are deliberately absent from ROOMS. Outdoors belongs to Exterior Studio
// and reads as broken in the hero sentence ("Stage this Outdoors in Modern"); Dorm was
// excluded by request. Both still exist in promptMatrix.js and are untouched by this script.
//
// Needs GOOGLE_AI_API_KEY in .env (or the environment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createStagingGeneration } from '../../../../lib/staging/staging-generation.js';
import { generateWithQualityRetry } from '../../../../lib/staging/staging-pipeline.js';
import { createImageReview } from '../../../../lib/image/image-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTERS = path.resolve(HERE, '..');
const REPO = path.resolve(HERE, '../../../..');
const SRC_MASTER = path.join(MASTERS, 'Original.png');
const SERVED = path.join(REPO, 'public/media-webp/example');

/* EVERY IMAGE IN THIS FOLDER MUST SHARE THESE DIMENSIONS, `Original` included. The hero
   cross-fades between them, so a stray size shows up as a jump rather than a fade. If you
   change them, re-run the whole grid AND re-cut Original.webp to match.

   THE MODEL'S NATIVE OUTPUT, not a number picked for looks. A 3:2 source pins
   imageConfig.aspectRatio to 3:2 (see resolveAspectRatioPin) and gemini-2.5-flash-image hands
   back 1248x832 for that bucket — measured, not assumed. This used to write 900x600, which
   threw 1.39x of linear resolution away at generation time and left nothing to re-encode
   from later: the PNG master was downsampled too, so the only way to recover it was to
   re-render every combination.

   Why it mattered: the hero stopped being a photo column in a two-column layout (which is
   what 900 was sized for) and became a full-bleed canvas that paints ~1104 CSS px wide. At
   900 the browser was upscaling 1.84x on an ordinary 1.5-DPR display. Do not lower these
   again without re-checking that measurement — `.hp-canvas` is the LCP element. */
const OUT_W = 1248;
const OUT_H = 832;
const OUT_Q = 80;

/* THE SRCSET LADDER. Every candidate is cut from the SAME master buffer, so they cannot
   drift into showing different rooms, and the whole ladder is rebuildable from the PNGs with
   `--rebuild` — no API calls, no new rooms.
 *
 * WHY THERE ARE CANDIDATES ABOVE THE NATIVE 1248. Serving the native file meant the browser
 * ENLARGED it to fill the canvas (1.33x on an ordinary 1.5-DPR display, 1.77x at 2x), and a
 * browser upscale is soft by construction — it interpolates and never sharpens. Hand it more
 * pixels than the box needs and it DOWNSCALES instead, which is inherently crisp. That is the
 * whole trick, and it is not a new idea in this codebase: upscaleForDelivery() in
 * lib/image/image-primitives.js already does exactly this to every render a real user is
 * served — 2x lanczos3, a gentle unsharp, WebP — because the image models return ~1 MP. The
 * hero grid was the one path that skipped it. These numbers mirror that function on purpose.
 *
 * Not called directly, though, and the reason is worth writing down: upscaleForDelivery takes
 * and returns data URLs and stamps `staged` disclosure metadata on the way through. Both are
 * right for a user's download and wrong for a build asset that is about to be committed as a
 * plain file. The operations are the same; the packaging is not.
 *
 * WIDTHS ARE CHOSEN AGAINST REAL DEVICE NEEDS (cssWidth x DPR), not round numbers:
 *   ~780  phone at 2x      -> 900
 *   ~1170 phone at 3x      -> 1248
 *   ~1640 tablet at 2x     -> 1872
 *   ~1665 desktop at 1.5x  -> 1872
 *   ~2220 desktop at 2x    -> 2496
 * so every case lands on a candidate at or ABOVE what it needs, i.e. on a downscale.
 *
 * `suffix: ''` is the canonical file. It stays the NATIVE size because it is what <img src>,
 * the <link rel="preload"> href and test/frontend/hero-picker-lcp.test.js all point at — the
 * no-srcset fallback should be honest pixels, not interpolated ones.
 *
 * Quality drops as the candidates grow: q80 where the pixels are real, q72 above native,
 * where the image will be downscaled again on screen and compression artefacts shrink with
 * it. That is what keeps the 2496 file at ~94 KB rather than ~119 KB. */
const CANDIDATES = [
  // Downscale from the master — a light unsharp puts back the edge the resample softens.
  { suffix: '-900', w: 900, h: 600, q: 80, sharpen: 0.5 },
  // Native. No resample happens at all, so nothing to sharpen and nothing to invent.
  { suffix: '', w: 1248, h: 832, q: 80, sharpen: 0 },
  { suffix: '-1872', w: 1872, h: 1248, q: 72, sharpen: 0.7 },
  { suffix: '-2496', w: 2496, h: 1664, q: 72, sharpen: 0.7 },
];

/** The `srcset` value these candidates add up to, for one image basename. */
const srcsetFor = (base) => CANDIDATES.map((c) => `${base}${c.suffix}.webp ${c.w}w`).join(', ');

/* THE GATE STILL SCORES IN THE 900x600 FRAME, and that is deliberate — do not "fix" it to
   match OUT_W. Every box in REGIONS below, and every threshold beside it, was calibrated by a
   human picking bad renders blind at 900x600. Rescaling the frame would silently invalidate
   two rounds of that calibration for no benefit: the metric compares a render against the
   source, and both are resampled to the same frame first, so the frame's absolute size is
   arbitrary. Keeping it fixed is what makes today's numbers comparable with the ones in the
   comments below. */
const SCORE_W = 900;
const SCORE_H = 600;

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 4;

/* --------------------------------------------- the changed-architecture gates
 *
 * The failure mode here with a working numeric screen. The source room has three things the
 * model keeps rewriting so it has somewhere to put furniture: the left glass wall, the
 * structural column with the far wall behind it, and the right window bank. Replace any of
 * them and you get a handsome room that is no longer THIS room, which is the whole promise
 * of a picker that swaps the pair inside a fixed frame.
 *
 * Mean absolute difference against the source over one box per region — the same trick the
 * #restage pool's arch-check.mjs uses on its doorway recess, and for the same reason: a
 * plain brightness test only catches the walled-over-in-white direction, not a dark mirror,
 * a marble cladding or a cabinet run hung across the glass.
 *
 * CALIBRATION, done blind. A human picked the bad renders without seeing any numbers, twice.
 * Round one (right bank): the five they rejected scored 33.5-55.1, the one they kept 24.4.
 * Round two (left wall): the four they rejected scored 32.0-37.8, the next clean render 15.9
 * — and the metric additionally caught a fifth, a luxury Bathroom at 33.7 whose left wall had
 * been clad in marble, that they had not spotted. Each gate sits in its own gap.
 *
 * A HIGH SCORE IS A SCREEN, NOT A VERDICT, and the column box is the weakest of the three:
 * anything legitimately large standing near it — a wardrobe, a bookcase, a tall plant —
 * scores like removing it. Kitchens are over on column and right across the board because
 * cabinetry genuinely has to go somewhere. So this never fails a render; it retries, keeps
 * the best attempt, prints every region, and lists what is still over at the end. */
const REGIONS = [
  // The left glass wall. Gets clad in marble or tile, or walled over to hold a vanity.
  // Clean renders sit at 16 and below; the five a human rejected for it scored 32.0-37.8.
  { key: 'left', gate: 20, box: { left: 10, top: 60, width: 310, height: 350 } },
  // The structural column, and the far wall behind it. Kitchens bury it in cabinetry.
  // This one is the WEAKEST of the three: a tall cabinet or a plant standing beside the
  // column scores as high as removing it, so treat an over-gate column as "go and look",
  // never as proof. Kept because the failure it catches is the worst-looking one.
  { key: 'column', gate: 26, box: { left: 330, top: 100, width: 75, height: 310 } },
  // The right window bank. Walled over to hang a mirror, vanity or shower enclosure.
  { key: 'right', gate: 26, box: { left: 395, top: 160, width: 230, height: 240 } },
];

const GATE_ATTEMPTS = 3;

/** Room-type keys as promptMatrix.js spells them, paired with the slug used in filenames. */
const ROOMS = [
  { key: 'Bedroom', slug: 'bedroom' },
  { key: 'Living room', slug: 'living-room' },
  { key: 'Dining room', slug: 'dining-room' },
  { key: 'Kitchen', slug: 'kitchen' },
  { key: 'Office', slug: 'office' },
  { key: 'Bathroom', slug: 'bathroom' },
];

/** Style keys as promptMatrix.js spells them, in the picker's menu order. */
const STYLES = ['standard', 'modern', 'scandinavian', 'coastal', 'farmhouse', 'luxury', 'midcentury', 'custom'];

/* ------------------------------------------------------------------- the Custom brief
 *
 * WHY THIS EXISTS AT ALL. Every other style in the list above is a promptMatrix lookup and
 * needs nothing from this file. `custom` is the one that cannot be: read generatePrompt() in
 * lib/staging/prompts.js and the two branches are
 *
 *   custom + free text  →  the free text REPLACES the base prompt outright
 *   custom + no text    →  falls back to the 'standard' entry
 *
 * — because the matrix's own 'custom' row says "stage this room with the furniture and decor
 * the user asks for", which is a null instruction when nobody asked for anything. So rendering
 * this style the way the other seven are rendered would produce six files pixel-identical in
 * intent to the Standard row, and the hero's last menu entry would be a duplicate of its
 * first. Supplying the free text is not a cheat around the pipeline; it is exactly what a
 * visitor who picks Custom does, and it is the only input that makes the row mean anything.
 *
 * WHY THIS LOOK. Custom's job in the menu is to say "the six presets are not the limit", so
 * the render has to be visibly unreachable from any of them — if it reads as Luxury with a
 * different rug, the row argues against itself. Art Deco is deliberate on that count: the
 * presets span neutral-contemporary to rustic to coastal, and not one of them will give you
 * emerald velvet, brass and black lacquer. It also suits THIS room, which is the other half
 * of the choice — the source photo is a corner room with floor-to-ceiling glass and a
 * structural column, and stepped, symmetrical, metallic Deco furnishing reads as though it
 * were designed for that frame.
 *
 * ASK ONLY FOR THINGS THAT CAN BE CARRIED IN — with one room-shaped exception.
 * lib/staging/preservation-rules.js emits, LAST and with authority over this text, "do not
 * install anything permanent that is not already there: no new sink, tap, bath, shower,
 * shower enclosure or screen, toilet, vanity, backsplash, counter, built-in cabinetry,
 * built-in appliance, ceiling light, pendant, chandelier or wall light". A brief that asks
 * for any of those is not merely ignored — it spends the model's attention arguing with the
 * block that wins. Table lamps, floor lamps, candle holders, rugs, bar carts and freestanding
 * furniture are all fine; pendants and sconces are not. The first draft of these briefs asked
 * for stepped Deco pendants over the kitchen island and the dining table, which is exactly
 * the mistake this paragraph exists to stop someone repeating.
 *
 * THE EXCEPTION IS BATHROOM, AND ONLY BATHROOM. Since 2026-08-18 the block above has a second
 * variant that lets a room being staged as a Bathroom install sanitaryware when it has none,
 * because a room with no plumbing cannot be staged as a bathroom at all. The Bathroom brief
 * below therefore asks for fixtures, in the same conditional shape the matrix entries use.
 *
 * KITCHEN DID NOT GET THIS, and the distinction is worth stating plainly so nobody
 * generalises from the entry below: a kitchen may still not install cabinetry, counters or
 * built-in appliances. Its brief decorates the room it is given, so the Kitchen row conjures
 * an island and stools rather than a kitchen — a property of the source photo and the
 * preservation rules together, not of this file. hero-picker.js's ROOMS comment flags Kitchen
 * as the one to cut if the "same room" reading ever matters more than the coverage.
 *
 * Keyed by the room keys in ROOMS above; a room missing from here renders as `standard`. */
const CUSTOM_BRIEF = {
  'Bedroom':
    'Stage this bedroom as an Art Deco jewel box. Add a low bed with a tall scalloped emerald '
    + 'velvet headboard, black lacquer nightstands with brass pulls, opal glass globe lamps, a '
    + 'reeded-wood dresser with a brass sunburst mirror above it, ink-navy bedding with blush '
    + 'and gold accents, a fan-motif geometric rug in green and cream, a velvet bench at the '
    + 'foot of the bed, and framed line-art prints in slim brass frames. Use a palette of '
    + 'emerald, ink navy, blush and aged brass, in velvet, lacquer, smoked glass and reeded wood.',
  'Living room':
    'Stage this living room as an Art Deco jewel box. Add a curved emerald velvet sofa, a pair '
    + 'of scalloped blush armchairs, a round marble-and-brass coffee table, a black lacquer '
    + 'sideboard with brass inlay, a smoked-glass side table, a brass sunburst mirror, a '
    + 'fan-motif geometric rug in green and cream, opal glass globe lamps and a slim brass floor '
    + 'lamp, framed line-art prints in brass frames, and a tall palm in a fluted planter. Use a '
    + 'palette of emerald, ink navy, blush and aged brass, in velvet, lacquer, marble and reeded wood.',
  'Dining room':
    'Stage this dining room as an Art Deco jewel box. Add a round marble dining table on a '
    + 'fluted black lacquer pedestal, six emerald velvet dining chairs with brass-capped legs, a '
    + 'reeded-wood sideboard with brass hardware, a pair of opal glass globe table lamps on it, '
    + 'a smoked-glass centerpiece with white blooms, gold-rimmed dinnerware and coupe '
    + 'glasses, a fan-motif geometric rug in green and cream, a brass sunburst mirror, and framed '
    + 'line-art prints in brass frames. Use a palette of emerald, ink navy, blush and aged brass, '
    + 'in velvet, lacquer, marble and reeded wood.',
  'Kitchen':
    'Keep the existing cabinetry, counters, backsplash, sink and built-in appliances exactly as '
    + 'photographed — style around them as an Art Deco jewel box, installing nothing permanent. '
    + 'Add emerald velvet bar stools with brass-capped legs at any existing island or counter, a '
    + 'black lacquer bar cart with brass trim holding cut-glass decanters and coupe glasses, a '
    + 'marble tray, a brass kettle, a fluted ceramic canister set, a bowl of citrus, folded blush '
    + 'linen towels, a fan-motif geometric runner in green and cream, a potted palm in a fluted '
    + 'brass planter, and framed line-art prints in slim brass frames. Use a palette of emerald, '
    + 'ink navy, blush and aged brass, and keep the counters uncluttered.',
  'Office':
    'Stage this office as an Art Deco jewel box. Add a reeded-wood desk with brass-capped legs, '
    + 'an emerald velvet desk chair with a scalloped back, a black lacquer bookcase with brass '
    + 'trim and neatly arranged books, a brass desk lamp with a green glass shade, a slim brass '
    + 'floor lamp, a marble desk tray with a fountain pen, a smoked-glass side table, a fan-motif '
    + 'geometric rug in green and cream, framed line-art prints in brass frames, and a tall palm '
    + 'in a fluted planter. Use a palette of emerald, ink navy, blush and aged brass, in velvet, '
    + 'lacquer, marble and reeded wood.',
  /* The only brief here that may install something permanent, and only because Bathroom is
     the one room type the pipeline now permits it for (see the comment above the Bathroom
     block in lib/staging/promptMatrix.js). It still has to say so in the same conditional
     shape the matrix entries use, because free text REPLACES the matrix entry — the words
     below are the only thing standing between this and a second bath in a room that has one.
     The siting sentence is repeated verbatim for the same reason. */
  'Bathroom':
    'Stage this bathroom as an Art Deco jewel box. Keep any bath, shower, basin, taps, WC, '
    + 'vanity, mirror and tiling already in the photograph exactly as photographed — style '
    + 'around them, and never add a second one. Where the room has none, fit a freestanding '
    + 'roll-top bath on a stepped plinth with a floor-standing brass filler, a reeded-wood '
    + 'vanity with a marble top, an integrated basin and brass taps, and a concealed-cistern '
    + 'WC — and NO shower and no shower enclosure, because the only surfaces long enough to '
    + 'take one here are glazed. Everything stands on the '
    + 'existing floor against solid wall, never across a window, door or glazed wall. Add a '
    + 'brass sunburst mirror — and put the vanity, the mirror and the framed prints ALL on the '
    + 'plain solid wall at the FAR RIGHT of the room, leaving both glazed bays completely '
    + 'clear of furniture and completely unaltered. Add a freestanding reeded-wood towel valet hung with blush and cream '
    + 'towels, a black lacquer tray holding brass-capped cut-glass bottles, a fluted ceramic '
    + 'soap dispenser, a small marble stool, a fan-motif geometric bath mat in green and cream, '
    + 'a pair of brass candle holders, a potted palm in a fluted brass planter, and framed '
    + 'line-art prints in slim brass frames. Use a palette of emerald, ink navy, blush and aged '
    + 'brass, and keep it uncluttered.',
};

const nameOf = (style, room) => `${style}-${room.slug}`;
const webpPath = (n) => path.join(SERVED, `${n}.webp`);
const candPath = (n, c) => path.join(SERVED, `${n}${c.suffix}.webp`);
const pngPath = (n) => path.join(MASTERS, `${n}.png`);

function readKey() {
  if (process.env.GOOGLE_AI_API_KEY) return process.env.GOOGLE_AI_API_KEY.trim();
  const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq !== -1 && line.slice(0, eq).trim() === 'GOOGLE_AI_API_KEY') return line.slice(eq + 1).trim();
  }
  throw new Error('GOOGLE_AI_API_KEY not found in the environment or .env');
}

/* ------------------------------------------------------------------- render */

let pipeline = null;
function getPipeline() {
  if (pipeline) return pipeline;
  const genAI = new GoogleGenerativeAI(readKey());
  const { reviewImageQuality } = createImageReview({ genAI });
  pipeline = createStagingGeneration({
    genAI,
    DEBUG_MODE: false,
    runQualityRetry: generateWithQualityRetry,
    reviewImageQuality,
    QUALITY_MAX_ATTEMPTS: 2,
    logPromptToFile: () => {},
  }).processStaging;
  return pipeline;
}

/* THE SHAPE OF THE SOURCE ROOM, handed to every render as free text.
 *
 * See the comment on this constant's use in renderOnce below for why a description beats
 * another prohibition. In short: the architecture lock already forbids walling over a window,
 * and renders kept doing it — a farmhouse Kitchen swallowed the structural column in a cabinet
 * run, a standard Bedroom replaced the entire left glass wall with plasterboard to hang art
 * on, and four Bathrooms built a solid bay to mount a shower against. Every one of those is
 * the model solving "where do I put this?" the only way it could see. This tells it where.
 *
 * Kept factual and specific to Original.png. If the source photo is ever replaced, rewrite
 * this or delete it — a confidently wrong description of the room would be worse than none. */
const ROOM_GEOMETRY_HINT =
  'IMPORTANT — THE SHAPE OF THIS PARTICULAR ROOM, so you know where things can and cannot go. '
  + 'The entire left-hand wall is floor-to-ceiling glass looking over a city. A free-standing '
  + 'structural column rises floor to ceiling about a third of the way across. The bay to the '
  + 'right of that column is ALSO floor-to-ceiling glass. The ONLY solid wall in this room is '
  + 'the plain one at the far right. '
  + 'So: stand tall or wall-mounted pieces against that far-right solid wall, or place them '
  + 'freely on the floor clear of the glazing. Never mount, lean, tile, clad or build anything '
  + 'against the glass or against the column, and never convert a glazed bay into a solid wall '
  + 'to create somewhere to put something — if there is nowhere legal for a piece, leave that '
  + 'piece out. Both glass walls and the column must appear in your result exactly as they do '
  + 'in the photograph, at the same size and in the same place.';

async function renderOnce(style, room, srcBuffer) {
  let native = null;
  const dataUrl = await getPipeline()(
    srcBuffer,
    {
      roomType: room.key,
      furnitureStyle: style,
      /* EMPTY for every style but `custom`, on purpose: the grid has to show what
         promptMatrix.js alone produces for the pair, because that is what a visitor who picks
         the same pair gets. `custom` is the exception because for it the box IS the pair —
         see CUSTOM_BRIEF above for why an empty one would silently render `standard`. */
      /* The room-geometry description rides in on the free-text box, which is the only
         channel that reaches the model without displacing anything.
           - For every ordinary style it is appended as "prioritize this over the style
             guidance above", which is exactly its standing: it outranks where to put the
             sofa, and is itself outranked by the architecture lock emitted last.
           - For `custom` the box REPLACES the matrix entry, so the brief and the hint have
             to travel together or the brief would arrive with no geometry at all. */
      additionalPrompt: style === 'custom'
        ? `${CUSTOM_BRIEF[room.key] || ''}\n\n${ROOM_GEOMETRY_HINT}`
        : ROOM_GEOMETRY_HINT,
      /* TRUE, and it matters — this is not a formality on an already-empty room.
         With `false`, generatePrompt() appends "treat any furniture and decor named above as
         a guide to the desired STYLE only, NOT a checklist of items to place from scratch.
         Only ADD new complementary pieces in that style to fill empty or sparse areas."
         That is correct when the photo has the owner's furniture in it and wrong here: it
         demotes "clawfoot bathtub, wooden vanity, farmhouse sink" to mood words, so the model
         looked at an empty living room and produced a tastefully rustic LIVING ROOM. Twice in
         a row, for farmhouse Bathroom. `true` takes the branch that keeps the list a
         checklist; the "remove all existing furniture" clause it adds is a no-op on a room
         that has none. */
      removeFurniture: true,
      // Matches the existing example images and the #restage pool: these are product
      // demos of the render itself, and the stamp is applied on the user's own download.
      labelVirtuallyStaged: false,
      onNative: (buf) => { native = buf; },
    },
    { body: {} },
    null,
    'gemini-2.5-flash-image', // the free-tier default: what a normal visitor's render looks like
  );
  const raw = native || Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  // A PNG buffer rather than a live sharp pipeline: the caller has to both SCORE these
  // pixels and write two files from them, and re-decoding one buffer is cheaper and less
  // error-prone than cloning a pipeline three ways.
  return sharp(raw).resize(OUT_W, OUT_H, { fit: 'cover' }).png().toBuffer();
}

/** Greyscale pixels of every gated region, keyed by region. */
async function regionPixels(input) {
  const out = {};
  for (const r of REGIONS) {
    out[r.key] = await sharp(input).resize(SCORE_W, SCORE_H, { fit: 'cover' })
      .extract(r.box).greyscale().raw().toBuffer();
  }
  return out;
}

/** Mean absolute difference between two equal-length pixel buffers. */
function mad(pixels, sourcePixels) {
  let total = 0;
  for (let i = 0; i < pixels.length; i++) total += Math.abs(pixels[i] - sourcePixels[i]);
  return total / pixels.length;
}

/**
 * Score one render against the source across every region.
 *
 * Two numbers, and they do different jobs.
 *
 * `worst` (largest mad/gate ratio) decides PASS/FAIL: <= 1 means every region is inside its
 * own gate. Ratios rather than raw mads because the regions have different tolerances — the
 * left wall is a sheet of glass where any change is real, the column sits in white-on-white
 * and needs slack — so raw numbers are not comparable between them.
 *
 * `total` (sum of the ratios) decides WHICH ATTEMPT IS BETTER, and it has to be a sum, not
 * the max. Ranking on the worst region alone lets a render trade a healthy region for a
 * broken one and still look like an improvement: a luxury Kitchen with an intact left wall
 * (12.1) and a mangled right one was replaced by a version that had wrecked BOTH, because
 * its worst ratio was fractionally lower. Summing means breaking something that was fine
 * always costs more than it gains.
 */
function scoreRegions(pixels, sourcePixels) {
  const per = {};
  let worst = 0;
  let total = 0;
  for (const r of REGIONS) {
    per[r.key] = mad(pixels[r.key], sourcePixels[r.key]);
    const ratio = per[r.key] / r.gate;
    worst = Math.max(worst, ratio);
    total += ratio;
  }
  return { per, worst, total };
}

/** "left 12.1  column 36.4  right 54.3" with an over-gate marker. */
const formatScore = (score) => REGIONS
  .map((r) => `${r.key} ${score.per[r.key].toFixed(1)}${score.per[r.key] > r.gate ? '!' : ''}`)
  .join('  ');

/**
 * Cut every srcset candidate from one finished render.
 *
 * ONE BUFFER IN, N FILES OUT, and that is the point rather than an optimisation: a candidate
 * re-rendered instead of resampled would be a DIFFERENT ROOM, and the hero would change
 * furniture as the viewport crossed a breakpoint.
 *
 * @param {string} name - `<style>-<room>`, or `Original`.
 * @param {Buffer} buf - Finished pixels to cut from.
 * @returns {Promise<string>} A `32/49/69/94 KB` summary for the log line.
 */
async function writeCandidates(name, buf) {
  const sizes = [];
  for (const c of CANDIDATES) {
    let pipe = sharp(buf).resize(c.w, c.h, { fit: 'cover', kernel: sharp.kernel.lanczos3 });
    if (c.sharpen) pipe = pipe.sharpen({ sigma: c.sharpen });
    await pipe.webp({ quality: c.q }).toFile(candPath(name, c));
    sizes.push(Math.round(fs.statSync(candPath(name, c)).size / 1024));
  }
  return `${sizes.join('/')} KB`;
}

async function renderOne(style, room, srcBuffer, srcRegions) {
  const name = nameOf(style, room);
  let lastErr = null;
  let best = null;      // { buf, score } — the least-altered attempt so far
  let errors = 0;

  /* The file already on disk competes with this run, and wins ties.
   *
   * `--redo` used to delete the target first, which made it a gamble you could lose: a
   * luxury Bathroom that had reached 28.0 was re-rolled and replaced by a 41.3, and the
   * better image was simply gone. Scoring the incumbent and only overwriting when we
   * genuinely beat it makes re-rolling monotonic — run it as many times as you like and the
   * file can only improve. */
  let incumbent = null;
  if (fs.existsSync(webpPath(name))) {
    try {
      incumbent = scoreRegions(await regionPixels(webpPath(name)), srcRegions);
    } catch { /* unreadable: treat as no incumbent */ }
  }

  for (let attempt = 1; attempt <= GATE_ATTEMPTS + MAX_ATTEMPTS; attempt++) {
    if (best && attempt > GATE_ATTEMPTS) break;
    try {
      const buf = await renderOnce(style, room, srcBuffer);
      const score = scoreRegions(await regionPixels(buf), srcRegions);
      if (!best || score.total < best.score.total) best = { buf, score };
      if (score.worst <= 1) break;
      process.stdout.write(`  redo ${name.padEnd(26)} ${formatScore(score)}\n`);
    } catch (err) {
      lastErr = err;
      if (++errors >= MAX_ATTEMPTS) break;
      process.stdout.write(`  retry ${name.padEnd(25)} ${err.message}\n`);
    }
  }

  if (!best) {
    if (incumbent) {
      process.stdout.write(`  kept ${name.padEnd(26)} every attempt errored; existing file untouched\n`);
      return { name, ok: true, score: incumbent };
    }
    process.stdout.write(`  FAIL ${name.padEnd(26)} ${lastErr && lastErr.message}\n`);
    return { name, ok: false, error: lastErr && lastErr.message };
  }

  if (incumbent && incumbent.total <= best.score.total) {
    process.stdout.write(`  kept ${name.padEnd(26)} on disk is no worse — ${formatScore(incumbent)}\n`);
    return { name, ok: true, score: incumbent };
  }

  await sharp(best.buf).png().toFile(pngPath(name));
  const kbs = await writeCandidates(name, best.buf);
  const flag = best.score.worst <= 1 ? 'ok  ' : 'LOOK';
  process.stdout.write(`  ${flag} ${name.padEnd(26)} ${kbs.padEnd(22)} ${formatScore(best.score)}\n`);
  return { name, ok: true, score: best.score };
}

/* ----------------------------------------------------------------- the before shot */

/**
 * Re-cut the served `Original.webp` pair so the empty room matches the grid.
 *
 * The hero cross-fades between a staged render and this, and `See original` is the one
 * control that puts them side by side in time — a dimension mismatch reads as a jump mid-fade
 * rather than as a fade. So this is not a nice-to-have that can be skipped when the grid
 * changes size; it is the same invariant, and it runs from here so it cannot be forgotten.
 *
 * NOTE WHAT IS AND IS NOT UPSCALED. `Original.png` is a PHOTOGRAPH and the input this whole
 * script feeds the model — it stays at its own resolution and is never written by this
 * function, because upscaling the build input would mean every future render was made from a
 * softened source. Only the SERVED webp is resampled up to the grid's frame, which adds no
 * detail; it exists so the fade holds. That makes this folder the one place where the
 * png-master / webp-served pair are deliberately different sizes.
 *
 * @param {Buffer} srcBuffer - The Original.png master, already read.
 */
async function cutOriginal(srcBuffer) {
  const before = await sharp(srcBuffer).metadata();
  const kbs = await writeCandidates('Original', srcBuffer);
  console.log(
    `Original: master ${before.width}x${before.height} (untouched) -> ${CANDIDATES.length} candidates, ${kbs}\n`
  );
}

/* --------------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const only = flag('--only');
  const redo = flag('--redo');

  let jobs = [];
  for (const room of ROOMS) for (const style of STYLES) jobs.push({ style, room });

  if (only) jobs = jobs.filter((j) => j.room.slug === only || j.style === only);
  /* Deliberately does NOT delete the targets first. renderOne() scores whatever is already
     there and keeps it unless this run beats it, which is what makes a re-roll safe to
     repeat: the file can only get better. Deleting first is how a 28.0 got replaced by a
     41.3 and lost. */
  const forced = redo ? new Set(redo.split(',').map((s) => s.trim())) : null;
  if (forced) jobs = jobs.filter((j) => forced.has(nameOf(j.style, j.room)));

  if (argv.includes('--rebuild')) {
    // Deliberately NOT gated on `todo`: this path exists precisely for the run where every
    // render is already present and only the encoding has changed.
    const names = ['Original', ...jobs.map((j) => nameOf(j.style, j.room))];
    console.log(`rebuilding ${names.length} images x ${CANDIDATES.length} candidates from the PNG masters (no API calls)
`);
    let missing = 0;
    for (const n of names) {
      const master = n === 'Original' ? SRC_MASTER : pngPath(n);
      if (!fs.existsSync(master)) { console.log(`  MISS ${n.padEnd(26)} no PNG master`); missing++; continue; }
      const kbs = await writeCandidates(n, fs.readFileSync(master));
      console.log(`  ok   ${n.padEnd(26)} ${kbs}`);
    }
    console.log(`
srcset for index.html and hero-picker.js:
  ${srcsetFor('media-webp/example/<style>-<room>')}`);
    if (missing) process.exitCode = 1;
    return;
  }

  if (argv.includes('--list')) {
    for (const j of jobs) {
      const n = nameOf(j.style, j.room);
      console.log(`${fs.existsSync(webpPath(n)) ? 'have' : 'MISS'}  ${n}`);
    }
    return;
  }

  // A gap always renders; a --redo target renders even though it is present, and then has to
  // beat what is already there to replace it.
  const todo = jobs.filter((j) => forced || !fs.existsSync(webpPath(nameOf(j.style, j.room))));
  console.log(`grid ${ROOMS.length} rooms x ${STYLES.length} styles = ${ROOMS.length * STYLES.length}`);
  console.log(`${jobs.length - todo.length} already present, ${todo.length} to render, concurrency ${CONCURRENCY}\n`);
  const srcBuffer = fs.readFileSync(SRC_MASTER);
  // Above the early return on purpose: the before shot has to track the grid's frame even on
  // a run that renders nothing, which is exactly the run you make after changing OUT_W/OUT_H.
  await cutOriginal(srcBuffer);
  if (!todo.length) return;

  const srcRegions = await regionPixels(srcBuffer);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const j = todo[cursor++];
      results.push(await renderOne(j.style, j.room, srcBuffer, srcRegions));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const bad = results.filter((r) => !r.ok);
  const look = results.filter((r) => r.ok && r.score.worst > 1);
  console.log(`\ndone: ${results.length - bad.length} rendered, ${bad.length} failed`);
  if (look.length) {
    console.log(`${look.length} still outside a region gate after ${GATE_ATTEMPTS} attempts — LOOK AT THESE:`);
    for (const r of look.sort((a, b) => b.score.worst - a.score.worst)) {
      console.log(`  ${r.name.padEnd(26)} ${formatScore(r.score)}`);
    }
  }
  if (bad.length) {
    console.log('re-run to retry the failures, or --redo them individually:');
    for (const b of bad) console.log(`  ${b.name}: ${b.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
