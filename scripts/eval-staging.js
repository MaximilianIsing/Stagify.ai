#!/usr/bin/env node
// Offline evaluation of the interior staging pipeline: stage a fixed folder of room photos
// through the REAL processStaging (real Gemini calls, real reviewer, real retry loop), then
// optionally have an independent, stronger model judge every result blind.
//
// WHY THIS EXISTS
// Every quality change to staging is a bet about model behaviour. The pipeline's own reviewer
// cannot settle it — it is the thing being tuned, and grading your own homework flatters it.
// A 2026-09 run showed exactly that: the in-pipeline reviewer passed 8 renders that a blind
// gemini-2.5-pro judge found had changed the room. So the judge here is deliberately a
// different, stronger model than anything the pipeline uses.
//
//   node scripts/eval-staging.js <photo-dir> [options]
//
//   --model plus|fast      Image model tier (default plus → IMAGE_MODEL_PLUS).
//   --room "<type>"        Room type when the filename does not name one (default "Living room").
//   --style <style>        promptMatrix style key (default standard).
//   --temperature <t>      Image-model temperature (default: model default). Experiment knob.
//   --limit <n>            Stage at most n photos.
//   --concurrency <n>      Photos staged at once (default 3).
//   --out <dir>            Output folder (default eval-out/<timestamp>, gitignored).
//   --judge                Blind-judge every result against its source (gemini-2.5-pro).
//   --compare <run-dir>    With --judge: also judge each photo head-to-head against that
//                          earlier run's output (its results.json), order randomised.
//
// Room type is read from the filename when it contains one ("bathroom-03.jpg",
// "dining_room.png"); otherwise --room applies. Keep the photo set fixed between runs.
//
// COSTS MONEY: per photo, one generation + one review, up to QUALITY_MAX_ATTEMPTS of each;
// --judge adds one or two gemini-2.5-pro calls. Reads GOOGLE_AI_API_KEY from env / .env.
import '../load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createGeminiClient } from '../lib/services/gemini-client.js';
import { GEMINI_TIMEOUT_MS } from '../lib/services/ai-clients.js';
import { createImageReview } from '../lib/image/image-review.js';
import { createStagingGeneration } from '../lib/staging/staging-generation.js';
import { generateWithQualityRetry as runQualityRetry } from '../lib/staging/staging-pipeline.js';
import { IMAGE_MODEL_FAST, IMAGE_MODEL_PLUS } from '../lib/config/model-config.js';
import { promptMatrix } from '../lib/staging/promptMatrix.js';
import { errorMessage } from '../lib/errors.js';

// Same attempt budget the server runs with (server.js).
const QUALITY_MAX_ATTEMPTS = 3;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'gemini-2.5-pro';

/**
 * One photo's result row, as written to results.json.
 * @typedef {{ file: string, roomType: string, out: string, error: string, attempts: number | null,
 *   selfDrift: boolean | null, seconds: number,
 *   selfVerdicts: Array<{ perfect: boolean, score: number, drift?: boolean, why: string }> }} EvalRow
 */
/**
 * The judge's verdict on one photo (model JSON, so every field is as-returned), plus the
 * head-to-head result when --compare ran.
 * @typedef {{ architecture_preserved?: boolean, camera_preserved?: boolean, defects?: number,
 *   staging_quality?: number, architecture_notes?: string,
 *   pair: { fidelity: string, overall: string, reason: string } | null }} JudgeEntry
 */

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ dir: string, model: string, room: string, style: string, temperature: number | null, limit: number, concurrency: number, out: string, judge: boolean, compare: string }} */
  const opts = {
    dir: '', model: 'plus', room: 'Living room', style: 'standard', temperature: null,
    limit: Infinity, concurrency: 3, out: '', judge: false, compare: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--room') opts.room = argv[++i];
    else if (a === '--style') opts.style = argv[++i];
    else if (a === '--temperature') opts.temperature = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number.parseInt(argv[++i], 10);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--judge') opts.judge = true;
    else if (a === '--compare') opts.compare = argv[++i];
    else if (!a.startsWith('--')) opts.dir = a;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

/**
 * The promptMatrix room type named in a filename, longest match first ("dining room" before "room").
 * @param {string} name
 * @param {string} fallback
 */
function roomTypeFromName(name, fallback) {
  const flat = name.toLowerCase().replace(/[-_]+/g, ' ');
  const types = Object.keys(promptMatrix).sort((a, b) => b.length - a.length);
  return types.find((t) => flat.includes(t.toLowerCase())) || fallback;
}

/**
 * Run `worker` over `items` with at most `n` in flight.
 * @template T
 * @param {T[]} items
 * @param {number} n
 * @param {(item: T) => Promise<void>} worker
 */
async function pool(items, n, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await worker(/** @type {T} */ (queue.shift()));
  }));
}

/** @param {unknown} v */
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** @param {unknown} s */
const html = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

// ── The blind judge ─────────────────────────────────────────────────────────────────
const JUDGE_ABS_PROMPT = `You are a strict evaluator for AI virtual staging of real-estate photos. Image 1 is the ORIGINAL photo of a real room. Image 2 is the AI-STAGED version, which is supposed to add furniture/decor while keeping the room itself exactly the same (walls, windows, doors, openings, built-ins, fixtures, floor, ceiling, camera position and framing). Furniture already present may be kept.
Count carefully in BOTH images. Then judge:
- architecture_preserved: false if ANY window, door, opening, wall, built-in or fixed feature was added, removed, moved, resized, covered over or reshaped (a window merely partly hidden behind new furniture is fine).
- camera_preserved: false if the viewpoint, zoom, crop or framing changed noticeably (e.g. more or less of a wall visible, different angle).
- defects: 1-10, 10 = no visible AI artifacts (warped/melted/floating furniture, bad perspective, duplicated parts, smeared textures).
- staging_quality: 1-10, how appealing, well-scaled and realistic the staging is for a listing.
Output JSON only.`;
const JUDGE_ABS_SCHEMA = {
  type: 'object',
  properties: {
    windows_original: { type: 'integer' }, windows_staged: { type: 'integer' },
    doors_original: { type: 'integer' }, doors_staged: { type: 'integer' },
    architecture_preserved: { type: 'boolean' }, architecture_notes: { type: 'string' },
    camera_preserved: { type: 'boolean' }, camera_notes: { type: 'string' },
    defects: { type: 'integer' }, staging_quality: { type: 'integer' },
  },
  required: ['windows_original', 'windows_staged', 'doors_original', 'doors_staged', 'architecture_preserved', 'architecture_notes', 'camera_preserved', 'camera_notes', 'defects', 'staging_quality'],
};
const JUDGE_PAIR_PROMPT = `You are a strict evaluator for AI virtual staging of real-estate photos. Image 1 is the ORIGINAL room. Images 2 (A) and 3 (B) are two different AI stagings of it. A good staging keeps the room itself exactly (walls, windows, doors, built-ins, camera framing) and adds realistic, well-scaled, attractive furniture with no artifacts.
Answer: fidelity_winner — which of A or B better preserves the original room and framing ("tie" if equal); overall_winner — which you would publish on a listing ("tie" only if genuinely equal); and a one-sentence reason. Output JSON only.`;
const JUDGE_PAIR_SCHEMA = {
  type: 'object',
  properties: {
    fidelity_winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    overall_winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    reason: { type: 'string' },
  },
  required: ['fidelity_winner', 'overall_winner', 'reason'],
};

/** @param {string} file */
async function judgePart(file) {
  const buf = await sharp(file).rotate().resize(1536, 1536, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
  return { inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } };
}

/**
 * @param {Pick<ReturnType<typeof createGeminiClient>, 'getGenerativeModel'>} genAI
 * @param {Array<{ text: string } | { inlineData: { mimeType: string, data: string } }>} parts
 * @param {object} schema - JSON schema the judge's reply must follow.
 * @returns {Promise<any>} The judge's parsed JSON reply (shape set by `schema`).
 */
async function askJudge(genAI, parts, schema) {
  const model = genAI.getGenerativeModel({
    model: JUDGE_MODEL,
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: schema },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse((await model.generateContent(parts)).response.text());
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir || !fs.existsSync(opts.dir)) {
    console.error('usage: node scripts/eval-staging.js <photo-dir> [--model plus|fast] [--room "<type>"] [--style <style>] [--temperature t] [--limit n] [--concurrency n] [--out dir] [--judge] [--compare run-dir]');
    process.exit(1);
  }
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_AI_API_KEY is not set (env or .env).');
    process.exit(1);
  }

  const model = opts.model === 'fast' ? IMAGE_MODEL_FAST : IMAGE_MODEL_PLUS;
  const realAI = createGeminiClient(apiKey, { timeoutMs: GEMINI_TIMEOUT_MS, attempts: 2 });
  // The temperature experiment is injected here, on the image model only, so production code
  // carries no eval-only parameter.
  const genAI = opts.temperature === null ? realAI : {
    getGenerativeModel: (/** @type {Parameters<typeof realAI.getGenerativeModel>[0]} */ o) => realAI.getGenerativeModel(o.model === model
      ? { ...o, generationConfig: { ...o.generationConfig, temperature: opts.temperature } }
      : o),
  };
  const { reviewImageQuality } = createImageReview({ genAI });

  const outDir = opts.out || path.join('eval-out', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(opts.dir).filter((f) => IMAGE_EXT.test(f)).sort().slice(0, opts.limit);
  const settings = `model=${model} style=${opts.style} temperature=${opts.temperature ?? 'default'}`;
  console.log(`Staging ${files.length} photo(s) → ${outDir}\n${settings}\n`);

  /** @type {EvalRow[]} */
  const rows = [];
  await pool(files, opts.concurrency, async (file) => {
    // Each photo gets its own generation instance so the logger/verdict captures do not
    // interleave when photos run concurrently.
    /** @type {any[]} */ const logged = [];
    /** @type {any[]} */ const verdicts = [];
    const { processStaging } = createStagingGeneration({
      genAI, DEBUG_MODE: false, runQualityRetry,
      reviewImageQuality: async (url, reviewOpts) => {
        const v = await reviewImageQuality(url, reviewOpts);
        verdicts.push(v);
        return v;
      },
      QUALITY_MAX_ATTEMPTS,
      logPromptToFile: (...args) => { logged.push(args[9]); },
    });
    const roomType = roomTypeFromName(file, opts.room);
    const stem = file.replace(IMAGE_EXT, '');
    const started = Date.now();
    /** @type {EvalRow} */
    const r = { file, roomType, out: '', error: '', attempts: null, selfDrift: null, seconds: 0, selfVerdicts: [] };
    try {
      const dataUrl = await processStaging(
        fs.readFileSync(path.join(opts.dir, file)),
        { roomType, furnitureStyle: opts.style, additionalPrompt: '', removeFurniture: false },
        // No HTTP request here; processStaging only reads req.body fields for the log row.
        /** @type {import('express').Request} */ (/** @type {unknown} */ ({ body: {} })),
        null,
        model,
      );
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
      r.out = `${stem}.${m ? m[1] : 'bin'}`;
      fs.writeFileSync(path.join(outDir, r.out), Buffer.from(m ? m[2] : '', 'base64'));
    } catch (e) {
      r.error = errorMessage(e);
    }
    r.seconds = (Date.now() - started) / 1000;
    r.attempts = logged[0]?.attempts ?? null;
    r.selfDrift = logged[0]?.architectureDrift ?? null;
    r.selfVerdicts = verdicts.map((v) => ({ perfect: v.perfect, score: v.score, drift: v.architectureDrift, why: v.reason?.match(/WHY:\s*(.+)/i)?.[1]?.trim() || '' }));
    rows.push(r);
    console.log(`${file}  [${roomType}]  attempts=${r.attempts}  selfDrift=${r.selfDrift}  ${r.seconds.toFixed(1)}s${r.error ? `  ERROR ${r.error}` : ''}`);
  });
  rows.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ settings, photos: path.resolve(opts.dir), rows }, null, 2));

  // ── judge ──
  /** @type {Record<string, JudgeEntry>} */
  const judged = {};
  if (opts.judge) {
    /** @type {Record<string, any>} */
    let prev = {};
    if (opts.compare) {
      const raw = JSON.parse(fs.readFileSync(path.join(opts.compare, 'results.json'), 'utf8'));
      prev = Object.fromEntries((Array.isArray(raw) ? raw : raw.rows).map((/** @type {EvalRow} */ x) => [x.file, x]));
    }
    console.log(`\nJudging with ${JUDGE_MODEL}${opts.compare ? ` (head-to-head vs ${opts.compare})` : ''}…`);
    await pool(rows.filter((r) => r.out), 4, async (r) => {
      const src = await judgePart(path.join(opts.dir, r.file));
      const mine = await judgePart(path.join(outDir, r.out));
      const abs = await askJudge(genAI, [{ text: JUDGE_ABS_PROMPT }, src, mine], JUDGE_ABS_SCHEMA);
      let pair = null;
      const other = prev[r.file];
      if (other?.out && fs.existsSync(path.join(opts.compare, other.out))) {
        const theirs = await judgePart(path.join(opts.compare, other.out));
        // Deterministic per-file order so reruns are comparable, but not always "this run first".
        const mineIsA = [...r.file].reduce((s, c) => s + c.charCodeAt(0), 0) % 2 === 0;
        const p = await askJudge(genAI, [{ text: JUDGE_PAIR_PROMPT }, src, mineIsA ? mine : theirs, mineIsA ? theirs : mine], JUDGE_PAIR_SCHEMA);
        const who = (/** @type {string} */ w) => (w === 'tie' ? 'tie' : ((w === 'A') === mineIsA ? 'this' : 'compare'));
        pair = { fidelity: who(p.fidelity_winner), overall: who(p.overall_winner), reason: p.reason };
      }
      judged[r.file] = { ...abs, pair };
      console.log(`${r.file}  architecture=${abs.architecture_preserved}  camera=${abs.camera_preserved}${pair ? `  vs compare: fidelity=${pair.fidelity} overall=${pair.overall}` : ''}`);
    });
    fs.writeFileSync(path.join(outDir, 'judge.json'), JSON.stringify(judged, null, 2));
  }

  // ── summary + report ──
  const n = rows.length || 1;
  /**
   * @template X
   * @param {(x: X) => unknown} fn
   * @param {X[]} arr
   */
  const mean = (fn, arr) => (arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0) / (arr.length || 1)).toFixed(2);
  const lines = [
    settings,
    `${rows.filter((r) => r.out).length}/${rows.length} rendered · self-flagged drift ${rows.filter((r) => r.selfDrift === true).length}/${n} · mean attempts ${mean((r) => r.attempts, rows)} · mean ${mean((r) => r.seconds, rows)}s`,
  ];
  const J = Object.values(judged);
  if (J.length) {
    const count = (/** @type {(j: JudgeEntry) => unknown} */ fn) => `${J.filter(fn).length}/${J.length}`;
    lines.push(`judge (${JUDGE_MODEL}): architecture preserved ${count((j) => j.architecture_preserved)} · camera preserved ${count((j) => j.camera_preserved)} · defects ${mean((j) => j.defects, J)} · staging ${mean((j) => j.staging_quality, J)}`);
    const P = J.filter((j) => j.pair);
    if (P.length) {
      const tally = (/** @type {'fidelity' | 'overall'} */ k) => `this ${P.filter((j) => j.pair?.[k] === 'this').length} / compare ${P.filter((j) => j.pair?.[k] === 'compare').length} / tie ${P.filter((j) => j.pair?.[k] === 'tie').length}`;
      lines.push(`head-to-head fidelity: ${tally('fidelity')}`, `head-to-head overall:  ${tally('overall')}`);
    }
  }

  const cols = ['file', 'roomType', 'attempts', 'selfDrift', 'seconds', 'error', 'judgeArchitecture', 'judgeCamera', 'judgeDefects', 'judgeStaging', 'judgeNotes'];
  fs.writeFileSync(path.join(outDir, 'results.csv'), [cols.join(','), ...rows.map((r) => {
    const j = /** @type {Partial<JudgeEntry>} */ (judged[r.file] || {});
    return [r.file, r.roomType, r.attempts, r.selfDrift, r.seconds.toFixed(1), r.error, j.architecture_preserved, j.camera_preserved, j.defects, j.staging_quality, j.architecture_notes].map(csvCell).join(',');
  })].join('\n') + '\n');

  const cards = rows.map((r) => {
    const j = judged[r.file];
    const src = path.relative(outDir, path.join(opts.dir, r.file)).replace(/\\/g, '/');
    return `<section>
  <h2>${html(r.file)} <small>${html(r.roomType)} · attempts ${html(r.attempts)} · self-drift ${html(r.selfDrift)} · ${r.seconds.toFixed(1)}s</small></h2>
  <div class="pair"><figure><img src="${html(src)}" alt="source"><figcaption>source</figcaption></figure>${r.out ? `<figure><img src="${html(r.out)}" alt="staged"><figcaption>staged</figcaption></figure>` : `<p class="err">${html(r.error)}</p>`}</div>
  ${j ? `<p><b>Judge:</b> architecture ${j.architecture_preserved ? 'preserved' : '<span class="err">CHANGED</span>'} — ${html(j.architecture_notes)}; camera ${j.camera_preserved ? 'preserved' : '<span class="err">changed</span>'}</p>` : ''}
</section>`;
  }).join('\n');
  fs.writeFileSync(path.join(outDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Staging eval</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}img{width:100%;height:auto;display:block}figure{margin:0}figcaption{color:#666;font-size:12px}small{color:#666;font-weight:normal}.err{color:#b00}</style>
<h1>Staging eval</h1>${lines.map((l) => `<p>${html(l)}</p>`).join('')}
${cards}`);

  console.log(`\n${lines.join('\n')}\nReport: ${path.join(outDir, 'report.html')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
