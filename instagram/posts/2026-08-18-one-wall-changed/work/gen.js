// Generate a few candidate rooms and let a human eye pick. Stock could not supply this
// brief: thirty photographs across ten queries, and the relevance screen turned down every
// one, because a real bathroom almost always has a mirror, a vanity or a glass screen
// crossing its main tiled wall. That is a true fact about bathrooms rather than a bad
// search, so this is the fallback working as designed.
//
// The first generated attempt produced a good wall and an unusable toilet: a bin shaped box
// with no cistern and a flush plate whose icons were smeared. So the prompts below ask for
// no toilet at all. Excluding the object the model is worst at is cheaper than retouching
// it, and nothing in the post needs one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createFalClient } from '../../../lib/images/fal.js';
import { createStagifyImages } from '../../../lib/images/stagify.js';
import { sha256 } from '../../../lib/images/acquire.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));

const fal = createFalClient();
const stagify = createStagifyImages({ config });

const COMMON = 'Photorealistic interior photograph of a finished, furnished bathroom, shot in '
  + 'portrait orientation from across the room, wide enough to read as a whole room. '
  + 'One large flat wall of plain square ceramic tile facing the camera, filling much of the '
  + 'frame, clear of mirrors and cabinets. Soft even daylight, no people, no toilet.';

const VARIANTS = [
  `${COMMON} A white freestanding bath sits low against the tiled wall, with a chrome floor `
    + 'standing tap beside it and a folded towel on a rail. A window to one side.',
  `${COMMON} A long stone washbasin on a timber counter stands against the side wall to the `
    + 'right, with a chrome tap, a small potted plant and a tall window behind it.',
  `${COMMON} A walk in shower area at the left with a chrome shower head mounted on the tiled `
    + 'wall, and a timber bench with folded towels against the right hand wall.',
];

const out = [];
for (const [i, prompt] of VARIANTS.entries()) {
  const n = String(i + 1).padStart(2, '0');
  try {
    const g = await fal.generate(config.models.fal, {
      prompt, image_size: 'portrait_4_3', num_images: 1,
    });
    const file = path.join(HERE, `gen-${n}.jpg`);
    fs.writeFileSync(file, g.buffer);
    await sharp(g.buffer).resize(650).jpeg({ quality: 90 }).toFile(path.join(HERE, `preview-gen-${n}.jpg`));

    // Run the product's own upload gate over it. If Stagify would refuse this from a
    // customer it has no business in an advertisement for Stagify.
    const gate = await stagify.validateSource(g.buffer).catch(() => null);
    const meta = await sharp(g.buffer).metadata();
    out.push({ n, file, hash: sha256(g.buffer), prompt, model: g.model });
    console.log(`gen-${n}  ${meta.width}x${meta.height}  gate=${gate ? (gate.stageable === false ? 'REJECTED ' + (gate.category ?? '') : 'ok') : 'not checked'}`);
  } catch (error) {
    console.log(`gen-${n}  failed: ${error.message}`);
  }
}

fs.writeFileSync(path.join(HERE, 'generated.json'), JSON.stringify(out, null, 2));
