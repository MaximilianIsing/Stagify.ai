#!/usr/bin/env node
// The uniqueness gate, as a command.
//
//   node instagram/bin/check.js candidate.json          one candidate, or an array of them
//   node instagram/bin/check.js --available             what dimension values are open today
//   node instagram/bin/check.js candidates.json --json  machine-readable, for an agent to read
//
// Exits 1 if any candidate is blocked, so the pipeline cannot proceed past it by accident.
// This is the difference between a rule and a suggestion.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildLedger, rankCandidates } from '../lib/history/cooldown.js';
import {
  readPosts, loadConfig, availableDimensions, vocabularySizes, withLayoutFamily,
} from '../lib/history/store.js';
import { loadTemplates } from '../lib/render/post.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    available: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const config = loadConfig(REPO_ROOT);
const posts = readPosts(REPO_ROOT);
const ledger = buildLedger(posts, config, { vocabulary: vocabularySizes(REPO_ROOT, config) });

for (const c of ledger.clampedWindows) {
  console.error(
    `note: cooldowns.hard.${c.dimension} is ${c.from} but only ${c.vocabulary} value(s) exist, `
    + `so it was clamped to ${c.to}. Fix config.json or add more values.`,
  );
}

const templates = await loadTemplates(REPO_ROOT);

function templateIds() {
  return templates.map((t) => t.meta.id).sort();
}

if (values.available) {
  const open = availableDimensions(ledger, config);
  const blockedTemplates = new Set(ledger.dimensions.template?.blocked ?? []);
  const all = templateIds();
  open.template = {
    available: all.filter((t) => !blockedTemplates.has(t)),
    blocked: all.filter((t) => blockedTemplates.has(t)),
  };

  if (values.json) {
    console.log(JSON.stringify({ postsInHistory: posts.length, dimensions: open }, null, 2));
  } else {
    console.log(`History: ${posts.length} posts\n`);
    for (const [dimension, { available, blocked }] of Object.entries(open)) {
      console.log(`${dimension}`);
      console.log(`  open:    ${available.length ? available.join(', ') : '(nothing, every value is on cooldown)'}`);
      if (blocked.length) console.log(`  blocked: ${blocked.join(', ')}`);
    }
  }
  process.exit(0);
}

const file = positionals[0];
if (!file) {
  console.error('Pass a candidate JSON file, or --available to see what is open.');
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, file), 'utf8'));
// layoutFamily is derived from the chosen template, never declared on the candidate.
const candidates = withLayoutFamily(Array.isArray(parsed) ? parsed : [parsed], templates);
const ranked = rankCandidates(candidates, ledger, config);

if (values.json) {
  console.log(JSON.stringify(ranked.map(({ candidate, result }) => ({
    id: candidate.id ?? null, ...result,
  })), null, 2));
} else {
  for (const { candidate, result } of ranked) {
    const name = candidate.id ?? candidate.topic ?? '(unnamed)';
    console.log(`${result.ok ? 'PASS' : 'BLOCKED'}  ${name}  novelty ${result.noveltyScore}`);
    for (const v of result.violations) console.log(`    ${v.dimension}: ${v.detail}`);
    for (const w of result.warnings) console.log(`    warn ${w.dimension}: ${w.detail}`);
  }
  const passed = ranked.filter((r) => r.result.ok).length;
  console.log(`\n${passed} of ${ranked.length} candidates are clear.`);
}

process.exit(ranked.every((r) => r.result.ok) ? 0 : 1);
