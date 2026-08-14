// Step 1 of the 08-18 build: get ONE real photograph of a finished bathroom.
//
// Deliberately not acquirePair. That helper sources an EMPTY room and stages it, which is
// the wrong shape twice over: this post edits one surface of a room that is already
// finished, and it must not call processStaging at all, because a whole-photo restage is
// the exact thing the headline promises did not happen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagifyImages } from '../../../lib/images/stagify.js';
import { createStockSource } from '../../../lib/images/stock.js';
import { createFalClient } from '../../../lib/images/fal.js';
import { createAcquire, sha256 } from '../../../lib/images/acquire.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'instagram', 'config.json'), 'utf8'));

const stagify = createStagifyImages({ config });
const stock = createStockSource({ config });
const fal = createFalClient();
const acquire = createAcquire({ config, repoRoot: REPO_ROOT, stagify, stock, fal });

// Every source photo the account has already used, so we never republish one.
const usedHashes = new Set();
const ledger = path.join(REPO_ROOT, 'instagram', 'history', 'posts.jsonl');
for (const line of fs.readFileSync(ledger, 'utf8').trim().split('\n')) {
  for (const image of JSON.parse(line).images ?? []) if (image.sha256) usedHashes.add(image.sha256);
}

// The brief is much fussier than it looks, and every clause is a scar.
//
// The first photograph sourced for this post was a good bathroom and a bad subject: a large
// mirror and a vanity stood across the middle of the tiled wall, so the brushable area was
// not one shape but a set of narrow strips running between and around them. The model tiles
// a large open area cleanly and will not tile a thirty pixel strip, so it quietly left the
// original stone in the gaps, and the finished wall read as a mask artifact rather than a
// new tile. Three prompt rounds could not talk it out of that, because the problem was the
// geometry of the region, not the wording.
//
// So the wall this post needs is a large uninterrupted expanse with the fittings somewhere
// ELSE in the frame: the fittings still have to be present, since they are what the post
// proves went untouched, but they must not stand in front of the wall being changed.
const sourced = await acquire.acquireBefore({
  query: 'bathroom shower tiled wall',
  orientation: 'portrait',
  roomType: 'Bathroom',
  wants: 'A finished, furnished bathroom shot wide enough to read as a room. It must contain '
    + 'ONE large, continuous, mostly unobstructed expanse of wall tile, roughly square to the '
    + 'camera, with nothing large mounted on it: no big mirror, no vanity, no cabinet and no '
    + 'shower screen standing in front of that wall. Reject the photo if the main tiled wall '
    + 'is broken up into narrow strips by a mirror, a basin or joinery. Elsewhere in the frame '
    + 'it should still show real fittings such as a basin, a bath, a tap or a mirror, because '
    + 'those are what has to survive the edit unchanged. Reject empty or under-construction '
    + 'bathrooms and reject close-ups.',
  prompt: 'Photorealistic interior photograph of a finished bathroom, shot portrait, wide enough '
    + 'to show the whole room. One large flat tiled wall square to the camera, completely clear '
    + 'of mirrors and cabinets, with a basin and a tap off to one side against a different wall. '
    + 'Even daylight, no people.',
  usedHashes,
});

const stored = await acquire.store(sourced.buffer, sourced.mime);
fs.writeFileSync(path.join(HERE, 'source.json'), JSON.stringify({
  ...stored, origin: sourced.origin, license: sourced.license,
}, null, 2));

console.log(`origin   ${sourced.origin}`);
console.log(`sha256   ${sha256(sourced.buffer)}`);
console.log(`size     ${stored.width}x${stored.height}`);
console.log(`path     ${stored.path}`);
