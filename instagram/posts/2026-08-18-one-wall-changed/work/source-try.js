// Try several stock queries against the brief and SAY WHY each candidate was turned down.
// acquireBefore swallows its misses into one "none usable" line, which is the right shape
// for a pipeline and useless when the question is whether the query or the screen is at
// fault. fal is deliberately not wired up here: the point is to find a real photograph.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagifyImages } from '../../../lib/images/stagify.js';
import { createStockSource } from '../../../lib/images/stock.js';
import { sha256 } from '../../../lib/images/acquire.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));

const stagify = createStagifyImages({ config });
const stock = createStockSource({ config });

// Second attempt at the brief. The first one banned any fitting on the tiled wall at all
// and scored nought from thirty across five queries, with the model patiently explaining
// each time that there was a mirror, a basin or a screen in the way. It was right: real
// bathrooms put things on their walls, and demanding a bare one rules out the entire
// photographic record of the subject.
//
// The actual requirement was never "unobstructed". It is that the tile left visible around
// whatever is mounted there forms one broad shape rather than a set of narrow strips, since
// a narrow strip is the thing the model declines to retile. A big wall above a low bath, or
// beside a small mirror, satisfies that with fittings still in the frame.
const WANTS = 'A finished, furnished bathroom shot wide enough to read as a room. It must '
  + 'contain one BROAD area of wall tile: a continuous run of tiled wall at least a third of '
  + 'the width of the picture and about as tall, roughly square to the camera, in ONE piece. '
  + 'Fittings mounted on or standing against that wall are fine, and so are a bath, a basin, a '
  + 'small mirror or a shower head, as long as the tile still reads as one broad surface '
  + 'around them. Reject it only if that wall is cut into narrow strips or slivers of tile by a '
  + 'full width mirror, a run of joinery or a glass screen crossing it. It should also show '
  + 'real fittings somewhere in the frame, because those are what has to survive unchanged. '
  + 'Reject empty or under-construction bathrooms, and reject close-ups of tile or fixtures.';

const QUERIES = [
  'bathroom bathtub tiled wall',
  'bathroom interior bathtub window',
  'modern bathroom interior design',
  'bathroom shower tiled wall',
  'minimalist bathroom interior',
];

const used = new Set();
for (const line of fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'history', 'posts.jsonl'), 'utf8').trim().split('\n')) {
  for (const image of JSON.parse(line).images ?? []) if (image.sha256) used.add(image.sha256);
}

const passes = [];
for (const query of QUERIES) {
  let candidates = [];
  try {
    candidates = await stock.search(query, { orientation: 'portrait' });
  } catch (error) {
    console.log(`\n## ${query}\n  search failed: ${error.message}`);
    continue;
  }
  console.log(`\n## ${query}  (${candidates.length} candidates)`);

  for (const candidate of candidates.slice(0, 6)) {
    let got;
    try {
      got = await stock.download(candidate);
    } catch (error) {
      console.log(`  ${candidate.id}: download failed, ${error.message}`);
      continue;
    }
    const hash = sha256(got.buffer);
    if (used.has(hash)) { console.log(`  ${candidate.id}: already used in an earlier post`); continue; }

    const gate = await stagify.validateSource(got.buffer).catch(() => null);
    if (gate && gate.stageable === false) {
      console.log(`  ${candidate.id}: upload gate rejected (${gate.category ?? '?'})`);
      continue;
    }
    const fit = await stagify.fitsBrief(got.buffer, { roomType: 'Bathroom', wants: WANTS })
      .catch((error) => ({ ok: false, reason: error.message }));
    console.log(`  ${candidate.id}: ${fit.ok ? 'PASS' : 'no'} ${fit.reason}`);
    if (!fit.ok) continue;

    const file = path.join(HERE, `cand-${candidate.id}.jpg`);
    fs.writeFileSync(file, got.buffer);
    passes.push({ id: candidate.id, hash, file, license: got.license, provider: got.provider });
  }
  if (passes.length >= 3) break;
}

fs.writeFileSync(path.join(HERE, 'candidates.json'), JSON.stringify(passes, null, 2));
console.log(`\n${passes.length} candidate(s) passed: ${passes.map((p) => p.id).join(', ')}`);
