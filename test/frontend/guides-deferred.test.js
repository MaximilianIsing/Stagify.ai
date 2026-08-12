// guides.html's after-`load` script list, and the retry that makes it safe.
//
// public/scripts/guides-deferred.js injects demo-data.js (41 KB) and demo-player.js
// (13 KB) once the page has loaded, so they are not parsed on a throttled CPU while the
// browser is trying to paint. index.html already treated this pair that way via
// index-deferred.js; guides.html was still loading them eagerly as plain `defer` tags.
//
// THE HAZARD THIS FILE EXISTS FOR is not the one index-deferred.test.js guards. There,
// every consumer is deferred alongside its dependency, so nothing can run early. Here the
// consumer — guides.js, which wires the tablist — is deliberately NOT deferred, because
// the tabs must work immediately. That leaves a window between first paint and these two
// scripts landing in which guides.js's mountPlayer() finds no window.SupademoPlayer,
// returns silently, and never tries again:
//
//     if (!panel || panel.__player || !player) return;   // scripts/guides.js
//
// A visitor arriving on a #guide-demo-<key> deep link (the HowTo structured data
// publishes those, so search engines serve them) or simply clicking a tab quickly would
// get a permanently blank panel, with nothing thrown and nothing logged. The fix is the
// callback into guides.js after both files settle. These tests pin that callback,
// because deleting it breaks nothing loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const guidesHtml = fs.readFileSync(path.join(ROOT, 'public', 'guides.html'), 'utf8');
const guidesJs = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'guides.js'), 'utf8');

// The module registers a `load` listener at eval time, so stub the globals it touches
// before importing — same approach as index-deferred.test.js. readyState 'loading' takes
// the branch that only calls addEventListener, so nothing is scheduled here.
globalThis.document = globalThis.document || /** @type {any} */ ({ readyState: 'loading' });
globalThis.window = globalThis.window || /** @type {any} */ ({ addEventListener() {} });

// Imported, not scraped: asserts the real array, and is what makes
// untested-frontend-modules.test.js count this module as loaded.
const { DEFERRED } = await import('../../public/scripts/guides-deferred.js');

test('the deferred pair is demo-data then demo-player, in that order', () => {
  // demo-data.js defines window.STAGIFY_DEMOS; demo-player.js defines the player that
  // reads it. Neither is async, and non-async injected scripts preserve execution order
  // among themselves — so the array order IS the guarantee. Reversing it would leave the
  // player reading an undefined global.
  assert.deepEqual(
    DEFERRED.map((e) => e.src),
    ['scripts/demo-data.js', 'scripts/demo-player.js'],
  );
  // Both are classic IIFEs, not ES modules. Marking either `module: true` would make it
  // deferred-by-default AND change the global-assignment semantics it relies on.
  assert.deepEqual(DEFERRED.map((e) => e.module), [false, false]);
});

test('guides.html defers the pair instead of loading them eagerly', () => {
  assert.match(
    guidesHtml,
    /<script type="module" src="scripts\/guides-deferred\.js"><\/script>/,
    'guides.html must load the deferred loader',
  );
  // The regression: putting either back as an eager tag re-imports the whole cost into
  // the LCP window and makes the loader redundant.
  for (const src of ['scripts/demo-data.js', 'scripts/demo-player.js']) {
    assert.doesNotMatch(
      guidesHtml,
      new RegExp(`<script[^>]*\\bsrc="${src.replace('.', '\\.')}"`),
      `${src} must not be an eager <script> tag in guides.html — it is injected after load`,
    );
  }
});

test('guides.js exposes the remount bridge the loader calls back into', () => {
  // Without this the deferral is a silent-blank-panel bug, not an optimisation.
  assert.match(
    guidesJs,
    /StagifyGuides\s*=\s*\{\s*remountVisible/,
    'guides.js must expose window.StagifyGuides.remountVisible for guides-deferred.js',
  );
});

test('the loader retries the mount only after every script has settled', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'guides-deferred.js'), 'utf8')
    // Strip comments first: the prose below explains the retry in words, and a scan that
    // matched on the explanation would pass even after the code was deleted.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.match(src, /remountVisible\s*\(\s*\)/, 'the loader must call remountVisible()');
  // Counting down and firing at zero, rather than on each load: mounting needs BOTH
  // globals, so firing after the first would just bail silently and burn the retry.
  assert.match(src, /--pending\s*===\s*0/, 'the retry must wait for the last script, not the first');
  // 'error' as well as 'load'. A failed fetch that never decrements would hang the
  // counter and the retry would never fire at all.
  assert.match(src, /addEventListener\(\s*'error'/, 'a failed script must still settle the counter');
});
