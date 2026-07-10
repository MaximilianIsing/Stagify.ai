// Frontend type-check runner (see tsconfig.frontend.json for the why).
//
// There is no bundler: the browser loads the ES modules under public/scripts/
// directly. tsconfig include/exclude globs can't express "only the real ES
// modules" because ESM-ness is content-based, not path-based — so we reuse the
// SAME discovery ESLint uses (scripts/collect-esm-frontend.js) to build the file
// list, then hand it to tsc. Lint scope and type-check scope stay identical.
//
// tsc is pointed at a throwaway config written to the OS temp dir: it `extends`
// the committed tsconfig.frontend.json (all the compilerOptions) and supplies the
// discovered files as absolute paths. The temp name is unique per process, so
// several runs (e.g. concurrent CI jobs) never clobber each other, and it is
// removed afterwards — nothing is generated inside the repo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEsmFrontend } from './collect-esm-frontend.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(rootDir, 'public', 'scripts');

const files = collectEsmFrontend(scriptsDir, rootDir).map((rel) => path.join(rootDir, rel));
files.push(path.join(scriptsDir, 'globals.d.ts')); // ambient Window augmentation

const generated = path.join(os.tmpdir(), `stagify-frontend-tsconfig-${process.pid}.json`);
fs.writeFileSync(
  generated,
  JSON.stringify({ extends: path.join(rootDir, 'tsconfig.frontend.json'), files }, null, 2),
);

let status = 1;
try {
  const result = spawnSync('npx', ['tsc', '-p', generated], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  status = result.status ?? 1;
} finally {
  fs.rmSync(generated, { force: true });
}
process.exit(status);
