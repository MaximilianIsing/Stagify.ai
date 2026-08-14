#!/usr/bin/env node
// Step 9. Put a finished post into history and refresh the ledger.
//
//   node instagram/bin/finalize.js 2026-08-15-some-slug
//   node instagram/bin/finalize.js 2026-08-15-some-slug --published
//   node instagram/bin/finalize.js --check
//
// This exists because the step it automates was prose in PLAYBOOK.md with no command behind
// it, and the very first post built after the tool was handed over got rendered and then left
// out of `posts.jsonl`. A post that is not in history is invisible to every cooldown, so the
// next run can rebuild it and the gate will report all clear.
//
// Run this before starting the next post. That is the whole rule, and it is what makes
// building several posts back to back safe: each one is checked against real history rather
// than against a guess.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appendPost, readPosts, refreshLedger, loadConfig, vocabularySizes } from '../lib/history/store.js';
import { buildLedger } from '../lib/history/cooldown.js';
import { loadTemplates } from '../lib/render/post.js';
import { checkCopy } from '../lib/validate/rules.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    published: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

const postsDir = path.join(REPO_ROOT, 'instagram', 'posts');

/** Every post folder on disk that is not in posts.jsonl. The drift this command exists for. */
function findOrphans() {
  const known = new Set(readPosts(REPO_ROOT).map((p) => p.id));
  if (!fs.existsSync(postsDir)) return [];
  return fs.readdirSync(postsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .filter((slug) => !known.has(slug))
    .filter((slug) => fs.existsSync(path.join(postsDir, slug, 'post.json')));
}

if (values.check) {
  const orphans = findOrphans();
  if (!orphans.length) {
    console.log(`History is current. ${readPosts(REPO_ROOT).length} posts, nothing unfinalized.`);
    process.exit(0);
  }
  console.log(`${orphans.length} rendered post(s) NOT in history:\n`);
  for (const slug of orphans) console.log(`  ${slug}`);
  console.log('\nThe ledger does not know about these, so the next run can rebuild them.');
  console.log(`Fix with: node instagram/bin/finalize.js ${orphans[0]}`);
  process.exit(1);
}

const slug = positionals[0];
if (!slug) {
  console.error('Pass a post slug, or --check to find unfinalized posts.');
  process.exit(1);
}

const dir = path.join(postsDir, slug);
const recordPath = path.join(dir, 'post.json');
if (!fs.existsSync(recordPath)) {
  console.error(`No post.json at ${path.relative(REPO_ROOT, recordPath)}`);
  process.exit(1);
}

const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const config = loadConfig(REPO_ROOT);
const templates = await loadTemplates(REPO_ROOT);

// layoutFamily is derived from the template, and a record missing it silently disables the
// dimension for that post, because buildLedger skips null values.
if (!record.layoutFamily) {
  const meta = templates.find((t) => t.meta.id === record.template)?.meta;
  if (!meta) {
    console.error(`Cannot derive layoutFamily: no template "${record.template}" on disk.`);
    process.exit(1);
  }
  record.layoutFamily = meta.layoutFamily;
  console.log(`Derived layoutFamily: ${record.layoutFamily}`);
}

// Instagram cannot show what was never posted, and metrics.js filters on publishedAt, so a
// record without it is invisible to the whole feedback loop.
if (values.published && !record.publishedAt) {
  record.publishedAt = new Date().toISOString();
}

const copy = checkCopy(record, config);
if (!copy.ok) {
  console.error('Copy checks failed:');
  for (const problem of copy.problems) console.error(`  ${problem}`);
  if (!values.force) {
    console.error('\nFix the copy, or pass --force to record it anyway.');
    process.exit(1);
  }
  console.error('\nRecording anyway (--force).');
}

const missing = ['template', 'layoutFamily', 'featureShown', 'hookArchetype', 'audience',
  'roomType', 'style', 'palette', 'ctaStyle', 'topic', 'visualSummary']
  .filter((key) => record[key] == null || record[key] === '');
if (missing.length) {
  console.error(`Record is missing cooldown fields: ${missing.join(', ')}`);
  console.error('Every one of these is a dimension the next run will be checked against.');
  process.exit(1);
}

fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
appendPost(REPO_ROOT, record);

const ledger = buildLedger(readPosts(REPO_ROOT), config, { vocabulary: vocabularySizes(REPO_ROOT, config) });
refreshLedger(REPO_ROOT);

console.log(`\nFinalized ${record.id}. History now holds ${ledger.count} posts.`);
console.log('\nThe next post is now blocked from:');
for (const [dimension, entry] of Object.entries(ledger.dimensions)) {
  const blocked = entry.blocked.filter((v) => entry.recency[v] === 0);
  if (blocked.length) console.log(`  ${dimension.padEnd(14)} ${blocked.join(', ')}`);
}
console.log(`\n${record.publishedAt ? '' : 'Not marked published. Rerun with --published once it is live, or metrics will never see it.\n'}`);
