// Step 5: put the two cropped frames into the content-addressed store the renderer serves
// from, and read the dominant colours off the finished "after" so post.json records what
// the post actually looks like rather than what the brief hoped it would.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStagifyImages } from '../../../lib/images/stagify.js';
import { createAcquire } from '../../../lib/images/acquire.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));

const acquire = createAcquire({
  config, repoRoot: REPO_ROOT,
  stagify: createStagifyImages({ config }), stock: null, fal: null,
});

const out = {};
for (const role of ['before', 'after']) {
  const buffer = fs.readFileSync(path.join(HERE, `${role}-crop.png`));
  out[role] = await acquire.store(buffer, 'image/png');
  console.log(`${role.padEnd(7)} ${out[role].url}`);
}

// Three representative colours, taken by shrinking the frame to a handful of pixels so the
// result is the picture's actual weight rather than a guess at its mood.
const { data } = await sharp(path.join(HERE, 'after-crop.png'))
  .resize(3, 4, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const swatches = [];
for (let i = 0; i < data.length; i += 3) {
  swatches.push(`#${[data[i], data[i + 1], data[i + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
}
out.swatches = swatches;
console.log('swatches', swatches.join(' '));

fs.writeFileSync(path.join(HERE, 'images.json'), JSON.stringify(out, null, 2));
