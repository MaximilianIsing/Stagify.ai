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
// Measured 2026-07-28 over a green suite (1221/1221): lines 88.09% / branches
// 81.04% / functions 86.44%. Two consecutive runs agreed to within 0.03 points,
// so the margins below absorb Node-minor drift, not measurement noise.
//   lines     88.1 -> 85  (3.1 margin)
//   branches  81.0 -> 77  (4.0 margin — branches swing most between Node minors)
//   functions 86.4 -> 84  (2.4 margin — UNCHANGED on purpose: functions moved only
//                          86.0 -> 86.4 since 2026-07-10, so 84 was never stale)
// The wider margins vs. the original 2026-07-10 pass are deliberate: the numbers
// above were taken locally on Node 22.2, while CI enforces on Node 22-latest, and
// V8's line/branch attribution shifts slightly between minors.
//
// WHAT THESE FLOORS CANNOT SEE: V8 coverage only reports files the run actually
// loaded, so a frontend module no test ever imports contributes to NEITHER the
// numerator nor the denominator — it is invisible here, not averaged in. As of
// 2026-07-28 that is 68 of 107 files under public/scripts/. Raising these floors
// does not surface them; test/frontend/untested-frontend-modules.test.js is the
// guard that does, by pinning that set so it can only shrink.

import { spawn } from 'node:child_process';
import process from 'node:process';

const THRESHOLDS = { lines: 85, branches: 77, functions: 84 };

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
