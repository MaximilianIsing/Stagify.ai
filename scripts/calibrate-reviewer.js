#!/usr/bin/env node
// Calibrate the staging reviewer's ARCHITECTURE verdict against labelled examples.
//
// The reviewer (reviewImageQuality with a source photo, lib/image/image-review.js) is the only
// thing between a render that moved a wall and the user. This measures how often it catches a
// known-drifted render (recall) and how often it wrongly flags a clean one (false positives —
// each one costs a regeneration), under different judge models and thinking settings, so the
// choice in lib/config/model-config.js is a measurement rather than a guess.
//
//   node scripts/calibrate-reviewer.js --run <eval-run-dir> [--run <dir> …] [--labels <file>]
//                                      [--configs <name,name>] [--concurrency n]
//
// Labels come from `scripts/eval-staging.js --judge` runs (results.json + judge.json:
// drifted = !architecture_preserved) and/or a labels file:
//   { "items": [{ "source": "<path>", "output": "<path>", "roomType": "Bedroom", "drifted": true }] }
//
// Every config runs the REAL reviewImageQuality (same prompt, same parsing); only the grader
// model and its thinking setting are swapped, by wrapping the Gemini client. COSTS MONEY:
// one grader call per item per config.
import '../load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createGeminiClient } from '../lib/services/gemini-client.js';
import { createImageReview } from '../lib/image/image-review.js';
import { STAGING_GRADER_MODEL, STAGING_GRADER_THINKING } from '../lib/config/model-config.js';

// Candidate reviewer configs. `thinking` is either a 2.5-style token budget or a 3.x level.
/** @type {Record<string, { model: string, thinking: { thinkingBudget: number } | { thinkingLevel: string } }>} */
const CONFIGS = {
  'current': { model: STAGING_GRADER_MODEL, thinking: { ...STAGING_GRADER_THINKING } },
  '3.8-flash-minimal': { model: 'gemini-3.8-flash', thinking: { thinkingLevel: 'minimal' } },
  '2.5-flash-2048': { model: 'gemini-2.5-flash', thinking: { thinkingBudget: 2048 } },
  '2.5-pro-128': { model: 'gemini-2.5-pro', thinking: { thinkingBudget: 128 } },
  '3.8-flash-low': { model: 'gemini-3.8-flash', thinking: { thinkingLevel: 'low' } },
  '3.8-flash-high': { model: 'gemini-3.8-flash', thinking: { thinkingLevel: 'high' } },
  '3.5-flash-low': { model: 'gemini-3.5-flash', thinking: { thinkingLevel: 'low' } },
};

function parseArgs(argv) {
  /** @type {{ runs: string[], labels: string[], configs: string[], concurrency: number }} */
  const o = { runs: [], labels: [], configs: Object.keys(CONFIGS), concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.runs.push(argv[++i]);
    else if (a === '--labels') o.labels.push(argv[++i]);
    else if (a === '--configs') o.configs = argv[++i].split(',');
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Labelled items from an eval-staging run folder. */
function itemsFromRun(dir) {
  const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const judge = JSON.parse(fs.readFileSync(path.join(dir, 'judge.json'), 'utf8'));
  return results.rows.filter((r) => r.out && judge[r.file]).map((r) => ({
    source: path.join(results.photos, r.file),
    output: path.join(dir, r.out),
    roomType: r.roomType,
    drifted: !judge[r.file].architecture_preserved,
    note: judge[r.file].architecture_notes,
  }));
}

async function toDataUrl(file) {
  const buf = await sharp(file).rotate().jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function pool(items, n, worker) {
  const queue = items.map((x, i) => [x, i]);
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const [x, i] = /** @type {[any, number]} */ (queue.shift());
      await worker(x, i);
    }
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  /** @type {{ source: string, output: string, roomType: string, drifted: boolean, note?: string }[]} */
  const items = [];
  for (const d of opts.runs) items.push(...itemsFromRun(d));
  for (const f of opts.labels) items.push(...JSON.parse(fs.readFileSync(f, 'utf8')).items);
  if (!items.length) {
    console.error('usage: node scripts/calibrate-reviewer.js --run <eval-run-dir> [--labels <file>] [--configs a,b] [--concurrency n]');
    process.exit(1);
  }
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) { console.error('GOOGLE_AI_API_KEY is not set.'); process.exit(1); }
  const realAI = createGeminiClient(apiKey, { timeoutMs: 180_000, attempts: 2 });

  const drifted = items.filter((x) => x.drifted).length;
  console.log(`${items.length} labelled pairs (${drifted} drifted, ${items.length - drifted} preserved)\n`);
  const urls = await Promise.all(items.map(async (x) => ({ src: await toDataUrl(x.source), out: await toDataUrl(x.output) })));

  for (const name of opts.configs) {
    const cfg = CONFIGS[name];
    if (!cfg) throw new Error(`unknown config ${name}`);
    // Swap only the comparative grader: the reviewer asks for STAGING_GRADER_MODEL when a
    // source is attached. The thinking budget it adds on top of maxOutputTokens is kept for
    // 2.5-style budgets; a 3.x thinking LEVEL has no fixed size, so the ceiling is raised.
    const genAI = {
      getGenerativeModel: (o) => (o.model !== STAGING_GRADER_MODEL ? realAI.getGenerativeModel(o) : realAI.getGenerativeModel({
        ...o,
        model: cfg.model,
        generationConfig: {
          ...o.generationConfig,
          thinkingConfig: cfg.thinking,
          maxOutputTokens: 'thinkingBudget' in cfg.thinking ? 300 + cfg.thinking.thinkingBudget : 8192,
        },
      })),
    };
    const { reviewImageQuality } = createImageReview({ genAI });
    /** @type {{ flagged: boolean | undefined, ms: number, degraded: boolean }[]} */
    const res = new Array(items.length);
    await pool(items, opts.concurrency, async (x, i) => {
      const t = Date.now();
      const v = await reviewImageQuality(urls[i].out, {
        sourceDataUrl: urls[i].src, roomType: x.roomType, instruction: `Stage this ${x.roomType} professionally`,
      });
      res[i] = { flagged: v.architectureDrift, ms: Date.now() - t, degraded: !!v.degraded };
    });
    const tp = items.filter((x, i) => x.drifted && res[i].flagged === true).length;
    const fp = items.filter((x, i) => !x.drifted && res[i].flagged === true).length;
    const unknown = res.filter((r) => r.flagged === undefined).length;
    const degraded = res.filter((r) => r.degraded).length;
    const ms = res.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`${name.padEnd(16)} recall ${tp}/${drifted}  false-pos ${fp}/${items.length - drifted}  unknown ${unknown}  errors ${degraded}  median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)}s  p90 ${(ms[Math.floor(ms.length * 0.9)] / 1000).toFixed(1)}s`);
    const missed = items.filter((x, i) => x.drifted && res[i].flagged !== true).map((x) => path.basename(x.output));
    if (missed.length) console.log(`${''.padEnd(16)} missed: ${missed.join(', ')}`);
    // Worth eyeballing: a "false" alarm is sometimes drift the labelling judge itself missed.
    const falseAlarms = items.filter((x, i) => !x.drifted && res[i].flagged === true).map((x) => path.relative(process.cwd(), x.output));
    if (falseAlarms.length) console.log(`${''.padEnd(16)} false alarms: ${falseAlarms.join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
