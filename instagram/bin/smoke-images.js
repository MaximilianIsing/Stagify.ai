#!/usr/bin/env node
// Proves the image chain end to end with real API calls, without building a post.
//
//   node instagram/bin/smoke-images.js
//   node instagram/bin/smoke-images.js --room "Bedroom" --style scandinavian
//
// Costs a couple of Gemini calls. Run it after changing anything in lib/images/, and after
// adding a new key, to see which sources actually came alive.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStagifyImages } from '../lib/images/stagify.js';
import { createFalClient } from '../lib/images/fal.js';
import { createStockSource } from '../lib/images/stock.js';
import { createAcquire } from '../lib/images/acquire.js';
import { loadConfig } from '../lib/history/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values } = parseArgs({
  options: {
    room: { type: 'string', default: 'Living room' },
    style: { type: 'string', default: 'coastal' },
    query: { type: 'string' },
  },
});

const config = loadConfig(REPO_ROOT);
const stagify = createStagifyImages({ config });
const fal = createFalClient();
const stock = createStockSource({ config });
const acquire = createAcquire({ config, repoRoot: REPO_ROOT, stagify, stock, fal });

console.log('Sources:');
console.log(`  gemini   ${stagify.available.gemini ? 'ready' : 'MISSING GOOGLE_AI_API_KEY'}`);
console.log(`  openai   ${stagify.available.openai ? 'ready' : 'MISSING GPT_KEY (alt text degrades)'}`);
console.log(`  fal      ${fal ? 'ready' : 'disabled, no FAL_KEY'}`);
console.log(`  pexels   ${stock.available.pexels ? 'ready' : 'disabled, no PEXELS_API_KEY'}`);
console.log(`  unsplash ${stock.available.unsplash ? 'ready' : 'disabled, no UNSPLASH_ACCESS_KEY'}`);

const room = values.room;
const query = values.query ?? `empty unfurnished ${room.toLowerCase()} interior daylight`;
const prompt = `A photorealistic estate agent photograph of a completely empty, unfurnished ${room.toLowerCase()}. `
  + 'Bare floors, blank walls, natural daylight from a window, no furniture, no rugs, no artwork, no people. '
  + 'Shot straight on with a wide lens at chest height, neutral white balance, sharp focus throughout.';

console.log(`\nAcquiring a "before" for ${room} ...`);
const started = Date.now();
const pair = await acquire.acquirePair({
  query, prompt, roomType: room, style: values.style, orientation: 'portrait',
});

console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const [role, asset] of [['before', pair.before], ['after', pair.after]]) {
  console.log(`  ${role.padEnd(6)} ${asset.origin.padEnd(8)} ${asset.width}x${asset.height}  `
    + `${(asset.bytes / 1024).toFixed(0)} KB  ${asset.url}`);
}
console.log('\nProvenance:');
for (const entry of pair.provenance) {
  console.log(`  ${entry.role.padEnd(6)} ${entry.source.padEnd(8)} ${entry.license.licenseName}`);
  if (entry.license.photographer) console.log(`         by ${entry.license.photographer}, ${entry.license.sourceUrl}`);
}

const q = pair.quality;
console.log('\nQuality:');
console.log(`  reviewer verdict : ${q.perfect ? 'PASSED' : 'NEVER PASSED'}`);
console.log(`  best score       : ${q.bestScore ?? 'n/a'} over ${q.attempts} review(s)`);
console.log(`  source photos    : ${q.sourcePhotosTried} tried, kept number ${q.keptAttempt}`);
if (!q.perfect && q.defects.length) {
  console.log('  flagged:');
  for (const defect of [...new Set(q.defects)]) console.log(`    ${defect.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  console.log('\n  This render would go into a public post. Look at it before shipping it.');
}
