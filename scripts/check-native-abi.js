// Preflight for `npm start` / `npm run dev` / `npm test` (wired in as prestart/predev/pretest).
//
// WHY: better-sqlite3 is the only non-N-API native dependency in the tree, so its compiled
// `better_sqlite3.node` is locked to one Node ABI (`process.versions.modules`). This machine has
// two Node installs — the fnm-managed 22.23.1 that .node-version pins (and that CI and Render
// use), and a system Node 24 that any shell WITHOUT the fnm hook resolves to. An `npm install`
// from the wrong one rebuilds the binary for the wrong ABI, and the next `npm start` dies with
//   ERR_DLOPEN_FAILED … compiled against … NODE_MODULE_VERSION 137 … requires 127
// before a single line of the app runs. This heals that automatically instead of making it a
// manual `npm rebuild` every time.
//
// It runs BENEATH the app, like load-env.js, so it must not import lib/logger.js. Raw console.*
// is the intended output here (scripts/** has `no-console: 'off'` — see eslint.config.js).
//
// The happy path is a silent module load costing a few tens of milliseconds, and it is skipped
// entirely on Render/CI, where install and run always share one Node.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorCode, errorMessage } from '../lib/errors.js';

const thisFile = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(thisFile), '..');

/** The native dependency this guards. The only one in the tree with a version-locked ABI. */
export const NATIVE_MODULE = 'better-sqlite3';

/**
 * True only for the ABI-mismatch flavour of a failed native load. Anything else — a missing
 * module, a corrupt binary, a throwing side effect — is NOT something a rebuild should paper
 * over, so it is rethrown untouched.
 * @param {unknown} err
 */
export function isAbiMismatch(err) {
  return errorCode(err) === 'ERR_DLOPEN_FAILED'
    && /NODE_MODULE_VERSION/.test(errorMessage(err));
}

/**
 * Pulls the two ABI numbers out of Node's message. Its wording is
 *   "…compiled against a different Node.js version using NODE_MODULE_VERSION <compiled>.
 *    This version of Node.js requires NODE_MODULE_VERSION <required>."
 * so the first occurrence is what the binary was built for and the second is what we are running.
 * Returns nulls rather than throwing if the wording ever changes — the numbers are for the
 * diagnostic line only, never for control flow.
 * @param {unknown} message
 */
export function parseAbiVersions(message) {
  const found = String(message ?? '').match(/NODE_MODULE_VERSION (\d+)/g) ?? [];
  const numbers = found.map((m) => Number(m.replace(/\D+/g, '')));
  return { compiled: numbers[0] ?? null, required: numbers[1] ?? null };
}

/** The repo's pinned Node version — .node-version is the single source of truth (CI + Render). */
export function readPinnedNodeVersion(dir = rootDir) {
  try {
    return fs.readFileSync(path.join(dir, '.node-version'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Normalises "v22.23.1" / "22.23.1" so the two can be compared.
 * @param {string | null | undefined} running
 * @param {string | null | undefined} pinned
 */
export function sameNodeVersion(running, pinned) {
  if (!running || !pinned) return true; // nothing to compare — don't cry wolf
  return running.replace(/^v/, '') === pinned.replace(/^v/, '');
}

/**
 * Requiring better-sqlite3 is NOT enough: it resolves its `.node` binary lazily, inside the
 * Database constructor (lib/database.js), so the bad dlopen only happens when a connection is
 * opened — which is exactly why the crash surfaces mid-boot in lib/data/db.js rather than at
 * import time. Opening an in-memory database forces it here, cheaply and with nothing on disk.
 */
function loadNativeModule() {
  const Database = createRequire(thisFile)(NATIVE_MODULE);
  new Database(':memory:').close();
}

/**
 * Re-verifies in a CHILD process. A failed dlopen can leave the parent's module cache in a state
 * where a second require() no longer reflects what is on disk, so re-requiring in-process would
 * be an unreliable "did the rebuild work?" check.
 */
function verifyInChildProcess() {
  const probe = `const D = require(${JSON.stringify(NATIVE_MODULE)}); new D(':memory:').close();`;
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: rootDir,
    stdio: 'ignore',
  });
  return result.status === 0;
}

/**
 * PATH with the RUNNING Node's directory first. npm is a shell wrapper that launches whatever
 * `node` PATH resolves to — which, on a machine with two Node installs, is exactly the one that
 * built the wrong binary. Without this, the rebuild would cheerfully recompile for the same
 * mismatched ABI and the check would fail again. Windows env vars are case-insensitive, so the
 * existing key is dropped before setting ours to avoid ending up with both Path and PATH.
 */
function envWithRunningNodeFirst() {
  const env = { ...process.env };
  let existing = '';
  for (const key of Object.keys(env)) {
    if (/^path$/i.test(key)) {
      existing = env[key] ?? '';
      delete env[key];
    }
  }
  env.PATH = path.dirname(process.execPath) + path.delimiter + existing;
  return env;
}

function rebuild() {
  // shell: true so this finds npm.cmd on Windows.
  const result = spawnSync('npm', ['rebuild', NATIVE_MODULE], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
    env: envWithRunningNodeFirst(),
  });
  return result.status === 0;
}

function main() {
  if (process.env.SKIP_NATIVE_ABI_CHECK === '1') return;
  // Render and CI install and run under the same Node, and scripts/start.sh ends in
  // `exec npm start` — without this the check would fire on every production boot for nothing.
  // (Destructured rather than read off process.env inline: this is a hosted-platform flag, not a data-dir
  // derivation, and test/data/data-dir.test.js greps for the latter.)
  const { RENDER, CI } = process.env;
  if (RENDER || CI) return;

  const pinned = readPinnedNodeVersion();

  try {
    loadNativeModule();
    // Loaded fine, but drifting Node versions are what causes this in the first place — say so
    // once, non-fatally, so the next wrong-shell `npm install` isn't a surprise.
    if (!sameNodeVersion(process.version, pinned)) {
      console.warn(
        `[abi-check] running Node ${process.version} but .node-version pins ${pinned} — ` +
        `native modules built here will not load under the pinned version.`,
      );
    }
    return;
  } catch (err) {
    if (!isAbiMismatch(err)) throw err;

    const { compiled, required } = parseAbiVersions(errorMessage(err));
    console.warn(
      `[abi-check] ${NATIVE_MODULE} was built for Node ABI ${compiled}, but Node ${process.version} ` +
      `requires ABI ${required}${pinned ? ` (.node-version pins ${pinned})` : ''}. Rebuilding…`,
    );

    const rebuilt = rebuild() && verifyInChildProcess();
    if (rebuilt) {
      console.warn(`[abi-check] ${NATIVE_MODULE} rebuilt for Node ${process.version} — continuing.`);
      return;
    }

    console.error(
      `[abi-check] automatic rebuild of ${NATIVE_MODULE} FAILED.\n` +
      `  running Node: ${process.version}\n` +
      `  .node-version pins: ${pinned ?? '(unknown)'}\n` +
      `Fix: run this shell on the pinned version (\`fnm use\`) and re-run \`npm rebuild ${NATIVE_MODULE}\`.\n` +
      `If some shells still resolve a different Node, that mismatch is the root cause — the install\n` +
      `and the run have to share one Node version.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main();
}
