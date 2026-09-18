// The walkthrough panels' loading skeleton.
//
// demo-data.js and demo-player.js are injected after `load` (guides-deferred.js), so a
// walkthrough panel is empty — and therefore zero-height — for the first moment of the
// page. The player frame then appeared all at once and pushed everything below it down.
//
// The fix reserves the frame's box up front with a pseudo-element sized by --demo-ar,
// an inline custom property on each panel. That property is a HAND-COPY of the demo's
// `aspect` in the generated demo-data.js, so it can drift: re-export a walkthrough at a
// different crop and the reserved box becomes the wrong height, which is the very jump
// the skeleton exists to stop — only now it looks deliberate. These tests are what keeps
// the copy honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pageSource } from '../../helpers/guides-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/** key → aspect, straight out of the generated demo data. */
function demoAspects() {
  const src = read('public', 'scripts', 'demo-data.js');
  const keys = [...src.matchAll(/"key":"(\w+)"/g)].map((m) => m[1]);
  const aspects = [...src.matchAll(/"aspect":([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.equal(keys.length, aspects.length, 'every demo carries an aspect');
  return new Map(keys.map((key, i) => [key, aspects[i]]));
}

/** key → --demo-ar, out of the shipped page's panels. */
function panelAspects() {
  const panels = [...pageSource().matchAll(/<div\b[^>]*class="guide-demo-panel[^"]*"[^>]*>/g)].map((m) => m[0]);
  return new Map(panels.map((tag) => [
    (/\bdata-demo="([^"]+)"/.exec(tag) || [])[1],
    Number((/--demo-ar:\s*([0-9.]+)/.exec(tag) || [])[1]),
  ]));
}

test('every walkthrough panel reserves a box before the player lands', () => {
  const panels = panelAspects();
  assert.equal(panels.size, 6, 'six walkthroughs, six panels');
  for (const [key, ar] of panels) {
    assert.ok(Number.isFinite(ar), `panel ${key} is missing its --demo-ar, so it reserves nothing`);
  }
});

test('the reserved box is the shape the player will actually be', () => {
  const demos = demoAspects();
  for (const [key, ar] of panelAspects()) {
    assert.equal(
      ar,
      demos.get(key),
      `guides.html reserves ${ar} for "${key}" but demo-data.js will mount ${demos.get(key)} — `
      + 'the panel would still jump. Copy the aspect across.',
    );
  }
});

test('the skeleton is sized by that property and cleared on mount', () => {
  const css = read('public', 'styles', 'guides.css');
  assert.match(css, /\.guide-demo-panel::before\s*\{[^}]*aspect-ratio:\s*var\(--demo-ar/,
    'the skeleton must take its height from the panel, not a single hard-coded ratio');
  assert.match(css, /\.guide-demo-panel\.is-mounted::before,\s+\.guide-demo-panel\.is-mounted::after\s*\{\s*content:\s*none;/,
    'without this the skeleton stays stacked above the mounted player');
  assert.match(css, /\.guide-demo-panel:not\(\.is-mounted\)\s*\{\s*padding-bottom:\s*21px;/,
    'the step-dots row is 21px of the player; not reserving it puts the jump back');
});

test('guides.js raises the flag the skeleton waits on', () => {
  const js = read('public', 'scripts', 'guides.js');
  assert.match(js, /classList\.add\('is-mounted'\)/,
    'nothing would ever clear the skeleton');
});
