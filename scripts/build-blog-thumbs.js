// Build step for the blog card thumbnails. Run after adding or replacing a cover:
//
//   node scripts/build-blog-thumbs.js
//
// Each article's cover art is used at two very different sizes:
//
//   * the ARTICLE HERO, full width — the existing public/media-webp/blog/cover-N.webp
//     at 1600×900, which is the right resolution for that job and is left alone.
//   * the CARD THUMBNAIL, in the /blog/ grid and the homepage's "from the blog" strip —
//     rendered into a card roughly 320–440 px wide (`.blog-card__thumb`, styles/blog.css;
//     `.home-blog__thumb`, styles/home.css, which even declares width="400" height="225").
//
// Both were being served the same 1600×900 file: ~1.7 MB of cover art across the ten
// articles, decoded at four times the size it is painted at. This emits a 800×450
// `-thumb.webp` beside each cover — 2× for a 400 px card, so it stays sharp on a retina
// display — and the card markup points at that instead.
//
// SOURCE IS THE PNG MASTER, not the shipped WebP. to-build/media-png/blog/cover-N.png is
// the authoring master (see to-build/README.md); re-encoding the already-lossy WebP would
// compound its artefacts at the exact scale where they are most visible. A cover with no
// master is reported and skipped rather than silently downscaled from the WebP.
//
// NEW FILENAMES, so no cache-busting is needed: media-webp/ is served
// `public, max-age=31536000, immutable` (lib/http/app-middleware.js), and per
// docs/reference/caching.md an asset must never be edited in place under the same name.
// Regenerating a thumb after changing a cover therefore DOES need a rename or a ?v= —
// same rule as every other image here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(ROOT, 'to-build', 'media-png', 'blog');
const OUT = path.join(ROOT, 'public', 'media-webp', 'blog');

/** Card thumbnails render ~320–440 px wide; 800 is 2× for the largest of those. */
const WIDTH = 800;
const HEIGHT = 450;

/** Matches cover-1.png … cover-10.png, but not exterior-before.png or the -og sources. */
const COVER = /^cover-(\d+)\.png$/;

async function main() {
  if (!fs.existsSync(MASTERS)) {
    console.error(`No masters directory at ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  /** The N in cover-N.png. Only called for names COVER already matched. */
  const coverNumber = (name) => Number((COVER.exec(name) || [])[1] ?? 0);

  const masters = fs.readdirSync(MASTERS).filter((f) => COVER.test(f))
    .sort((a, b) => coverNumber(a) - coverNumber(b));

  if (!masters.length) {
    console.error(`No cover-N.png masters found in ${MASTERS}`);
    process.exitCode = 1;
    return;
  }

  let total = 0;
  for (const file of masters) {
    const out = path.join(OUT, file.replace(/\.png$/, '-thumb.webp'));
    await sharp(path.join(MASTERS, file))
      .resize(WIDTH, HEIGHT, { fit: 'cover' })
      // quality 78 is a deliberate step down from the hero encode: at 400 CSS px the
      // difference is invisible, and it roughly halves the bytes again.
      .webp({ quality: 78 })
      .toFile(out);
    const size = fs.statSync(out).size;
    total += size;
    console.log(`  ${path.basename(out).padEnd(22)} ${(size / 1024).toFixed(1).padStart(7)} KB`);
  }

  // What the same ten images cost at full size, for the record.
  const heroBytes = masters.reduce((sum, f) => {
    const hero = path.join(OUT, f.replace(/\.png$/, '.webp'));
    return sum + (fs.existsSync(hero) ? fs.statSync(hero).size : 0);
  }, 0);

  console.log(`\n${masters.length} thumbnails, ${(total / 1024).toFixed(1)} KB total`);
  console.log(`the same covers at 1600×900: ${(heroBytes / 1024).toFixed(1)} KB`);
  console.log(`saved on every card grid: ${((heroBytes - total) / 1024).toFixed(1)} KB`);
}

await main();
