// The hero style/room grid generator.
//
// The homepage hero lets a visitor pick a room type AND a furniture style, and shows the
// matching render of ONE room: public/media-webp/example/Original.webp. That needs a photo
// for every combination, so this script builds the whole grid by driving the repo's own
// pipeline (createStagingGeneration().processStaging), exactly like the #restage pool
// generator at to-build/media-png/Homepage/Restage/tools/generate.mjs does. Every image is
// therefore genuine Stagify output built from lib/staging/promptMatrix.js, which is the
// point: the hero is a claim about what the product does, so it has to BE what the product
// does. Only virtual-staging-handler.js is bypassed (auth, rate limits, DB writes, R2).
//
//   node to-build/media-png/example/tools/generate-combos.mjs            # fill every gap
//   node to-build/media-png/example/tools/generate-combos.mjs --only bedroom
//   node to-build/media-png/example/tools/generate-combos.mjs --redo modern-kitchen
//   node to-build/media-png/example/tools/generate-combos.mjs --list
//
// Resumable by design: a combination whose .webp already exists is skipped, so an
// interrupted run costs nothing to restart. Use --redo to re-roll one you have rejected.
//
// Writes BOTH halves of the repo's asset convention, the same way `Original` and the rest
// of the grid are stored:
//   to-build/media-png/example/<style>-<room>.png    the master
//   public/media-webp/example/<style>-<room>.webp    what the browser gets (900x600)
//
// Outdoors and Dorm are deliberately absent from ROOMS. Outdoors belongs to Exterior Studio
// and reads as broken in the hero sentence ("Stage this Outdoors in Modern"); Dorm was
// excluded by request. Both still exist in promptMatrix.js and are untouched by this script.
//
// Needs GOOGLE_AI_API_KEY in .env (or the environment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createStagingGeneration } from '../../../../lib/staging/staging-generation.js';
import { generateWithQualityRetry } from '../../../../lib/staging/staging-pipeline.js';
import { createImageReview } from '../../../../lib/image/image-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTERS = path.resolve(HERE, '..');
const REPO = path.resolve(HERE, '../../../..');
const SRC_MASTER = path.join(MASTERS, 'Original.png');
const SERVED = path.join(REPO, 'public/media-webp/example');

// 900x600 and q80 are not arbitrary: they are what every image in this folder already is,
// `Original` included, and the hero cross-fades between them, so a stray dimension would
// show up as a jump rather than a fade.
const OUT_W = 900;
const OUT_H = 600;
const OUT_Q = 80;

const MAX_ATTEMPTS = 3;
const CONCURRENCY = 4;

/* --------------------------------------------- the changed-architecture gates
 *
 * The failure mode here with a working numeric screen. The source room has three things the
 * model keeps rewriting so it has somewhere to put furniture: the left glass wall, the
 * structural column with the far wall behind it, and the right window bank. Replace any of
 * them and you get a handsome room that is no longer THIS room, which is the whole promise
 * of a picker that swaps the pair inside a fixed frame.
 *
 * Mean absolute difference against the source over one box per region — the same trick the
 * #restage pool's arch-check.mjs uses on its doorway recess, and for the same reason: a
 * plain brightness test only catches the walled-over-in-white direction, not a dark mirror,
 * a marble cladding or a cabinet run hung across the glass.
 *
 * CALIBRATION, done blind. A human picked the bad renders without seeing any numbers, twice.
 * Round one (right bank): the five they rejected scored 33.5-55.1, the one they kept 24.4.
 * Round two (left wall): the four they rejected scored 32.0-37.8, the next clean render 15.9
 * — and the metric additionally caught a fifth, a luxury Bathroom at 33.7 whose left wall had
 * been clad in marble, that they had not spotted. Each gate sits in its own gap.
 *
 * A HIGH SCORE IS A SCREEN, NOT A VERDICT, and the column box is the weakest of the three:
 * anything legitimately large standing near it — a wardrobe, a bookcase, a tall plant —
 * scores like removing it. Kitchens are over on column and right across the board because
 * cabinetry genuinely has to go somewhere. So this never fails a render; it retries, keeps
 * the best attempt, prints every region, and lists what is still over at the end. */
const REGIONS = [
  // The left glass wall. Gets clad in marble or tile, or walled over to hold a vanity.
  // Clean renders sit at 16 and below; the five a human rejected for it scored 32.0-37.8.
  { key: 'left', gate: 20, box: { left: 10, top: 60, width: 310, height: 350 } },
  // The structural column, and the far wall behind it. Kitchens bury it in cabinetry.
  // This one is the WEAKEST of the three: a tall cabinet or a plant standing beside the
  // column scores as high as removing it, so treat an over-gate column as "go and look",
  // never as proof. Kept because the failure it catches is the worst-looking one.
  { key: 'column', gate: 26, box: { left: 330, top: 100, width: 75, height: 310 } },
  // The right window bank. Walled over to hang a mirror, vanity or shower enclosure.
  { key: 'right', gate: 26, box: { left: 395, top: 160, width: 230, height: 240 } },
];

const GATE_ATTEMPTS = 3;

/** Room-type keys as promptMatrix.js spells them, paired with the slug used in filenames. */
const ROOMS = [
  { key: 'Bedroom', slug: 'bedroom' },
  { key: 'Living room', slug: 'living-room' },
  { key: 'Dining room', slug: 'dining-room' },
  { key: 'Kitchen', slug: 'kitchen' },
  { key: 'Office', slug: 'office' },
  { key: 'Bathroom', slug: 'bathroom' },
];

/** Style keys as promptMatrix.js spells them. 'standard' and 'custom' are not user-facing. */
const STYLES = ['modern', 'scandinavian', 'coastal', 'farmhouse', 'luxury', 'midcentury'];

const nameOf = (style, room) => `${style}-${room.slug}`;
const webpPath = (n) => path.join(SERVED, `${n}.webp`);
const pngPath = (n) => path.join(MASTERS, `${n}.png`);

function readKey() {
  if (process.env.GOOGLE_AI_API_KEY) return process.env.GOOGLE_AI_API_KEY.trim();
  const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq !== -1 && line.slice(0, eq).trim() === 'GOOGLE_AI_API_KEY') return line.slice(eq + 1).trim();
  }
  throw new Error('GOOGLE_AI_API_KEY not found in the environment or .env');
}

/* ------------------------------------------------------------------- render */

let pipeline = null;
function getPipeline() {
  if (pipeline) return pipeline;
  const genAI = new GoogleGenerativeAI(readKey());
  const { reviewImageQuality } = createImageReview({ genAI });
  pipeline = createStagingGeneration({
    genAI,
    DEBUG_MODE: false,
    runQualityRetry: generateWithQualityRetry,
    reviewImageQuality,
    QUALITY_MAX_ATTEMPTS: 2,
    logPromptToFile: () => {},
  }).processStaging;
  return pipeline;
}

async function renderOnce(style, room, srcBuffer) {
  let native = null;
  const dataUrl = await getPipeline()(
    srcBuffer,
    {
      roomType: room.key,
      furnitureStyle: style,
      // No additionalPrompt on purpose. The grid has to show what promptMatrix.js alone
      // produces for this pair, because that is what a visitor who picks the same pair gets.
      additionalPrompt: '',
      /* TRUE, and it matters — this is not a formality on an already-empty room.
         With `false`, generatePrompt() appends "treat any furniture and decor named above as
         a guide to the desired STYLE only, NOT a checklist of items to place from scratch.
         Only ADD new complementary pieces in that style to fill empty or sparse areas."
         That is correct when the photo has the owner's furniture in it and wrong here: it
         demotes "clawfoot bathtub, wooden vanity, farmhouse sink" to mood words, so the model
         looked at an empty living room and produced a tastefully rustic LIVING ROOM. Twice in
         a row, for farmhouse Bathroom. `true` takes the branch that keeps the list a
         checklist; the "remove all existing furniture" clause it adds is a no-op on a room
         that has none. */
      removeFurniture: true,
      // Matches the existing example images and the #restage pool: these are product
      // demos of the render itself, and the stamp is applied on the user's own download.
      labelVirtuallyStaged: false,
      onNative: (buf) => { native = buf; },
    },
    { body: {} },
    null,
    'gemini-2.5-flash-image', // the free-tier default: what a normal visitor's render looks like
  );
  const raw = native || Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  // A PNG buffer rather than a live sharp pipeline: the caller has to both SCORE these
  // pixels and write two files from them, and re-decoding one buffer is cheaper and less
  // error-prone than cloning a pipeline three ways.
  return sharp(raw).resize(OUT_W, OUT_H, { fit: 'cover' }).png().toBuffer();
}

/** Greyscale pixels of every gated region, keyed by region. */
async function regionPixels(input) {
  const out = {};
  for (const r of REGIONS) {
    out[r.key] = await sharp(input).resize(OUT_W, OUT_H, { fit: 'cover' })
      .extract(r.box).greyscale().raw().toBuffer();
  }
  return out;
}

/** Mean absolute difference between two equal-length pixel buffers. */
function mad(pixels, sourcePixels) {
  let total = 0;
  for (let i = 0; i < pixels.length; i++) total += Math.abs(pixels[i] - sourcePixels[i]);
  return total / pixels.length;
}

/**
 * Score one render against the source across every region.
 *
 * Two numbers, and they do different jobs.
 *
 * `worst` (largest mad/gate ratio) decides PASS/FAIL: <= 1 means every region is inside its
 * own gate. Ratios rather than raw mads because the regions have different tolerances — the
 * left wall is a sheet of glass where any change is real, the column sits in white-on-white
 * and needs slack — so raw numbers are not comparable between them.
 *
 * `total` (sum of the ratios) decides WHICH ATTEMPT IS BETTER, and it has to be a sum, not
 * the max. Ranking on the worst region alone lets a render trade a healthy region for a
 * broken one and still look like an improvement: a luxury Kitchen with an intact left wall
 * (12.1) and a mangled right one was replaced by a version that had wrecked BOTH, because
 * its worst ratio was fractionally lower. Summing means breaking something that was fine
 * always costs more than it gains.
 */
function scoreRegions(pixels, sourcePixels) {
  const per = {};
  let worst = 0;
  let total = 0;
  for (const r of REGIONS) {
    per[r.key] = mad(pixels[r.key], sourcePixels[r.key]);
    const ratio = per[r.key] / r.gate;
    worst = Math.max(worst, ratio);
    total += ratio;
  }
  return { per, worst, total };
}

/** "left 12.1  column 36.4  right 54.3" with an over-gate marker. */
const formatScore = (score) => REGIONS
  .map((r) => `${r.key} ${score.per[r.key].toFixed(1)}${score.per[r.key] > r.gate ? '!' : ''}`)
  .join('  ');

async function renderOne(style, room, srcBuffer, srcRegions) {
  const name = nameOf(style, room);
  let lastErr = null;
  let best = null;      // { buf, score } — the least-altered attempt so far
  let errors = 0;

  /* The file already on disk competes with this run, and wins ties.
   *
   * `--redo` used to delete the target first, which made it a gamble you could lose: a
   * luxury Bathroom that had reached 28.0 was re-rolled and replaced by a 41.3, and the
   * better image was simply gone. Scoring the incumbent and only overwriting when we
   * genuinely beat it makes re-rolling monotonic — run it as many times as you like and the
   * file can only improve. */
  let incumbent = null;
  if (fs.existsSync(webpPath(name))) {
    try {
      incumbent = scoreRegions(await regionPixels(webpPath(name)), srcRegions);
    } catch { /* unreadable: treat as no incumbent */ }
  }

  for (let attempt = 1; attempt <= GATE_ATTEMPTS + MAX_ATTEMPTS; attempt++) {
    if (best && attempt > GATE_ATTEMPTS) break;
    try {
      const buf = await renderOnce(style, room, srcBuffer);
      const score = scoreRegions(await regionPixels(buf), srcRegions);
      if (!best || score.total < best.score.total) best = { buf, score };
      if (score.worst <= 1) break;
      process.stdout.write(`  redo ${name.padEnd(26)} ${formatScore(score)}\n`);
    } catch (err) {
      lastErr = err;
      if (++errors >= MAX_ATTEMPTS) break;
      process.stdout.write(`  retry ${name.padEnd(25)} ${err.message}\n`);
    }
  }

  if (!best) {
    if (incumbent) {
      process.stdout.write(`  kept ${name.padEnd(26)} every attempt errored; existing file untouched\n`);
      return { name, ok: true, score: incumbent };
    }
    process.stdout.write(`  FAIL ${name.padEnd(26)} ${lastErr && lastErr.message}\n`);
    return { name, ok: false, error: lastErr && lastErr.message };
  }

  if (incumbent && incumbent.total <= best.score.total) {
    process.stdout.write(`  kept ${name.padEnd(26)} on disk is no worse — ${formatScore(incumbent)}\n`);
    return { name, ok: true, score: incumbent };
  }

  // One decode, two encodes, so the master and the served file are the same pixels.
  await sharp(best.buf).png().toFile(pngPath(name));
  await sharp(best.buf).webp({ quality: OUT_Q }).toFile(webpPath(name));
  const kb = Math.round(fs.statSync(webpPath(name)).size / 1024);
  const flag = best.score.worst <= 1 ? 'ok  ' : 'LOOK';
  process.stdout.write(`  ${flag} ${name.padEnd(26)} ${String(kb).padStart(3)} KB  ${formatScore(best.score)}\n`);
  return { name, ok: true, score: best.score };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const only = flag('--only');
  const redo = flag('--redo');

  let jobs = [];
  for (const room of ROOMS) for (const style of STYLES) jobs.push({ style, room });

  if (only) jobs = jobs.filter((j) => j.room.slug === only || j.style === only);
  /* Deliberately does NOT delete the targets first. renderOne() scores whatever is already
     there and keeps it unless this run beats it, which is what makes a re-roll safe to
     repeat: the file can only get better. Deleting first is how a 28.0 got replaced by a
     41.3 and lost. */
  const forced = redo ? new Set(redo.split(',').map((s) => s.trim())) : null;
  if (forced) jobs = jobs.filter((j) => forced.has(nameOf(j.style, j.room)));

  if (argv.includes('--list')) {
    for (const j of jobs) {
      const n = nameOf(j.style, j.room);
      console.log(`${fs.existsSync(webpPath(n)) ? 'have' : 'MISS'}  ${n}`);
    }
    return;
  }

  // A gap always renders; a --redo target renders even though it is present, and then has to
  // beat what is already there to replace it.
  const todo = jobs.filter((j) => forced || !fs.existsSync(webpPath(nameOf(j.style, j.room))));
  console.log(`grid ${ROOMS.length} rooms x ${STYLES.length} styles = ${ROOMS.length * STYLES.length}`);
  console.log(`${jobs.length - todo.length} already present, ${todo.length} to render, concurrency ${CONCURRENCY}\n`);
  if (!todo.length) return;

  const srcBuffer = fs.readFileSync(SRC_MASTER);
  const srcRegions = await regionPixels(srcBuffer);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const j = todo[cursor++];
      results.push(await renderOne(j.style, j.room, srcBuffer, srcRegions));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const bad = results.filter((r) => !r.ok);
  const look = results.filter((r) => r.ok && r.score.worst > 1);
  console.log(`\ndone: ${results.length - bad.length} rendered, ${bad.length} failed`);
  if (look.length) {
    console.log(`${look.length} still outside a region gate after ${GATE_ATTEMPTS} attempts — LOOK AT THESE:`);
    for (const r of look.sort((a, b) => b.score.worst - a.score.worst)) {
      console.log(`  ${r.name.padEnd(26)} ${formatScore(r.score)}`);
    }
  }
  if (bad.length) {
    console.log('re-run to retry the failures, or --redo them individually:');
    for (const b of bad) console.log(`  ${b.name}: ${b.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
