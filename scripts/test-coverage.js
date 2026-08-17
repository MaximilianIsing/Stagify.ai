// Runs the test suite with V8 line/branch/function coverage, then prints the
// coverage report with the test/ rows filtered out. Those rows (every
// `*.test.js` and the `test/helpers/*` files) are always ~100% — a test file is
// fully executed by definition — so they only pad the list and inflate the
// summary. Dropping them leaves just the product source rows, which are the
// ones with actionable gaps.
//
// Why a Node wrapper and not a shell pipe? `npm run` uses cmd.exe on Windows,
// where `grep` doesn't exist, so a piped filter would break locally. This
// wrapper is portable and forwards the child's exit code, so it still fails
// when a test fails — or, on new enough Node, when coverage dips below the
// floors below.
//
// Enforcement: Node gained per-run coverage thresholds in 22.8.0 and
// `--test-coverage-exclude` in 22.5.0. When the running Node supports them we
// pass both, so the aggregate Node checks is product source ONLY (test files
// excluded from the math, not just the printout) and the process exits non-zero
// if any metric is under its floor. On older Node we skip enforcement and just
// print — CI pins Node 22 (`.node-version`), which setup-node resolves to the
// latest 22.x (>= 22.8.0), so the gate always holds there.
//
// Floors are product-source coverage rounded down a few points, so they act as a
// regression ratchet rather than a wall. Raise them as coverage improves; never
// lower them to make a red build pass.
//
// Measured 2026-08-08 over a green suite (2965/2965): lines 88.51% / branches
// 84.07% / functions 85.77%. Two consecutive runs agreed to within 0.04 points,
// so the margins below absorb Node-minor drift, not measurement noise.
//   lines     88.5 -> 85  (3.5 margin)
//   branches  84.1 -> 80  (4.1 margin — branches swing most between Node minors.
//                          RAISED from 77: branches gained 3 points when the
//                          fifteen island suites landed, and the margin is kept
//                          at the same ~4 points it was originally chosen with)
//   functions 85.8 -> 84  (1.8 margin — deliberately NOT raised; see below)
// The wider margins vs. the original 2026-07-10 pass are deliberate: the numbers
// above were taken locally on Node 22.2, while CI enforces on Node 22-latest, and
// V8's line/branch attribution shifts slightly between minors.
//
// WHY FUNCTIONS WENT DOWN (86.4 -> 85.8) WHILE THE SUITE GREW: these are ratios
// over the files the run LOADS, and the 2026-08-08 pass added suites for fifteen
// island factories that no test had imported before. Each brought its whole
// function count into the denominator, not just the parts under test. A falling
// percentage here therefore means MORE code is measured, not that less is tested —
// which is exactly why the untested ledger, not these floors, is what tracks
// coverage breadth.
//
// WHAT THESE FLOORS CANNOT SEE: V8 coverage only reports files the run actually
// loaded, so a frontend module no test ever imports contributes to NEITHER the
// numerator nor the denominator — it is invisible here, not averaged in. That is
// currently 38 of 169 non-vendor files under public/scripts/ (21 untested, 8 covered
// only by the Playwright suite, 9 classic scripts node cannot import). Raising
// these floors does not surface them; test/frontend/untested-frontend-modules.test.js
// is the guard that does, by pinning that set so it can only shrink.

import { spawn } from 'node:child_process';
import process from 'node:process';

const THRESHOLDS = { lines: 85, branches: 80, functions: 84 };

const [major, minor] = process.versions.node.split('.').map(Number);
const canEnforce = major > 22 || (major === 22 && minor >= 8);

const enforceArgs = canEnforce
  ? [
      '--test-coverage-exclude=test/**',
      `--test-coverage-lines=${THRESHOLDS.lines}`,
      `--test-coverage-branches=${THRESHOLDS.branches}`,
      `--test-coverage-functions=${THRESHOLDS.functions}`,
    ]
  : [];

if (!canEnforce) {
  process.stderr.write(
    `[test-coverage] Node ${process.versions.node} < 22.8.0: printing the report ` +
      'without enforcing coverage floors (CI enforces on Node 22-latest).\n',
  );
}

const child = spawn(
  process.execPath,
  ['--test', '--experimental-test-coverage', ...enforceArgs, 'test/**/*.test.js'],
  { stdio: ['inherit', 'pipe', 'inherit'] },
);

// A coverage table row is `<prefix> <path> | num | num | num | ...`. Treat it as
// a test-file row when the file column (everything before the first `|`) names
// something under the test/ directory — this catches both `test\foo.test.js` and
// `test\helpers\bar.js`, on either path separator.
const isTestRow = (line) => {
  const bar = line.indexOf('|');
  if (bar === -1) return false;
  return /(^|[\s#ℹ\\/])test[\\/]/.test(line.slice(0, bar));
};

let pending = '';
child.stdout.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (!isTestRow(line)) process.stdout.write(`${line}\n`);
  }
});

child.on('close', (code) => {
  if (pending && !isTestRow(pending)) process.stdout.write(pending);
  process.exit(code ?? 0);
});
