// The doorway gate: the one failure mode in this pool with a working numeric screen.
//
// The open recess in the left wall is what the model destroys, and it does so in TWO
// directions — it walls the recess over with flat wall plus pale artwork (that box gets
// BRIGHTER), or it hangs a dark canvas, mirror or bookcase across it (DARKER). A mean-
// luminance threshold, which is what this check used to be, only catches the first: when the
// six worst renders in the shipped pool were re-measured, four scored BELOW the pool median.
//
// So compare against the source. Mean absolute difference over the recess ranked all six in
// the top seven of sixty.
//
// Usage: node tools/arch-check.mjs <source> <render...>
import path from 'node:path';
import sharp from 'sharp';

/** The recess plus its frame, in 1216x832 coords. */
export const BOX = { left: 205, top: 200, width: 100, height: 380 };

/** Renders at or below this are clean. Live-pool median is ~16. */
export const GATE = 26;

/** Above this, look at the image — it is not automatically wrong. */
export const LOOK = 40;

export async function boxPixels(input) {
  const { data } = await sharp(input)
    .resize(1216, 832, { fit: 'cover' })
    .extract(BOX)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/** Mean absolute difference from the source over the doorway box. */
export function doorwayMad(pixels, sourcePixels) {
  let mad = 0;
  for (let i = 0; i < pixels.length; i++) mad += Math.abs(pixels[i] - sourcePixels[i]);
  return mad / pixels.length;
}

if (process.argv[1] && process.argv[1].endsWith('arch-check.mjs')) {
  const [src, ...files] = process.argv.slice(2);
  if (!src || !files.length) {
    console.log('usage: node tools/arch-check.mjs <source> <render...>');
    process.exit(1);
  }
  const srcPixels = await boxPixels(src);
  const rows = [];
  for (const f of files) rows.push({ f: path.basename(f), mad: doorwayMad(await boxPixels(f), srcPixels) });
  for (const r of rows.sort((a, b) => b.mad - a.mad)) {
    const verdict = r.mad > LOOK ? '<< LOOK' : r.mad > GATE ? '<< over gate' : '';
    console.log(`${r.f.padEnd(13)} mad ${r.mad.toFixed(1).padStart(6)}  ${verdict}`);
  }
  const over = rows.filter((r) => r.mad > GATE).length;
  console.log(`\n${rows.length} render(s); ${over} over the gate of ${GATE}`);
}
