// Runs the test suite with V8 line/branch/function coverage, then prints the
// coverage report with the test/ rows filtered out. Those rows (every
// `*.test.js` and the `test/helpers/*` files) are always ~100% — a test file is
// fully executed by definition — so they only pad the list and inflate the
// summary. Dropping them leaves just the product source rows, which are the
// ones with actionable gaps.
//
// Why a Node wrapper and not a shell pipe? `npm run` uses cmd.exe on Windows,
// where `grep` doesn't exist, so a piped filter would break locally. And Node's
// built-in `--test-coverage-exclude` flag only landed in 22.5.0 (this repo
// targets Node >=18). This wrapper is portable and forwards the child's exit
// code, so `npm run test:coverage` still fails when a test fails.

import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['--test', '--experimental-test-coverage', 'test/**/*.test.js'],
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
