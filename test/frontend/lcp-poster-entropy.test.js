// The homepage's background-video poster is 528 bytes away from stealing the LCP metric.
//
// #background-video is `position: fixed`, full-viewport, and on desktop it paints
// `media-webp/background-poster.webp` before anything else on the page. By area it is
// roughly twice the hero photo, so on area alone it would win the Largest Contentful Paint
// outright. It does not win, and the reason is the one thing about it nobody would think to
// preserve: Chrome EXCLUDES low-entropy images from LCP candidacy, at a threshold of
// 0.05 bits per pixel. The poster sits at 0.04796 bpp. It is under the bar by 528 bytes.
//
// WHY THAT MATTERS MORE THAN IT SOUNDS. Nothing breaks if it crosses. The page looks
// identical, every test still passes, and the site is not slower by a single millisecond.
// What changes is WHICH ELEMENT THE METRIC MEASURES: LCP silently stops reporting the hero
// photo — the element the preload, the fetchpriority, the static markup, the srcset ladder
// and the `is-on` class all exist to accelerate — and starts reporting a decorative
// backdrop instead. Every before/after number taken across that boundary is incomparable,
// and the natural conclusion from the jump is that a change made the page slower.
//
// It is a plausible edit, too: re-exporting the poster at a nicer quality, swapping in a
// new backdrop, or running the PNG master through a different encoder all land in the same
// place. So this test does not guard a performance property. It guards the MEANING of the
// measurement.
//
// IF THIS FAILS, the fix is not to raise the threshold. Either re-encode the poster back
// under the limit (it is a blurred, heavily-compressed backdrop at opacity .8 behind
// z-index -1 — there is no visual budget being defended here), or accept the change
// deliberately and rewrite this test to say the poster is now the LCP element, so the next
// person reading a PSI report knows what they are looking at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/* Chrome's low-entropy exclusion for LCP candidacy, in bits per pixel. Not a tuneable:
   it is a constant in Blink (LargestContentfulPaintCalculator), so the only honest way to
   satisfy this test is to stay under it. */
const LCP_ENTROPY_LIMIT_BPP = 0.05;

test('the background-video poster stays under the LCP low-entropy threshold', async () => {
  // Read the filename out of the markup rather than hard-coding it, so swapping the poster
  // for a different file cannot route around this test.
  const video = indexHtml.match(/<video[^>]*id="background-video"[^>]*>/);
  assert.ok(
    video,
    'index.html no longer has a #background-video element. If the backdrop was removed, ' +
      'delete this test with it — but check first that nothing else full-viewport took its ' +
      'place, because the LCP-candidacy question moves to whatever did.'
  );

  const poster = video[0].match(/poster="([^"]+)"/);
  assert.ok(
    poster,
    '#background-video lost its `poster` attribute. That poster is what desktop paints for ' +
      'the backdrop now that the video no longer autoplays — without it the fixed layer is ' +
      'blank until the deferred start script runs.'
  );

  const file = path.join(root, 'public', poster[1]);
  assert.ok(fs.existsSync(file), `#background-video's poster does not exist on disk: ${poster[1]}`);

  const bytes = fs.statSync(file).size;
  const { width, height } = await sharp(file).metadata();
  assert.ok(width && height, `could not read the dimensions of ${poster[1]}`);

  const bpp = (bytes * 8) / (width * height);
  const ceiling = Math.floor((LCP_ENTROPY_LIMIT_BPP * width * height) / 8);

  assert.ok(
    bpp < LCP_ENTROPY_LIMIT_BPP,
    `${poster[1]} is ${bytes} B at ${width}x${height} = ${bpp.toFixed(5)} bits/px, at or ` +
      `above Chrome's ${LCP_ENTROPY_LIMIT_BPP} bits/px low-entropy cutoff (the ceiling at ` +
      `these dimensions is ${ceiling} B). This full-viewport fixed backdrop is now an LCP ` +
      `candidate and, being roughly twice the hero photo's area, it will WIN — so LCP has ` +
      `silently stopped measuring the hero image that the preload, fetchpriority, static ` +
      `markup and srcset ladder all exist to accelerate. Re-encode it smaller, or accept ` +
      `the change on purpose and rewrite this test to document it.`
  );
});
