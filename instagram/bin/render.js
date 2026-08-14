#!/usr/bin/env node
// Render a post record to files.
//
//   node instagram/bin/render.js --record instagram/posts/2026-08-13-slug/post.json
//   node instagram/bin/render.js --fixture instagram/fixtures/diagonal-reveal.json
//   node instagram/bin/render.js --fixture <f> --formats single,story --out /tmp/x
//
// Run from anywhere; paths in the record are repo-root-relative URLs, not disk paths.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRenderer } from '../lib/render/capture.js';
import { renderPost } from '../lib/render/post.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values } = parseArgs({
  options: {
    record: { type: 'string' },
    fixture: { type: 'string' },
    out: { type: 'string' },
    formats: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const source = values.record ?? values.fixture;
if (!source) {
  console.error('Pass --record <post.json> or --fixture <file.json>');
  process.exit(1);
}

const recordPath = path.resolve(REPO_ROOT, source);
const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));

// A record renders next to itself; a fixture renders into a scratch directory so trying
// something out never dirties a real post folder.
const outDir = values.out
  ? path.resolve(REPO_ROOT, values.out)
  : values.record
    ? path.dirname(recordPath)
    : path.join(REPO_ROOT, 'instagram', 'posts', '_scratch', record.id ?? 'fixture');

const formats = values.formats ? values.formats.split(',').map((s) => s.trim()) : undefined;

const started = Date.now();
const renderer = await createRenderer({ rootDir: REPO_ROOT, headless: !values.headed });
try {
  const { files, formats: done } = await renderPost(record, {
    repoRoot: REPO_ROOT, outDir, renderer, formats,
  });
  console.log(`Rendered ${record.template} [${done.join(', ')}] in ${Date.now() - started} ms`);
  for (const file of files) console.log(`  ${path.relative(REPO_ROOT, file)}`);
} finally {
  await renderer.close();
}
