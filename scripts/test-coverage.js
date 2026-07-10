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
// Floors are product-source coverage as of 2026-07-10 (lines 79.6% / branches
// 76.0% / functions 86.0%), rounded down 2-3 points to be a regression ratchet
// rather than a wall — branch coverage gets the wider margin because it swings
// most between runs and Node minors. Raise them as coverage improves; never
// lower them to make a red build pass.

import { spawn } from 'node:child_process';
import process from 'node:process';

const THRESHOLDS = { lines: 78, branches: 73, functions: 84 };

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
