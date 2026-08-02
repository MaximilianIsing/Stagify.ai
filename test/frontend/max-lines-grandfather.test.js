// The max-lines grandfather list in eslint.config.js only ever shrinks.
//
// WHY THIS EXISTS: the list carries a line count per file, and those counts had gone
// stale by up to 300 lines. That is not a cosmetic drift — it re-opened the very
// ratchet the block exists to enforce. One listed file had already been split back
// under the global 650-line cap, but its entry was never deleted, so it stayed
// licensed to grow to 850 with nothing failing. The block's own comment says to
// "delete its entry here so the global 650 cap applies"; nothing checked that anyone
// did.
//
// Two failure modes, both covered:
//   - a listed file drops under the global cap  → delist it (the ratchet tightens)
//   - the recorded count drifts from reality    → correct it (so the next reader can
//                                                 trust the list at a glance)
//
// Modelled on test/frontend/untested-frontend-modules.test.js, which does the same
// shrink-only job for the untested-module ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(rootDir, 'eslint.config.js');

/**
 * The two caps that matter here, each read from ITS OWN block.
 *
 * The config carries four max-lines rules (backend, test, frontend, grandfather), so
 * a whole-file scan picks up the wrong pair — min/max across all of them happened to
 * look plausible while measuring something else entirely.
 */
function readCaps(src) {
  // There are TWO "// Grandfathered:" blocks — the backend one (cap 800) comes
  // first. Anchor on the frontend block and search forward from there, or the guard
  // measures the backend ratchet while claiming to measure the frontend one.
  const frontendAt = src.indexOf('files: frontendEsmFiles');
  assert.ok(frontendAt !== -1, 'the frontend block moved — update this guard');
  const grandfatherAt = src.indexOf('// Grandfathered:', frontendAt);
  assert.ok(grandfatherAt !== -1, 'the frontend grandfather block moved — update this guard');

  const capIn = (slice, label) => {
    const m = slice.match(/'max-lines':\s*\['error',\s*(\d+)\]/);
    assert.ok(m, `no max-lines rule in the ${label} block`);
    return Number(m[1]);
  };
  return {
    globalCap: capIn(src.slice(frontendAt, grandfatherAt), 'frontend'),
    grandfatherCap: capIn(src.slice(grandfatherAt), 'grandfather'),
  };
}

/**
 * The grandfathered entries with their RECORDED counts.
 * Deliberately parses the trailing `// <n>` comment: that number is the claim being
 * checked, so it has to be read from the same line the path is on.
 */
function readGrandfathered(src) {
  // Same anchoring rule as readCaps: start from the FRONTEND grandfather block.
  const block = src.slice(src.indexOf('// Grandfathered:', src.indexOf('files: frontendEsmFiles')));
  const entries = [...block.matchAll(/'(public\/scripts\/[^']+)',\s*\/\/\s*(\d+)/g)]
    .map((m) => ({ file: m[1], recorded: Number(m[2]) }));
  assert.ok(entries.length > 0, 'found no grandfathered entries — has the block moved?');
  return entries;
}

const src = fs.readFileSync(configPath, 'utf8');
const { globalCap, grandfatherCap } = readCaps(src);
const entries = readGrandfathered(src);

test('the parse found a real list (self-test — otherwise everything below is vacuous)', () => {
  assert.ok(globalCap >= 100 && globalCap < grandfatherCap, `caps look wrong: ${globalCap} / ${grandfatherCap}`);
  assert.ok(entries.length >= 1);
  for (const { file, recorded } of entries) {
    assert.ok(fs.existsSync(path.join(rootDir, file)), `${file} is listed but does not exist — delist it`);
    assert.ok(Number.isInteger(recorded) && recorded > 0, `${file} has no recorded line count`);
  }
});

for (const { file, recorded } of entries) {
  test(`grandfathered entry is still earned and still accurate: ${file}`, () => {
    const actual = fs.readFileSync(path.join(rootDir, file), 'utf8').split('\n').length;

    assert.ok(
      actual > globalCap,
      `${file} is now ${actual} lines, under the global ${globalCap} cap — delete its entry from the `
        + 'grandfather block in eslint.config.js so the global cap applies again.',
    );
    assert.ok(
      actual <= grandfatherCap,
      `${file} is ${actual} lines, over the ${grandfatherCap} grandfathered cap — split it, do not raise the cap.`,
    );
    // Tolerance, not equality: the count is a signpost, and demanding an exact match
    // would turn every one-line edit into a config change. Anything past this is
    // drift worth correcting.
    assert.ok(
      Math.abs(actual - recorded) <= 25,
      `${file} records ~${recorded} lines but is ${actual} — update the comment in eslint.config.js.`,
    );
  });
}

test('the list only shrinks: no file may be added without shrinking another', () => {
  // A bare count, so growing the list is a deliberate act that fails here first.
  assert.ok(
    entries.length <= 3,
    `the grandfather list has grown to ${entries.length} entries (${entries.map((e) => e.file).join(', ')}). `
      + 'New oversized modules must be split into islands, not grandfathered.',
  );
});
