// Build step for the homepage Instagram cover images. Run after adding or replacing one:
//
//   node scripts/build-instagram-covers.js
//
// The homepage's #instagram section used to embed three <iframe>s pointing at
// instagram.com/p/<shortcode>/embed/. Each of those is a ~607 KB third-party HTML
// document plus Instagram's own JS, CSS, fonts and images — and home.css then threw most
// of it away, clipping Instagram's header off the top with a negative margin and cropping
// the footer with a fixed wrapper height. The section now ships the post art itself as a
// local WebP that links to the post, so the page loads no Meta code at all.
//
// SOURCE IS THE PNG MASTER in to-build/media-png/instagram/. Those masters are copies of
// Instagram's own CDN JPEGs (see that folder's README for the refetch command), so they
// are NOT lossless origins — this is the "WebP-derived copies" exception in
// to-build/README.md. Do not sharpen or upscale expecting detail to come back.
//
// NEW FILENAMES, so no cache-busting is needed: media-webp/ is served
// `public, max-age=31536000, immutable` (lib/http/app-middleware.js), and per
// docs/reference/caching.md an asset must never be edited in place under the same name.
// Replacing a cover therefore DOES need a rename or a ?v= — same rule as every other
// image here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(ROOT, 'to-build', 'media-png', 'instagram');
const OUT = path.join(ROOT, 'public', 'media-webp', 'instagram');

/** `.ig-card` paints at most 330 px wide (home.css); 660 is 2× for a retina display. */
const WIDTH = 660;

/**
 * Instagram portrait posts are 4:5, and the cards show them UNCROPPED because two of the
 * three have artwork flush to an edge — a blue title bar against the top, a caption pill
 * against the bottom. Resizing by width alone preserves whatever ratio the master has, so
 * a master that is not 4:5 would silently render a card of the wrong height and break the
 * grid rhythm rather than crop. Assert the ratio instead of trusting it.
 */
const RATIO = 4 / 5;
const RATIO_TOLERANCE = 0.005;

async function main() {
  if (!fs.existsSync(MASTERS)) {
    console.error(`No masters directory at ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  const masters = fs.readdirSync(MASTERS).filter((f) => f.endsWith('.png')).sort();

  if (!masters.length) {
    console.error(`No .png masters found in ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });

  let total = 0;
  for (const file of masters) {
    const src = path.join(MASTERS, file);
    const { width, height } = await sharp(src).metadata();
    const ratio = (width ?? 0) / (height ?? 1);
    if (Math.abs(ratio - RATIO) > RATIO_TOLERANCE) {
      console.error(
        `  ${file}: expected a 4:5 master, got ${width}×${height} (${ratio.toFixed(3)}). ` +
          'Re-export it at 4:5 rather than letting the card render at the wrong height.'
      );
      process.exitCode = 1;
      return;
    }

    const out = path.join(OUT, file.replace(/\.png$/, '.webp'));
    await sharp(src)
      .resize({ width: WIDTH })
      // quality 78 matches the blog thumbnails: at 330 CSS px the step down from the
      // hero encode is invisible and it roughly halves the bytes.
      .webp({ quality: 78 })
      .toFile(out);
    const size = fs.statSync(out).size;
    total += size;
    console.log(`  ${path.basename(out).padEnd(26)} ${(size / 1024).toFixed(1).padStart(7)} KB`);
  }

  console.log(`\n${masters.length} covers, ${(total / 1024).toFixed(1)} KB total`);
  console.log('the three iframes they replaced: ~1825 KB of third-party HTML alone');
}

await main();
