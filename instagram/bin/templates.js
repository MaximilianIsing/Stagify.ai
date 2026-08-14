#!/usr/bin/env node
// Browse and smoke test the template library.
//
//   node instagram/bin/templates.js --list            what exists, and what each is for
//   node instagram/bin/templates.js --list --json     same, for an agent to read
//   node instagram/bin/templates.js --smoke           render every template from fixtures
//   node instagram/bin/templates.js --smoke --only stat-card
//
// --smoke needs no keys and no network: it renders against repo media. It is the check that
// catches a template which throws, overflows its frame, or paints a blank poster, and it is
// the thing to run after touching anything in templates/ or _macros.js.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createRenderer } from '../lib/render/capture.js';
import { loadTemplates, renderPost } from '../lib/render/post.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'instagram', 'fixtures', 'smoke.json');
const OUT = path.join(REPO_ROOT, 'instagram', 'posts', '_scratch', 'smoke');

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const templates = await loadTemplates(REPO_ROOT);

if (values.list || (!values.smoke)) {
  if (values.json) {
    console.log(JSON.stringify(templates.map((t) => t.meta), null, 2));
  } else {
    console.log(`${templates.length} templates\n`);
    for (const { meta } of templates) {
      console.log(`${meta.id}  [${meta.formats.join(', ')}]  family: ${meta.layoutFamily}`);
      console.log(`  ${meta.description}`);
      console.log(`  best for: ${meta.bestFor}`);
      if (meta.slides) console.log(`  slides: ${meta.slides[0]} to ${meta.slides[1]}`);
      console.log('');
    }
  }
  process.exit(0);
}

const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
const wanted = values.only
  ? templates.filter((t) => t.meta.id === values.only)
  : templates;

if (!wanted.length) {
  console.error(`No template matched --only ${values.only}`);
  process.exit(1);
}

const missing = wanted.filter((t) => !fixtures[t.meta.id]).map((t) => t.meta.id);
if (missing.length) {
  console.error(`No fixture for: ${missing.join(', ')}. Add one to fixtures/smoke.json.`);
  process.exit(1);
}

if (!values.keep) fs.rmSync(OUT, { recursive: true, force: true });

const renderer = await createRenderer({ rootDir: REPO_ROOT });
const failures = [];
let rendered = 0;

try {
  for (const { meta } of wanted) {
    const data = fixtures[meta.id];
    for (const format of meta.formats) {
      // The reel format is a frame sequence, not a still. reel.js covers it.
      if (format === 'reel') continue;
      const label = `${meta.id} ${format}`;
      try {
        const { files } = await renderPost(
          { id: `${meta.id}-${format}`, template: meta.id, formats: [format], data },
          { repoRoot: REPO_ROOT, outDir: path.join(OUT, meta.id, format), renderer, formats: [format] },
        );

        // A template that throws is easy to notice. One that renders a flat field of brand
        // blue is not, and it looks deliberate. Check the output actually has an image in it.
        for (const file of files.filter((f) => f.endsWith('.jpg') && !f.endsWith('thumb.jpg'))) {
          const { channels } = await sharp(file).stats();
          const flat = channels.every((c) => c.stdev < 6);
          if (flat) throw new Error('output is nearly a single flat colour, so it probably painted nothing');
        }

        rendered += 1;
        console.log(`  ok    ${label}`);
      } catch (error) {
        failures.push({ label, message: error.message.split('\n')[0] });
        console.log(`  FAIL  ${label}`);
      }
    }
  }
} finally {
  await renderer.close();
}

console.log(`\n${rendered} rendered, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f.label}: ${f.message}`);
console.log(`\nOutput: ${path.relative(REPO_ROOT, OUT)}`);
process.exitCode = failures.length ? 1 : 0;
