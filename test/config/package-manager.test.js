// Package-manager drift guard.
//
// PURPOSE
// The repo is npm-only: .github/workflows/ci.yml and scripts/build.sh (Render) both
// install with `npm ci` against package-lock.json. A stray pnpm or yarn lockfile is
// never read by either, so it silently drifts from the tree that actually ships.
// This pins the single lockfile and the `packageManager` field that makes corepack
// refuse a `pnpm install` in this repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exists = (rel) => fs.existsSync(path.join(rootDir, rel));

test('package-lock.json is the only lockfile', () => {
  assert.ok(exists('package-lock.json'), 'package-lock.json is missing');
  for (const stray of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock']) {
    assert.ok(!exists(stray), `${stray} must not exist: CI and Render install with npm ci`);
  }
});

test('package.json pins npm as the package manager', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.match(pkg.packageManager ?? '', /^npm@\d/);
});
