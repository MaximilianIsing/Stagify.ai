// The test suite runs from TWO places, and both must cap concurrency the same way.
//
// WHY THIS FILE EXISTS
// `--test-concurrency=4` is not a tuning preference; it is the fix for a real, measured
// flake. 17 specs bind a port with `app.listen(0)` and 8 spawn a whole `server.js`, and at
// the runner's default (one worker per CPU) that contention makes UNRELATED route specs fail
// with `fetch failed`. Measured on this machine: 5 failing runs in 20 at the default, 0 in 20
// at 4.
//
// It was added to `npm test` and MISSED on `scripts/test-coverage.js`, which is the runner CI
// uses to enforce the coverage floors. So the deploy gate was steady while the coverage job
// kept flaking on its own — two consecutive runs of that script, unchanged, gave 7 failures
// and then 0. A flag that lives in two spawn sites and matters in both is exactly the shape
// that drifts back, and the failure it causes does not look like a missing flag: it looks
// like an unrelated route test being broken.
//
// This guard therefore asserts the FLAG IS PRESENT IN BOTH, and that they agree on the value.
// It deliberately does not assert what the number is — 4 is a machine-sized choice and may be
// tuned — only that neither runner is left at the default while the other is capped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Source with `//` line comments stripped, so a flag NAMED in prose cannot satisfy a scan. */
function code(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const FLAG = /--test-concurrency=(\d+)/;

test('both test runners cap concurrency, and agree on the cap', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const script = String(pkg.scripts?.test || '');
  const coverage = code('scripts/test-coverage.js');

  const inScript = script.match(FLAG);
  const inCoverage = coverage.match(FLAG);

  assert.ok(inScript, `package.json "test" must cap concurrency, saw: ${script}`);
  assert.ok(inCoverage, 'scripts/test-coverage.js must pass --test-concurrency to its spawn');
  assert.equal(
    inScript[1],
    inCoverage[1],
    'the two runners must agree; a cap on one and the default on the other is the bug this guards',
  );
});

test('the coverage runner passes the flag to the RUNNER, not merely somewhere in the file', () => {
  // The mutation this kills: moving the flag out of the spawn argv while leaving the string
  // in the file. The scan above would still match; the child process would not receive it.
  const coverage = code('scripts/test-coverage.js');
  const spawnCall = coverage.slice(coverage.indexOf('spawn('));
  assert.ok(spawnCall.length > 0, 'the script still spawns a child');
  const argv = spawnCall.slice(0, spawnCall.indexOf(');'));
  assert.match(argv, FLAG, 'the flag must be inside the spawn arguments');
  assert.match(argv, /'--test'/, "sanity: this really is the runner's argv");
});
