// Throwaway generator: 60 staged variations of ONE empty room, for the shuffle-deck
// section prototype.
//
// It drives the REPO'S OWN pipeline — createStagingGeneration().processStaging — so every
// image is genuinely Stagify output built from lib/staging/promptMatrix.js, not a
// reimplementation. The only thing bypassed is virtual-staging-handler.js, whose 3-variation
// cap, auth, rate limits, DB writes and R2 uploads are all irrelevant here.
//
// Usage (from the repo root): node studio-section-concepts/tools/gen-pool.mjs [start] [end]
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
const POOL_SIZE = 60;
const CONCURRENCY = 4;

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

/* ---------------------------------------------------------------- variation axes

   The point of the pool is that two presses never look alike, so the axes below are
   deliberately coarse — palette, layout, material, rug, light, accent. The style still
   comes from promptMatrix (that's what makes these real Stagify renders), but
   generatePrompt appends additionalPrompt as "Prioritize the following above everything
   else: ...", so these directives carry real weight against the style's default
   shopping list. That is exactly what "high variation" needs. */

const STYLES = ['standard', 'modern', 'midcentury', 'scandinavian', 'luxury', 'coastal', 'farmhouse'];

const PALETTES = [
  'a warm neutral palette of oatmeal, camel and soft white',
  'a cool palette of slate grey, charcoal and off white',
  'an earthy palette of terracotta, ochre and olive',
  'a deep jewel palette of emerald green and brass',
  'a soft monochrome palette of ivory, greige and pale stone',
  'a muted pastel palette of dusty blue, blush and cream',
  'a high-contrast palette of black, white and natural oak',
  'a forest palette of moss green, walnut and cream',
  'a sandy coastal palette of bone, driftwood and pale blue',
  'a rich autumn palette of rust, mustard and deep brown',
  'a calm palette of navy, warm grey and light wood',
  'a bright palette of clean white, natural linen and pale birch',
];

const LAYOUTS = [
  'a three-seat sofa set against the large blank back wall, facing the camera, with two armchairs angled in front of it',
  'an L-shaped sectional tucked into the far corner, opening toward the window',
  'two matching sofas facing each other across a central coffee table, floating away from the walls',
  'a single sofa along the back wall with a generous open walkway kept clear in the foreground',
  'a sofa placed under the window with a pair of lounge chairs opposite it',
  'a sectional along the left wall, a slim console behind it, and a reading corner near the window',
  'a compact seating group pulled forward into the centre of the room, leaving the back wall for a tall shelving unit',
  'a sofa facing the window with its back to the camera, and a low media unit on the back wall',
  'an asymmetric arrangement: one long sofa, one oversized armchair, and a small stool',
  'a symmetrical formal arrangement centred on the back wall, two sofas flanking a coffee table',
];

const MATERIALS = [
  'upholstery in soft cream boucle',
  'a tan leather sofa with visible grain',
  'natural linen upholstery with relaxed loose covers',
  'deep velvet upholstery with a subtle sheen',
  'woven rattan and cane detailing on the chair frames',
  'solid walnut frames with tight woven fabric',
  'chunky knitted and felted wool textiles',
  'smooth matte cotton upholstery with piped edges',
  'mixed materials: leather seating with a light oak frame',
  'textured slubby fabric in a natural undyed tone',
];

const RUGS = [
  'a large flat jute rug that anchors the whole seating group',
  'a patterned kilim rug with faded geometric motifs',
  'a soft high-pile rug in a plain pale tone',
  'a low-pile wool rug with a subtle grid pattern',
  'two layered rugs, a large natural fibre base with a smaller patterned rug on top',
  'a vintage distressed Persian-style rug with muted colours',
  'a simple bordered rug that echoes the wall colour',
  'no rug at all, leaving the oak floor fully visible',
];

const LIGHTS = [
  'a tall arc floor lamp reaching over the seating',
  'a pair of matching table lamps on side tables',
  'a slim tripod floor lamp beside the armchair',
  'a sculptural paper globe floor lamp in the corner',
  'a brass reading lamp next to the sofa and a small table lamp on the console',
  'an oversized dome floor lamp with a coloured shade',
  'warm uplighting from a corner floor lamp plus candles on the coffee table',
  'a slim adjustable task lamp by the window seat',
];

const ACCENTS = [
  'one very large abstract canvas centred on the back wall',
  'a gallery wall of six to eight small framed prints',
  'a tall leaning mirror against the wall beside the window',
  'open shelving styled with books, ceramics and a few objects',
  'a big potted fiddle leaf fig by the window and two smaller plants',
  'a long low console with a stack of art books and a sculptural vase',
  'a woven wall hanging above the sofa and a basket of throws on the floor',
  'a pair of framed botanical prints and a bowl of fruit on the coffee table',
  'a single oversized floor vase with dried branches',
  'floating picture ledges with overlapping framed artwork',
];

/* Coprime-ish strides so the six axes stay out of phase across 60 entries — every
   combination below is unique, and no two neighbours share more than one axis. */
function pick(i) {
  return {
    style: STYLES[i % STYLES.length],
    palette: PALETTES[i % PALETTES.length],
    layout: LAYOUTS[(i * 3) % LAYOUTS.length],
    material: MATERIALS[(i * 7) % MATERIALS.length],
    rug: RUGS[(i * 5) % RUGS.length],
    light: LIGHTS[(i * 3) % LIGHTS.length],
    accent: ACCENTS[(i * 9) % ACCENTS.length],
  };
}

function directive(v) {
  return [
    `Use ${v.palette}.`,
    `Arrange the room as follows: ${v.layout}.`,
    `Use ${v.material}.`,
    `Floor covering: ${v.rug}.`,
    `Lighting: ${v.light}.`,
    `Decor: ${v.accent}.`,
    'Make this arrangement clearly distinct from any other staging of this room.',
    'Keep the walls, window, doorway, ceiling, oak floor and camera framing exactly as in the source photo.',
  ].join(' ');
}

/* ------------------------------------------------------------------------ run */

const KEY = readKey();
const genAI = new GoogleGenerativeAI(KEY);
const { reviewImageQuality } = createImageReview({ genAI });
const { processStaging } = createStagingGeneration({
  genAI,
  DEBUG_MODE: false,
  runQualityRetry: generateWithQualityRetry,
  reviewImageQuality,
  QUALITY_MAX_ATTEMPTS: 2, // one quality retry; the handler uses 3 in prod
  logPromptToFile: () => {}, // stub: no CSV writes
});

fs.mkdirSync(OUT, { recursive: true });
const srcBuffer = fs.readFileSync(SRC);

const start = Number(process.argv[2] ?? 0);
const end = Number(process.argv[3] ?? POOL_SIZE);

async function render(i) {
  const v = pick(i);
  const id = String(i + 1).padStart(2, '0');
  const file = path.join(OUT, `p${id}-${v.style}.webp`);
  if (fs.existsSync(file)) return { i, style: v.style, skipped: true };

  let native = null;
  const dataUrl = await processStaging(
    srcBuffer,
    {
      roomType: 'Living room',
      furnitureStyle: v.style,
      additionalPrompt: directive(v),
      removeFurniture: false, // the room IS empty; this is what a real user sends
      labelVirtuallyStaged: false, // marketing asset, not a listing photo
      onNative: (buf) => { native = buf; },
    },
    { body: {} }, // the only shape processStaging needs from req
    null,
    'gemini-2.5-flash-image' // the free-tier default, i.e. what most visitors get
  );

  // Prefer the pre-upscale native bytes: processStaging doubles the image for delivery,
  // and the pool wants ~1216x832, not 2432x1664.
  const raw = native || Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const out = await sharp(raw)
    .resize(1216, 832, { fit: 'cover' })
    .webp({ quality: 74 })
    .toBuffer();
  fs.writeFileSync(file, out);
  return { i, style: v.style, kb: Math.round(out.length / 1024), file: path.basename(file) };
}

const queue = [];
for (let i = start; i < end; i++) queue.push(i);
const manifest = [];
let done = 0;

async function worker() {
  for (;;) {
    const i = queue.shift();
    if (i === undefined) return;
    try {
      const r = await render(i);
      done++;
      manifest.push({ index: i, ...pick(i), file: r.file });
      console.log(`[${done}/${end - start}] ${r.skipped ? 'skip' : 'ok  '} p${String(i + 1).padStart(2, '0')}-${r.style}${r.kb ? '  ' + r.kb + ' KB' : ''}`);
    } catch (e) {
      done++;
      console.log(`[${done}/${end - start}] FAIL p${String(i + 1).padStart(2, '0')}  ${String(e?.message || e).slice(0, 160)}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(manifest.sort((a, b) => a.index - b.index), null, 2)
);
console.log('\nwrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.webp')).length, 'images');
