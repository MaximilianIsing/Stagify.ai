// The QA reviewers' rubrics and the single reply-format contract they share.
//
// Split out of prompts.js when that file hit its 650-line ceiling — the same reason
// designer-rules.js, room-constraints.js and preservation-rules.js exist. These three belong
// together anyway: two rubrics plus the one place that says what a verdict must look like.
//
// ARCHITECTURE_REVIEW_CLAUSE is deliberately NOT here. It lives in ./preservation-rules.js
// next to INTERIOR_PRESERVATION_RULES, because what the prompt forbids and what the reviewer
// checks have to say the same thing, and keeping them in one file is what makes that likely.

export const QUALITY_REVIEW_PROMPT =
  'You are a LENIENT QA reviewer for AI-generated interior real-estate photos. ' +
  'Your ONLY job is to catch GLARING, obvious defects — the kind anyone would notice ' +
  'at a glance and that make the photo look broken or fake: badly warped or melted ' +
  'furniture, clearly impossible geometry, grossly distorted perspective, obviously ' +
  'extra or missing legs, duplicated or garbled objects, unreadable garbled text, ' +
  'heavily smeared textures, or blatantly impossible lighting. ' +
  'Be lenient with everything else: minor imperfections, subtle oddities, small style ' +
  'quirks, soft details, or anything only noticeable on close inspection are FINE and ' +
  'must PASS. Do NOT nitpick. When in doubt, ACCEPT.';

// The reply contract for BOTH quality reviewers, in ONE place, appended LAST by the caller.
//
// It used to be scattered: QUALITY_REVIEW_PROMPT specified lines 1 and 2, then ~1,200
// characters of instruction, image guide and the architecture clause intervened, and the
// remaining two lines were specified by the clause and by REVIEW_WHY_SUFFIX. A model asked to
// hold a four-line format across that much interleaved content drops parts of it — and a
// dropped ARCHITECTURE line used to be indistinguishable from "the room is fine" (see
// reviewImageQuality's tri-state parse, which is the other half of that fix).
//
// Every line is parsed by a line-agnostic regex, so the ORDER here is for the model's benefit,
// not the parser's. `architecture` is opt-in because only the staging path attaches a source
// image to compare against.
/**
 * Build the reviewer's reply-format block.
 * @param {{ architecture?: boolean, why?: boolean }} [opts] - `architecture` includes the ARCHITECTURE line (only valid when a source image was attached); `why` includes the WHY line (the staging path feeds it back into the next attempt, so it is always on there; the mask path only logs it, so it is DEBUG-gated).
 * @returns {string} The format block, to be appended last.
 */
export function reviewReplyFormat({ architecture = false, why = true } = {}) {
  const lines = [
    '- "PERFECT: true" or "PERFECT: false" — true only if there is no glaring, obvious defect.',
  ];
  if (architecture) {
    lines.push('- "ARCHITECTURE: same" or "ARCHITECTURE: changed" — the architecture check above. ALWAYS include this line, even when everything else is perfect.');
  }
  lines.push('- "SCORE: <0-100>" — include ONLY if PERFECT is false. How close it is despite the issue(s); higher = fewer/milder.');
  if (why) {
    lines.push('- "WHY: <one concise sentence naming the specific problem(s) you see>" — include ONLY if PERFECT is false' +
      (architecture ? ' or ARCHITECTURE is changed, and name what changed.' : '.'));
  }
  return '\n\nREPLY FORMAT — output these lines and nothing else, each on its own line, in this order:\n' +
    lines.join('\n');
}

// ARCHITECTURE_REVIEW_CLAUSE — the reviewer-facing half of the same rule — lives in
// ./preservation-rules.js beside the block it verifies, and is re-exported above. What the
// prompt forbids and what the reviewer checks have to say the same thing, so they are
// edited together.

export const MASK_REVIEW_PROMPT =
  'You are a LENIENT QA reviewer for a LOCALIZED edit to an interior real-estate photo. ' +
  'Only flag GLARING, obvious problems; accept anything with merely minor or subtle ' +
  'issues. Mark it NOT perfect ONLY if the edited image has a clearly visible, serious ' +
  'defect: badly warped or melted furniture, obviously impossible geometry, grossly ' +
  'distorted perspective, clearly extra/missing legs, duplicated or garbled objects, ' +
  'heavily smeared textures, or blatantly impossible lighting. ' +
  'Also mark it NOT perfect if a newly added object is OBVIOUSLY cut off, sliced, or ' +
  'abruptly faded mid-room (clearly only part of it rendered) — but ignore minor edge ' +
  'softness, and ignore furniture that is only partially in view because it runs off ' +
  'the actual photo border. ' +
  'Also mark it NOT perfect if the edit CLEARLY removed too much — e.g. it obviously ' +
  'deleted furniture, fixtures, windows, or decor that should still be there, or left a ' +
  'big blank wall, empty floor, or obvious void where content used to be. ' +
  'Be lenient with everything else: small imperfections, subtle blending, slightly-off ' +
  'details, or anything a normal viewer would not notice at a glance are FINE and must ' +
  'PASS. Do NOT nitpick. When in doubt, ACCEPT.';
