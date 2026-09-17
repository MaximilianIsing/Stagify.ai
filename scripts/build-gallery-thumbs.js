// Build step for the homepage gallery mock's card images. Run after adding or
// replacing one:
//
//   node scripts/build-gallery-thumbs.js
//
// The seven room shots in the showcase's "Gallery" panel ship at 1200 px wide —
// 644 KB across the set — and are painted into a two-column grid inside the panel's
// ~498 px media column, i.e. roughly **239 CSS px each**. Every desktop visitor who
// reaches that panel was decoding images at five times the size they are drawn at.
//
// This emits a 480 px variant beside each one (2× for a 239 px card, so it stays
// sharp on a retina display) and the markup offers both through `srcset`:
//
//   srcset="room-x-480.webp 480w, room-x.webp 1200w"
//   sizes="(max-width: 768px) 92vw, 240px"
//
// WHY BOTH, and why the 1200 px file is left completely alone. Below 768 px the grid
// collapses to one column and `.hgal-card:nth-child(n+2) { display: none }` hides the
// other six (styles/home.css), so a phone shows a SINGLE card at ~325 CSS px — which
// at a 3× device pixel ratio wants ~975 px of source. A flat downscale to 480 would
// have been the one case where quality visibly dropped, on the connection least able
// to afford a re-download. Offering both widths means desktop takes the 480 (about
// 150 KB for all seven) and a high-DPR phone keeps exactly what it gets today.
//
// The 1200 px encodes are ALSO not re-encoded for consistency, tempting as it looks
// (room-dining is 141 KB against room-bedroom's 35 KB at the same dimensions):
// to-build/README.md records this set as WebP-derived — the PNG beside it is a
// pixel-identical copy of model output, not a lossless origin — so re-encoding the
// full-size file would be a second lossy generation for no desktop benefit. A
// DOWNSCALE is different: resampling to 40% hides generation loss rather than
// compounding it, which is why the 480 variant can come off the PNG safely.
//
// NEW FILENAMES, so no cache-busting is needed: media-webp/ is served
// `public, max-age=31536000, immutable` (lib/http/app-middleware.js), and per
// docs/reference/caching.md an asset must never be edited in place under the same
// name. Regenerating a variant after changing a room shot therefore DOES need a
// rename or a ?v= — same rule as every other image here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(ROOT, 'to-build', 'media-png', 'Homepage', 'Gallery');
const OUT = path.join(ROOT, 'public', 'media-webp', 'Homepage', 'Gallery');

/** Cards render ~239 CSS px wide on desktop; 480 is 2× for a retina display. */
const WIDTH = 480;

/** Matches room-bedroom.png … room-sunroom.png. */
const ROOM = /^room-[a-z]+\.png$/;

async function main() {
  if (!fs.existsSync(MASTERS)) {
    console.error(`No masters directory at ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  const masters = fs.readdirSync(MASTERS).filter((f) => ROOM.test(f)).sort();
  if (!masters.length) {
    console.error(`No room-*.png masters found in ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  let total = 0;
  for (const file of masters) {
    const out = path.join(OUT, file.replace(/\.png$/, '-480.webp'));
    // Height is derived from the master's own ratio (these are 800 or 798 or 819 tall),
    // so the variant and the 1200 px file describe the same box and `srcset` can swap
    // one for the other without moving the layout.
    await sharp(path.join(MASTERS, file))
      .resize({ width: WIDTH })
      // Same quality as the other thumbnail build steps in this folder; at 239 CSS px
      // the step down from the full-size encode is invisible.
      .webp({ quality: 78 })
      .toFile(out);
    const size = fs.statSync(out).size;
    total += size;
    console.log(`  ${path.basename(out).padEnd(24)} ${(size / 1024).toFixed(1).padStart(7)} KB`);
  }

  // What the same seven cost at full size, for the record.
  const fullBytes = masters.reduce((sum, f) => {
    const full = path.join(OUT, f.replace(/\.png$/, '.webp'));
    return sum + (fs.existsSync(full) ? fs.statSync(full).size : 0);
  }, 0);

  console.log(`\n${masters.length} variants, ${(total / 1024).toFixed(1)} KB total`);
  console.log(`the same rooms at 1200 px: ${(fullBytes / 1024).toFixed(1)} KB`);
  console.log(`saved on a desktop visit: ${((fullBytes - total) / 1024).toFixed(1)} KB`);
}

await main();
