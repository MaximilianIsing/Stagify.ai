// The #restage pool generator — grow it, or replace a render you have rejected.
//
// This replaces the four near-identical batch scripts that used to live in
// studio-section-concepts/tools/. It drives the repo's OWN pipeline
// (createStagingGeneration().processStaging), so every image is genuine Stagify output built
// from lib/staging/promptMatrix.js. The only thing bypassed is virtual-staging-handler.js,
// whose 3-variation cap, auth, rate limits, DB writes and R2 uploads are all irrelevant here.
//
// TWO PHASES, ON PURPOSE. Renders land in tools/pending/ and go no further until you have
// looked at them. Three of the four things that make a render unusable have no numeric
// screen (see ../README.md), so "generate straight into public/" would ship them. The pool
// has needed ten replacements so far; every one was caught by eye, none by a metric.
//
//   node tools/generate.mjs --add 20          # next free slots, unused recipes
//   node tools/generate.mjs --replace r44,r46 # same slots, fresh recipes
//   <look at tools/pending/*.webp>
//   node tools/generate.mjs --reject r94      # re-roll one at a different recipe
//   node tools/generate.mjs --accept          # install everything still pending
//   node tools/generate.mjs --discard         # throw the pending batch away
//
// --accept does the whole install: copies the WebP into public/, mints the pixel-identical
// PNG master beside this file, appends the recipe to ../manifest.json, and rewrites the
// RESTAGE_POOL list in public/scripts/restage-pool.js. That last step is what
// test/frontend/home-restage.test.js checks, so forgetting it used to fail the build.
//
// Needs GOOGLE_AI_API_KEY in .env (or the environment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createStagingGeneration } from '../../../../../lib/staging/staging-generation.js';
import { generateWithQualityRetry } from '../../../../../lib/staging/staging-pipeline.js';
import { createImageReview } from '../../../../../lib/image/image-review.js';
import { pick, recipeKey, directive } from './axes.mjs';
import { boxPixels, doorwayMad, GATE } from './arch-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MASTERS = path.resolve(HERE, '..');
const REPO = path.resolve(HERE, '../../../../..');
const SRC = path.join(MASTERS, 'empty.png');
const MANIFEST = path.join(MASTERS, 'manifest.json');
const PENDING = path.join(HERE, 'pending');
const SERVED = path.join(REPO, 'public/media-webp/Homepage/Restage');
const POOL_LIST = path.join(REPO, 'public/scripts/restage-pool.js');

const MAX_ATTEMPTS = 4;
const CONCURRENCY = 4;

/* ------------------------------------------------------------------ helpers */

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const liveRows = (m) => m.filter((r) => !r.supersededBy);
const slotNumber = (name) => Number(String(name).replace(/^r/, ''));

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

/** Every render currently served, by slot number. */
function servedSlots() {
  return fs.readdirSync(SERVED)
    .filter((f) => /^r\d+\.webp$/.test(f))
    .map((f) => slotNumber(path.basename(f, '.webp')))
    .sort((a, b) => a - b);
}

const readPending = () => (fs.existsSync(path.join(PENDING, 'pending.json'))
  ? JSON.parse(fs.readFileSync(path.join(PENDING, 'pending.json'), 'utf8'))
  : []);

function writePending(rows) {
  fs.mkdirSync(PENDING, { recursive: true });
  fs.writeFileSync(path.join(PENDING, 'pending.json'), JSON.stringify(rows, null, 2) + '\n');
}

/**
 * Walk the recipe space from `cursor` and take the first `n` recipes that no live render and
 * no already-chosen render uses. Returns the recipes and the cursor to resume from, so a
 * later --reject can carry on past everything this batch already consumed.
 */
function chooseRecipes(n, used, cursor = 0) {
  const out = [];
  let i = cursor;
  const guard = i + 100000;
  while (out.length < n) {
    if (i > guard) throw new Error('recipe space exhausted — add axis values in axes.mjs');
    const v = pick(i);
    const k = recipeKey(v);
    if (!used.has(k)) { used.add(k); out.push({ ...v, axisIndex: i }); }
    i++;
  }
  return { recipes: out, cursor: i };
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

async function renderOnce(v, srcBuffer) {
  let native = null;
  const dataUrl = await getPipeline()(
    srcBuffer,
    {
      roomType: 'Living room',
      furnitureStyle: v.style,
      additionalPrompt: directive(v),
      removeFurniture: false,
      labelVirtuallyStaged: false,
      // processStaging doubles the image for delivery; the pool wants 1216x832, so grab the
      // pre-upscale bytes rather than downsampling the upscaled ones.
      onNative: (buf) => { native = buf; },
    },
    { body: {} },
    null,
    'gemini-2.5-flash-image' // the free-tier default: what a normal visitor's render looks like
  );
  const raw = native || Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  return sharp(raw).resize(1216, 832, { fit: 'cover' }).webp({ quality: 74 }).toBuffer();
}

async function renderGated(job, srcBuffer, srcBox) {
  let best = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let out;
    try {
      out = await renderOnce(job, srcBuffer);
    } catch (e) {
      console.log(`   ${job.slot} attempt ${attempt} threw: ${String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    const mad = doorwayMad(await boxPixels(out), srcBox);
    if (!best || mad < best.mad) best = { out, mad };
    if (mad <= GATE) break;
    console.log(`   ${job.slot} attempt ${attempt} mad ${mad.toFixed(1)} > ${GATE}, retrying`);
  }
  return best;
}

async function runJobs(jobs) {
  const srcBuffer = fs.readFileSync(SRC);
  const srcBox = await boxPixels(SRC);
  fs.mkdirSync(PENDING, { recursive: true });
  const queue = [...jobs];
  const done = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const best = await renderGated(job, srcBuffer, srcBox);
      if (!best) { console.log(`FAIL ${job.slot} — every attempt failed`); continue; }
      fs.writeFileSync(path.join(PENDING, `${job.slot}.webp`), best.out);
      done.push({ ...job, mad: Number(best.mad.toFixed(1)) });
      const flag = best.mad > GATE ? `  OVER GATE (${GATE}) — look closely` : '';
      console.log(`ok   ${job.slot.padEnd(5)} ${job.style.padEnd(12)} mad ${best.mad.toFixed(1).padStart(5)}  ${Math.round(best.out.length / 1024)} KB${flag}`);
    }
  }));
  return done;
}

/* ------------------------------------------------------------------ actions */

async function add(count) {
  const manifest = readManifest();
  const used = new Set(liveRows(manifest).map(recipeKey));
  const pendingRows = readPending();
  pendingRows.forEach((r) => used.add(recipeKey(r)));

  const taken = new Set([...servedSlots(), ...pendingRows.map((r) => slotNumber(r.slot))]);
  const slots = [];
  for (let n = 1; slots.length < count; n++) if (!taken.has(n)) slots.push(n);

  const { recipes } = chooseRecipes(count, used);
  const jobs = recipes.map((v, k) => ({ ...v, slot: `r${slots[k]}` }));
  console.log(`generating ${count} render(s): ${jobs.map((j) => j.slot).join(', ')}\n`);
  writePending([...pendingRows, ...(await runJobs(jobs))]);
  report();
}

async function replace(slots) {
  const manifest = readManifest();
  const used = new Set(liveRows(manifest).map(recipeKey));
  const pendingRows = readPending();
  pendingRows.forEach((r) => used.add(recipeKey(r)));

  const { recipes } = chooseRecipes(slots.length, used);
  const jobs = recipes.map((v, k) => ({ ...v, slot: slots[k], replaces: slots[k] }));
  console.log(`re-rendering ${slots.length} slot(s): ${slots.join(', ')}\n`);
  const fresh = await runJobs(jobs);
  writePending([...pendingRows.filter((r) => !slots.includes(r.slot)), ...fresh]);
  report();
}

/**
 * Re-roll a pending render at a DIFFERENT recipe. Retrying the same one is close to
 * pointless: the failures that get this far are the recipe interacting badly with the room,
 * not an unlucky sample.
 */
async function reject(slots) {
  const pendingRows = readPending();
  const keep = pendingRows.filter((r) => !slots.includes(r.slot));
  const dropped = pendingRows.filter((r) => slots.includes(r.slot));
  if (!dropped.length) throw new Error(`nothing pending for ${slots.join(', ')}`);

  const used = new Set(liveRows(readManifest()).map(recipeKey));
  pendingRows.forEach((r) => used.add(recipeKey(r)));
  // Resume the cursor past everything this batch already consumed.
  const cursor = Math.max(...pendingRows.map((r) => r.axisIndex ?? 0)) + 1;
  const { recipes } = chooseRecipes(dropped.length, used, cursor);
  const jobs = recipes.map((v, k) => ({ ...v, slot: dropped[k].slot, ...(dropped[k].replaces ? { replaces: dropped[k].replaces } : {}) }));
  console.log(`re-rolling ${jobs.map((j) => j.slot).join(', ')} at fresh recipes\n`);
  writePending([...keep, ...(await runJobs(jobs))]);
  report();
}

/** Rewrite the checked-in RESTAGE_POOL array so it matches what is on disk. */
function writePoolList() {
  const files = fs.readdirSync(SERVED).filter((f) => /^r\d+\.webp$/.test(f))
    .sort((a, b) => slotNumber(path.basename(a, '.webp')) - slotNumber(path.basename(b, '.webp')));
  const body = files.map((f) => `  '${f}',`).join('\n');
  const source = fs.readFileSync(POOL_LIST, 'utf8');
  const next = source.replace(/(Object\.freeze\(\[\r?\n)[\s\S]*?(\]\);)/, (_m, open, close) => `${open}${body}\n${close}`);
  if (next === source) throw new Error('could not find the RESTAGE_POOL array in restage-pool.js');
  fs.writeFileSync(POOL_LIST, next);
  return files.length;
}

async function accept() {
  const rows = readPending();
  if (!rows.length) throw new Error('nothing pending');
  const manifest = readManifest();
  const batch = Math.max(0, ...manifest.map((r) => r.batch || 1)) + 1;

  for (const row of rows) {
    const webp = path.join(PENDING, `${row.slot}.webp`);
    fs.copyFileSync(webp, path.join(SERVED, `${row.slot}.webp`));
    await sharp(webp).png().toFile(path.join(MASTERS, `${row.slot}.png`));
    const a = await sharp(path.join(SERVED, `${row.slot}.webp`)).raw().toBuffer();
    const b = await sharp(path.join(MASTERS, `${row.slot}.png`)).raw().toBuffer();
    if (Buffer.compare(a, b) !== 0) throw new Error(`${row.slot}.png is not pixel-identical to its WebP`);
    console.log(`installed ${row.slot}`);
  }

  // A replaced slot's old recipe stops describing anything shipped; say so rather than
  // leaving two rows claiming the same filename.
  const replaced = new Set(rows.filter((r) => r.replaces).map((r) => r.replaces));
  const updated = manifest.map((r) => {
    const name = r.shipped ? path.basename(r.shipped, '.webp') : `r${String((r.index ?? -1) + 1).padStart(2, '0')}`;
    return replaced.has(name) && !r.supersededBy
      ? { ...r, supersededBy: `${name}.webp`, note: `shipped render replaced in batch ${batch}` }
      : r;
  });
  const added = rows.map(({ slot, mad, replaces, axisIndex, ...v }) => ({
    batch, axisIndex, shipped: `${slot}.webp`, ...v, mad, ...(replaces ? { replaces } : {}),
  }));
  fs.writeFileSync(MANIFEST, JSON.stringify([...updated, ...added], null, 2) + '\n');

  const count = writePoolList();
  fs.rmSync(PENDING, { recursive: true, force: true });
  console.log(`\naccepted ${rows.length} as batch ${batch}; pool is now ${count}`);
  console.log('manifest and restage-pool.js updated — run `npm test` to confirm.');
}

function discard() {
  fs.rmSync(PENDING, { recursive: true, force: true });
  console.log('pending batch discarded; nothing else changed');
}

function report() {
  const rows = readPending();
  if (!rows.length) return;
  const over = rows.filter((r) => r.mad > GATE);
  console.log(`\n${rows.length} render(s) pending in tools/pending/.`);
  if (over.length) console.log(`${over.length} over the doorway gate: ${over.map((r) => r.slot).join(', ')}`);
  console.log('LOOK AT EVERY ONE before --accept. The doorway gate is the only automated');
  console.log('check; a recoloured floor, an added window shutter and a sparsely furnished');
  console.log('room all score clean. See ../README.md.');
}

/* ---------------------------------------------------------------------- cli */

const [flag, arg] = process.argv.slice(2);
const slotList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

if (flag === '--add') await add(Number(arg) || 1);
else if (flag === '--replace') await replace(slotList(arg));
else if (flag === '--reject') await reject(slotList(arg));
else if (flag === '--accept') await accept();
else if (flag === '--discard') discard();
else {
  console.log(`usage:
  node tools/generate.mjs --add <n>            grow the pool by n renders
  node tools/generate.mjs --replace r44,r46    re-render those slots at fresh recipes
  node tools/generate.mjs --reject r94         re-roll one pending render
  node tools/generate.mjs --accept             install everything pending
  node tools/generate.mjs --discard            drop the pending batch`);
}
