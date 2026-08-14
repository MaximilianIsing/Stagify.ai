// Step 3: run the brushed region through the product's real /api/mask-edit pipeline.
//
// Not processStaging. A whole-photo restage is precisely what this post's headline says
// did not happen, so calling it would make the post false however good the picture looked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStagifyImages } from '../../../lib/images/stagify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(HERE, 'source.json'), 'utf8'));

const stagify = createStagifyImages({ config });

// What a user would actually type, plus two clauses that took several rounds to learn.
//
// It OPENS WITH AN EXPLICIT REMOVAL because mask-edit.js appends "do NOT erase, delete, or
// strip out existing furniture, fixtures, windows, decor, or architectural features UNLESS
// THE INSTRUCTION EXPLICITLY ASKS YOU TO REMOVE THEM". An instruction that only says
// "replace this tile" loses to that clause, and the model keeps islands of the original
// material inside the brush, which on this post reads as the tool missing bits.
//
// It SAYS NOTHING ABOUT FINISH. An earlier wording asked for matte with no gloss and drew
// three QA verdicts at 85 complaining of a slight sheen: a disagreement with the prompt
// rather than a fault in the picture, since a glazed tile catching window light is right.
// Do not ask for a property the post does not need and the reviewer will then grade on.
//
// It FORBIDS A RIBBED SURFACE explicitly. Left to itself the model kept rendering the wall's
// specular gradient as texture, returning the left third and the right edge in a fine
// horizontal ribbed tile and the middle in the squares that were asked for. Five rolls across
// three different mask geometries all did it, so it is the prompt's silence rather than the
// mask or the seed.
//
// It says nothing about the bath, the tap or the light either. The mask already restricts
// the edit, so describing the rest of the room only invites drift.
// It NAMES A SATURATED COLOUR, and this is the correction that mattered. An earlier version
// asked for "sea glass green, a muted grey green" and got exactly what it asked for: the
// model delivered the muted grey and skipped the green. Measured on the delivered frames the
// wall moved from a* -0.6 to a* -1.8, which is still neutral, and deltaE fell to 0.40 across
// the lower wall. An independent reviewer called the post rejected on the ground that the two
// slides look like the same photograph twice, and it was right. On a post whose entire payload
// is "watch this wall change", tasteful restraint in the prompt is the failure mode, not
// safety. It also forbids the fade: the previous run coloured the top of the wall and trailed
// off to nothing by the bath rim.
const PROMPT = 'Remove the existing pale ceramic wall tile and replace every part of it with '
  + 'deep emerald green glazed ceramic tile. Large plain square tiles with a smooth flat '
  + 'surface, thin pale grout lines, the same tile grid and the same perspective as now.';

const result = await stagify.maskEdit({
  sourceBuffer: fs.readFileSync(source.path),
  maskBuffer: fs.readFileSync(path.join(HERE, 'mask.png')),
  compositeMaskBuffer: fs.readFileSync(path.join(HERE, 'mask-composite.png')),
  prompt: PROMPT,
  // Shifted off round one's seed on purpose: an identical seed re-courts the output the
  // reviewer already turned down three times.
  seed: 771903,
  modelOverride: process.env.MASK_MODEL || null,
});

const outPath = path.join(HERE, 'edited.png');
fs.writeFileSync(outPath, result.buffer);
// The before frame, straight from the pipeline rather than resized to match by hand.
fs.writeFileSync(path.join(HERE, 'before-full.png'), result.normalisedSource);
fs.writeFileSync(path.join(HERE, 'raw-model-output.png'), result.rawModelOutput);
await sharp(result.buffer).resize(700).jpeg({ quality: 88 })
  .toFile(path.join(HERE, 'preview-edited.jpg'));

fs.writeFileSync(path.join(HERE, 'edit.json'), JSON.stringify({
  prompt: PROMPT,
  model: result.model,
  params: result.params,
  quality: result.quality,
  outsideMaskIdentical: result.outsideMaskIdentical,
  outPath,
}, null, 2));

// Measure whether the edit is actually VISIBLE, band by band down the wall.
//
// This check exists because its absence nearly shipped a broken post. The identity check
// inside maskEdit proves the negative claim, that nothing outside the brush moved, and a
// naive pixel diff said 98% of the brushed area "differed" and was read as the change having
// landed. But a one-value shift counts as differing, and the QA reviewer scored the render
// 100 for following the instruction. Every signal was green while the wall was not: the
// colour had moved by deltaE 0.4, which no human eye can see.
//
// So: measure perceptual distance in CIELAB, in horizontal bands, because the failure mode
// is not only "too weak" but "strong at the top and faded out by the bottom". Under about 2
// is invisible; a change this post can carry wants double figures.
function toLab(r, g, b) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s > 0.04045 ? ((s + 0.055) / 1.055) ** 2.4 : s / 12.92;
  });
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const { width: MW, height: MH } = await sharp(result.buffer).metadata();
const rawOf = (buf) => sharp(buf).removeAlpha().raw().toBuffer();
const [beforeRaw, afterRaw, maskRaw] = await Promise.all([
  rawOf(result.normalisedSource),
  rawOf(result.buffer),
  sharp(path.join(HERE, 'mask-composite.png')).resize(MW, MH, { fit: 'fill' }).extractChannel(0).raw().toBuffer(),
]);

// Measured over the DELIVERED CROP, not the whole frame. crop.js keeps rows 210 to 803, so
// anything above or below never reaches the post, and grading it there produces false
// alarms: a first version failed the whole run on a band of floor below the crop line that
// no viewer will ever see. A quality gate that cries wolf gets ignored, which defeats it.
const CROP_TOP = 210;
const CROP_BOTTOM = 803;

console.log('\nvisibility of the change, brushed pixels inside the delivered crop:');
const BANDS = 5;
let worst = Infinity;
for (let band = 0; band < BANDS; band += 1) {
  const y0 = CROP_TOP + Math.round((band * (CROP_BOTTOM - CROP_TOP)) / BANDS);
  const y1 = CROP_TOP + Math.round(((band + 1) * (CROP_BOTTOM - CROP_TOP)) / BANDS);
  let sa = [0, 0, 0]; let sb = [0, 0, 0]; let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < MW; x += 1) {
      const i = y * MW + x;
      if (maskRaw[i] < 200) continue;
      const p = i * 3;
      sa[0] += beforeRaw[p]; sa[1] += beforeRaw[p + 1]; sa[2] += beforeRaw[p + 2];
      sb[0] += afterRaw[p]; sb[1] += afterRaw[p + 1]; sb[2] += afterRaw[p + 2];
      n += 1;
    }
  }
  if (n < 500) { console.log(`  rows ${y0}-${y1}: barely brushed, skipped`); continue; }
  const A = toLab(sa[0] / n, sa[1] / n, sa[2] / n);
  const B = toLab(sb[0] / n, sb[1] / n, sb[2] / n);
  const dE = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
  worst = Math.min(worst, dE);
  console.log(`  rows ${String(y0).padStart(4)}-${String(y1).padStart(4)}  a* ${A[1].toFixed(1).padStart(5)} -> ${B[1].toFixed(1).padStart(5)}   deltaE ${dE.toFixed(1).padStart(5)}`);
}
console.log(`  weakest band deltaE ${worst.toFixed(1)} ${worst < 5 ? '  <-- TOO SUBTLE TO SHIP' : ''}\n`);

console.log(`model              ${result.model}`);
console.log(`attempts           ${result.quality.attempts}`);
console.log(`perfect            ${result.quality.perfect}`);
console.log(`bestScore          ${result.quality.bestScore}`);
console.log(`defects            ${result.quality.defects.length ? result.quality.defects.join(' | ') : 'none'}`);
console.log(`outsideMaskSame    ${result.outsideMaskIdentical}`);
console.log(`wrote              ${outPath}`);
