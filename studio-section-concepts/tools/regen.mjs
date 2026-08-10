// Throwaway: regenerate specific pool indices that failed the architecture check.
// Rebuilds each directive from the manifest (so the variation axes are unchanged) and
// adds a hardened doorway clause, because the drift is always the same failure: the
// open recess on the left wall gets painted over as flat wall + artwork.
//
// Usage (from the repo root): node studio-section-concepts/tools/regen.mjs 17,35,52,53,59
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createStagingGeneration } from '../../lib/staging/staging-generation.js';
import { generateWithQualityRetry } from '../../lib/staging/staging-pipeline.js';
import { createImageReview } from '../../lib/image/image-review.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO, 'studio-section-concepts/assets/before/1-living-oak.jpg');
const OUT = path.join(REPO, 'studio-section-concepts/assets/pool');
const MANIFEST = path.join(OUT, 'manifest.json');

// The one layout that reliably produced a sofa-back wall filling the frame over a
// sparse room. Anything regenerated gets a replacement instead.
const BAD_LAYOUT = 'a sofa facing the window with its back to the camera, and a low media unit on the back wall';
const REPLACEMENT_LAYOUT = 'a sofa along the back wall with two accent chairs angled toward it and a clear walkway on the left';

const HARD_ARCHITECTURE =
  ' ABSOLUTELY CRITICAL — DO NOT ALTER THE ROOM ITSELF: there is an open doorway recess in ' +
  'the left-hand wall. It MUST remain an open, visible, unobstructed opening. Do NOT wall it ' +
  'over, do NOT fill it with a flat wall, and do NOT hang artwork, shelving or a mirror across ' +
  'it. Likewise keep the window on the right, the ceiling, the crown molding, the recessed ' +
  'ceiling lights, the baseboards and the oak floor exactly as they appear in the source photo. ' +
  'Add furniture only. Change nothing structural.';

function readKey() {
  if (process.env.GOOGLE_AI_API_KEY) return process.env.GOOGLE_AI_API_KEY.trim();
  const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i !== -1 && line.slice(0, i).trim() === 'GOOGLE_AI_API_KEY') return line.slice(i + 1).trim();
  }
  return fs.readFileSync(path.join(REPO, 'key.txt'), 'utf8').trim();
}

function directive(v) {
  const layout = v.layout === BAD_LAYOUT ? REPLACEMENT_LAYOUT : v.layout;
  return [
    `Use ${v.palette}.`,
    `Arrange the room as follows: ${layout}.`,
    `Use ${v.material}.`,
    `Floor covering: ${v.rug}.`,
    `Lighting: ${v.light}.`,
    `Decor: ${v.accent}.`,
    'Make this arrangement clearly distinct from any other staging of this room.',
    HARD_ARCHITECTURE,
  ].join(' ');
}

const genAI = new GoogleGenerativeAI(readKey());
const { reviewImageQuality } = createImageReview({ genAI });
const { processStaging } = createStagingGeneration({
  genAI,
  DEBUG_MODE: false,
  runQualityRetry: generateWithQualityRetry,
  reviewImageQuality,
  QUALITY_MAX_ATTEMPTS: 2,
  logPromptToFile: () => {},
});

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const srcBuffer = fs.readFileSync(SRC);
const targets = String(process.argv[2] || '').split(',').map(Number).filter((n) => !Number.isNaN(n));

async function regen(index) {
  const row = manifest.find((r) => r.index === index);
  if (!row) throw new Error('no manifest row for index ' + index);
  let native = null;
  const dataUrl = await processStaging(
    srcBuffer,
    {
      roomType: 'Living room',
      furnitureStyle: row.style,
      additionalPrompt: directive(row),
      removeFurniture: false,
      labelVirtuallyStaged: false,
      onNative: (buf) => { native = buf; },
    },
    { body: {} },
    null,
    'gemini-2.5-flash-image'
  );
  const raw = native || Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const out = await sharp(raw).resize(1216, 832, { fit: 'cover' }).webp({ quality: 74 }).toBuffer();
  fs.writeFileSync(path.join(OUT, row.file), out);
  return Math.round(out.length / 1024);
}

const results = await Promise.all(
  targets.map((i) =>
    regen(i).then(
      (kb) => `ok   index ${i}  ${kb} KB`,
      (e) => `FAIL index ${i}  ${String(e?.message || e).slice(0, 140)}`
    )
  )
);
results.forEach((r) => console.log(r));
