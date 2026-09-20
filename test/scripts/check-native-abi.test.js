// scripts/check-native-abi.js — the prestart/predev/pretest guard that auto-rebuilds
// better-sqlite3 when its compiled ABI doesn't match the running Node.
//
// Only the pure classification/parsing helpers are exercised here: the script must NEVER
// spawn npm or touch node_modules from the test suite (npm test gates the deploy). The
// import itself is also part of the test — the module must not run its main() on import,
// or `node --test` would trigger a rebuild just by collecting this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isAbiMismatch,
  parseAbiVersions,
  readPinnedNodeVersion,
  sameNodeVersion,
} from '../../scripts/check-native-abi.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The real message Node prints, verbatim (newlines included) — the parser reads its wording.
const REAL_MESSAGE = [
  String.raw`The module '\?\C:\Users\me\node_modules\better-sqlite3\build\Release\better_sqlite3.node'`,
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 137. This version of Node.js requires',
  'NODE_MODULE_VERSION 127. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
].join('\n');

function dlopenError(message) {
  const err = new Error(message);
  err.code = 'ERR_DLOPEN_FAILED';
  return err;
}

test('recognises the ABI-mismatch flavour of a failed native load', () => {
  assert.equal(isAbiMismatch(dlopenError(REAL_MESSAGE)), true);
});

test('does NOT treat other native-load failures as a rebuildable mismatch', () => {
  // A corrupt or unloadable binary must surface, not be silently "healed" by a rebuild.
  assert.equal(isAbiMismatch(dlopenError('is not a valid Win32 application.')), false);

  const missing = new Error("Cannot find module 'better-sqlite3'");
  missing.code = 'MODULE_NOT_FOUND';
  assert.equal(isAbiMismatch(missing), false);

  assert.equal(isAbiMismatch(new Error('boom')), false);
  assert.equal(isAbiMismatch(null), false);
});

test('parses compiled-vs-required ABI numbers in the order Node prints them', () => {
  assert.deepEqual(parseAbiVersions(REAL_MESSAGE), { compiled: 137, required: 127 });
});

test('parsing degrades to nulls instead of throwing on unexpected wording', () => {
  assert.deepEqual(parseAbiVersions('something else entirely'), { compiled: null, required: null });
  assert.deepEqual(parseAbiVersions(undefined), { compiled: null, required: null });
});

test('compares Node versions with or without the leading v', () => {
  assert.equal(sameNodeVersion('v22.23.1', '22.23.1'), true);
  assert.equal(sameNodeVersion('v24.19.0', '22.23.1'), false);
  // Nothing to compare against — stay quiet rather than warn wrongly.
  assert.equal(sameNodeVersion('v22.23.1', null), true);
});

test('reads the pin from .node-version, the repo-wide source of truth', () => {
  const onDisk = fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8').trim();
  assert.equal(readPinnedNodeVersion(repoRoot), onDisk);
  assert.equal(readPinnedNodeVersion(path.join(repoRoot, 'no', 'such', 'dir')), null);
});
