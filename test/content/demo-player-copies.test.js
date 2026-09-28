// The guide walkthrough player exists twice: the served copy in public/ and the authoring
// master in to-build/demos/, which the standalone preview loads. Nothing imports one from
// the other, so an edit to either drifts silently, and re-exporting the master over the
// served file would quietly drop whatever only the served copy had (this happened with
// the localized step-dot labels). These tests pin the pair byte-for-byte, ignoring CRLF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PAIRS = [
  ['public/scripts/guides/demo-player.js', 'to-build/demos/demo-player.js'],
  ['public/styles/demo-player.css', 'to-build/demos/demo-player.css'],
];

for (const [served, master] of PAIRS) {
  test(`${master} matches the served ${served}`, () => {
    assert.equal(read(master), read(served),
        `${master} and ${served} have drifted; port the change to both.`);
  });
}
