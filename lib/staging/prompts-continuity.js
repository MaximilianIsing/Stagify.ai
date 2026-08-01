// Model-facing wording for DESIGN CONTINUITY across a multi-photo listing — the
// third conditioning mode and the judge that enforces it.
//
// Split out of prompts.js rather than added to it: that file is the single source of
// truth for staging/chat/QA wording and had reached the 650-line backend ratchet, and
// eslint.config.js is explicit that a module bumping the cap gets split into cohesive
// siblings instead of a raised limit. This is that sibling — everything here belongs to
// one feature (listing continuity), the same way room-constraints.js holds the per-room
// rules layer and unstageable.js holds the upload-gate taxonomy.
//
// Pure data + pure functions, no runtime dependencies. Two consumers:
//   * designBiblePromptSuffix  -> lib/staging/staging-generation.js (the generator)
//   * CONSISTENCY_REVIEW_PROMPT -> lib/image/image-review.js       (the judge)

// The design-continuity judge for multi-photo listing staging. Deliberately the
// MIRROR IMAGE of the two reviewers above in temperament: they are lenient because
// they gate on defects a viewer would notice at a glance, and over-rejecting there
// burns money on regenerating a fine image. This one gates on furniture IDENTITY
// across frames, which is exactly the failure a lenient reviewer waves through —
// a tan loveseat instead of a grey sectional is not a "defect", it is a beautiful
// photo of the wrong room. So it is strict about substitution and lenient about
// nothing except the one thing that legitimately varies: what is in frame.
//
// The out-of-frame carve-out is the single biggest false-positive risk. A support
// frame SHOULD omit pieces the camera cannot see, so "the rug is missing" is
// usually correct behaviour rather than drift, and a judge that scores it as a
// mismatch would send every support frame into a doomed retry loop.
export const CONSISTENCY_REVIEW_PROMPT =
  'You are a STRICT design-continuity reviewer for a set of real-estate photos of the ' +
  'SAME staged room shot from different camera positions. Image 1 is the reference view ' +
  '(the agreed staging). Image 2 is a new view of the SAME room that must contain the ' +
  'SAME physical furniture.\n' +
  'Your ONLY job is to judge whether the specific pieces listed below are THE SAME ' +
  'OBJECTS in image 2 as in image 1 — same design, colour, material, and proportions. ' +
  'A substituted, restyled, recoloured, or re-materialed piece is a FAILURE even if the ' +
  'photo is beautiful.\n' +
  'CRITICAL — what does NOT count as a mismatch, and you must NOT flag any of it:\n' +
  '- A piece that is simply OUT OF FRAME, behind the camera, cropped, or hidden behind ' +
  'other furniture in image 2. Image 2 is a different viewpoint, so it is EXPECTED to ' +
  'show only some of the pieces. Judge a piece ONLY if you can actually see it in image 2.\n' +
  '- A piece seen from a different SIDE, angle, rotation, or distance — that is required, ' +
  'not a defect.\n' +
  '- Different lighting falloff, shadow direction on the object, or perspective foreshortening.\n' +
  '- Small differences in soft furnishings that naturally move (cushion placement, throw ' +
  'folds, how a plant\'s leaves sit).\n' +
  'For EACH listed piece you can actually see in image 2, add a line exactly:\n' +
  '"SLOT: <slot-name> = match" or "SLOT: <slot-name> = mismatch"\n' +
  'Omit the line entirely for any piece not visible in image 2.\n' +
  'Then reply with "PERFECT: true" if every VISIBLE listed piece matches, or ' +
  '"PERFECT: false" if any visible listed piece is a different object.\n' +
  'If and only if it is NOT perfect, add a line "SCORE: <0-100>" rating how close the ' +
  'overall continuity is (higher = fewer/milder substitutions).';

// ── Design-bible conditioning (multi-photo listing staging) ─────────────────
//
// The THIRD mode of the extra-image channel, and the one the other two cannot
// express. The existing pair say:
//   * furnitureReferencePromptSuffix — "these are objects to place in the room"
//   * styleReferencePromptSuffix     — "match this look, do NOT copy its objects"
// A support frame of an already-staged room needs the exact opposite of that
// second one: it must reproduce THE SAME physical pieces, seen from somewhere
// else in the room. Conditioning a support frame with the style suffix actively
// instructs the model to change the furniture, which is the drift this whole
// feature exists to stop.
//
// The identity-yes / angle-no framing below is lifted from the battle
// maskReferencePromptSuffix already won: left to itself the model preserves the
// reference's camera viewpoint at the cost of a natural fit. Here that failure is
// worse than ugly — a support frame that keeps the hero's viewpoint is simply the
// hero frame again.
//
// This function re-partitions `bible.pieces` by `critical` rather than trusting their
// order, and that is load-bearing rather than belt-and-braces. This comment used to claim
// the normalizer already ordered them critical-first — it did not; nothing sorted. The
// unchecked claim is what let the piece cap in design-bible.js slice in the model's
// emission order and silently drop every critical piece from a room. The normalizer does
// partition now, so the STORED order matches what the reviewer scores, but this stays
// independent of it: a prompt that quietly demotes the sofa to "minor variation tolerable"
// produces no error and is expensive to discover from the output.
/**
 * Build the prompt suffix that pins a support frame to an already-extracted design
 * bible — the same room's locked furniture identities, palette, and lighting.
 *
 * Emits the structured bible block unconditionally; the reference-image framing is
 * added only when at least one image (the hero render) is attached, so a text-only
 * conditioning pass still works if the reference could not be loaded.
 *
 * @param {import('../types/projects.js').DesignBible | null | undefined} bible - The room's design bible (already normalized). Falsy or piece-less input yields ''.
 * @param {number} [refCount=0] - How many reference images follow the room photo; the FIRST of them is expected to be the hero render.
 * @returns {string} The design-bible prompt suffix (empty when there is no usable bible).
 */
export function designBiblePromptSuffix(bible, refCount = 0) {
  if (!bible || !Array.isArray(bible.pieces) || bible.pieces.length === 0) return '';

  const critical = bible.pieces.filter((p) => p && p.critical);
  const secondary = bible.pieces.filter((p) => p && !p.critical);

  const describe = (p) => `  - ${p.slot}: ${p.identity}${p.placement ? ` (position: ${p.placement})` : ''}`;

  const paletteLines = Object.entries(bible.palette || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `  - ${k}: ${v}`);
  const lightingLines = Object.entries(bible.lighting || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `  - ${k}: ${v}`);
  const negatives = (bible.negatives || []).filter(Boolean);

  let suffix = `

CRITICAL — THIS ROOM IS ALREADY STAGED; MATCH IT EXACTLY (DESIGN CONTINUITY):
This photo is ANOTHER VIEW of a room that has already been staged elsewhere in this
listing. You are not designing this room — it is already designed, and your only job
is to render the SAME staging as it would appear from THIS camera position. Every
piece named below is a specific physical object that already exists in this room.
Reproduce those objects; do not choose different ones, and do not restyle them.`;

  if (refCount >= 1) {
    suffix += `
The image immediately after the room photo is the ALREADY-STAGED version of this SAME
room, photographed from a DIFFERENT position. It is not a style board and not a
furniture cut-out: it is the ground truth for what this room now contains.`;
  }

  suffix += `

IDENTITY IS FIXED; CAMERA ANGLE IS NOT:
- Each piece's IDENTITY must stay faithful — its design, colour, material, texture, proportions, and distinctive details.
- Its ORIENTATION must NOT. You SHOULD and MUST freely rotate, turn, and re-angle every piece — even showing it from a completely different side — so it sits naturally in THIS frame's perspective, and rests correctly on this room's floor with correct contact shadows.
- Never preserve the reference's viewpoint at the cost of a natural fit. Keeping the reference camera angle is WRONG; this is a different view of the same room, not a copy of the same photograph.

THE PIECES IN THIS ROOM (reproduce faithfully):`;

  if (critical.length > 0) {
    suffix += `
MUST match exactly — substituting any of these is a visible failure:
${critical.map(describe).join('\n')}`;
  }
  if (secondary.length > 0) {
    suffix += `
Should match, minor variation tolerable:
${secondary.map(describe).join('\n')}`;
  }

  if (paletteLines.length > 0) {
    suffix += `

LOCKED PALETTE AND MATERIALS (do not substitute):
${paletteLines.join('\n')}`;
  }
  if (lightingLines.length > 0) {
    suffix += `

LIGHTING CONTINUITY — the same room at the same moment:
${lightingLines.join('\n')}`;
  }
  if (negatives.length > 0) {
    suffix += `

FORBIDDEN — none of the following may appear anywhere in this image:
${negatives.map((n) => `  - ${n}`).join('\n')}`;
  }

  suffix += `

PARTIAL VIEWS ARE CORRECT:
- Include ONLY the pieces that this camera position would actually see. A piece listed above that is out of frame, behind the camera, or occluded MUST be left out.
- Do NOT crowd every listed piece into this frame to satisfy the list, and do NOT invent extra furniture to fill the space. A view showing three of the pieces is right; a view showing all of them crammed together is wrong.
- Where a piece is only partly visible at the frame edge, render that part consistently with its description above.

Everything else in the room photo — architecture, walls, windows, doors, ceiling, floor, camera position, and framing — is governed by the rules already stated above and is unchanged by this section.`;

  return suffix;
}
