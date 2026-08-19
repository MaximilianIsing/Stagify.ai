// The homepage's after-`load` script list, and the trap that comes with it.
//
// public/scripts/index-deferred.js injects ~13 below-fold scripts once the page has
// loaded, to keep them from being parsed on a throttled CPU while the browser is trying
// to paint the hero. The hazard is specific and silent: anything injected after `load`
// has MISSED both `DOMContentLoaded` and `load`, so a module that registers its init on
// either event never runs. Nothing throws. The marquee just stops looping, the glow ring
// never mounts, the #ai-designer-demo deep link quietly stops scrolling.
//
// Three of the files in that list (sponsors-scroll, star-border, index-inline) had
// exactly that bug and were converted to the guarded form. This test stops the next
// addition from reintroducing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The module registers a `load` listener at eval time, so stub the two globals it
// touches before importing — same approach as count-up.test.js. readyState 'loading'
// takes the branch that only calls addEventListener, so nothing is scheduled.
globalThis.document = globalThis.document || /** @type {any} */ ({ readyState: 'loading' });
globalThis.window = globalThis.window || /** @type {any} */ ({ addEventListener() {} });

// Imported, not scraped: this asserts the real array, and it is also what makes
// untested-frontend-modules.test.js count this module as loaded.
const { DEFERRED } = await import('../../public/scripts/index-deferred.js');

/**
 * Strip comments before scanning for code.
 *
 * Not optional here. Every one of these files carries a comment explaining why its init
 * is guarded, and those comments say "DOMContentLoaded". Without stripping, a file whose
 * guard was DELETED would still match on its own leftover comment and this test would
 * pass while the feature was broken — the failure mode is the guard, not the bug.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The `src` values listed in index-deferred.js's DEFERRED array, in order. */
function deferredList() {
  assert.ok(Array.isArray(DEFERRED) && DEFERRED.length, 'index-deferred.js exports no DEFERRED list');
  return DEFERRED.map((e) => e.src);
}

test('every deferred script exists', () => {
  for (const src of deferredList()) {
    const file = path.join(root, 'public', src);
    assert.ok(fs.existsSync(file), `index-deferred.js lists ${src}, which does not exist`);
  }
});

/**
 * Every file a deferred entry pulls in, transitively, as public/-relative paths.
 *
 * THIS WALK IS THE POINT, and the test was materially weaker without it. It used to read
 * only `public/${src}` for each entry — but an entry is a module, and a module's init is
 * usually in its imports. app.js is the case that exposed it: app.js itself registers
 * nothing on DOMContentLoaded, so listing it passed instantly, while
 * app/background-video.js — one of its 30-odd imports — registered EVERYTHING on that
 * event and would have gone silently dead the moment app.js joined the list. A test that
 * goes green while the feature breaks is worse than no test.
 *
 * Static `import ... from '...'` and `export ... from '...'` only, which is all this
 * codebase uses in these graphs (there are no dynamic `import()` calls in them). Anything
 * non-relative is a bare specifier and cannot be a file under public/.
 *
 * @param {string} entry public/-relative path, e.g. 'scripts/app.js'
 * @returns {string[]}
 */
function importGraph(entry) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.join(root, 'public', rel);
    if (!fs.existsSync(abs)) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));

    for (const m of code.matchAll(/\b(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
    // Side-effect imports: `import './x.js';`
    for (const m of code.matchAll(/\bimport\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }

  return [...seen];
}

test('no deferred script registers its init on an event that has already fired', () => {
  const offenders = [];

  for (const src of deferredList()) {
    for (const file of importGraph(src)) {
      const abs = path.join(root, 'public', file);
      if (!fs.existsSync(abs)) continue;
      const code = stripComments(fs.readFileSync(abs, 'utf8'));

      // Does it wait on DOMContentLoaded / load at all?
      //
      // Anchored to `document.` / `window.`, and that is not tidiness — an unanchored
      // match reads `stagePreview.addEventListener('load', positionCarousel)` in
      // app/version-carousel.js as a page-lifecycle registration. That is an <img>'s own
      // load event: it fires whenever the element's src resolves, has nothing to do with
      // the document's lifecycle, and is perfectly correct in a deferred module. Flagging
      // it would push the next person to "fix" working code, or to delete the assertion.
      const waits = /\b(?:document|window)\.addEventListener\(\s*['"](?:DOMContentLoaded|load)['"]/.test(code);
      if (!waits) continue;

      // If it does, it must also branch on readyState, which is what lets it run
      // immediately when the event is already past.
      const guarded = /document\.readyState/.test(code);
      if (!guarded) offenders.push(file === src ? file : `${file}  (imported by ${src})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These scripts are injected after `load` by index-deferred.js but register their init ' +
      'on DOMContentLoaded/load with no `document.readyState` branch, so that init will ' +
      'NEVER run:\n  ' +
      offenders.join('\n  ') +
      '\n\nIt fails silently — no error, the feature simply does not happen. Convert to:\n' +
      "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);\n" +
      '  else init();\n' +
      'or, for a `load` listener, branch on `document.readyState === \'complete\'`.'
  );
});

test('the guides walkthrough trio keeps its load order', () => {
  // demo-data.js defines window.STAGIFY_DEMOS, demo-player.js defines the renderer that
  // reads it, designer-demo.js mounts the players. They are injected in array order and
  // none is `async`, so execution order follows — but only if the array order is right.
  const list = deferredList();
  const at = (name) => list.findIndex((s) => s.endsWith(name));
  const data = at('demo-data.js');
  const player = at('demo-player.js');
  const mount = at('designer-demo.js');

  assert.ok(data !== -1 && player !== -1 && mount !== -1, 'the demo trio is no longer all deferred');
  assert.ok(
    data < player && player < mount,
    `demo-data.js -> demo-player.js -> designer-demo.js must stay in that order in DEFERRED ` +
      `(got indexes ${data}, ${player}, ${mount}). demo-player reads the global demo-data ` +
      'defines, and designer-demo mounts what demo-player defines.'
  );
});

test('deferred scripts are not also hard-coded as tags on the homepage', () => {
  // A leftover <script src> would load the file twice: once during the LCP window (the
  // thing this whole mechanism exists to avoid) and again after load.
  const duplicated = deferredList().filter((src) =>
    new RegExp(`<script[^>]*src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(indexHtml)
  );
  assert.deepEqual(
    duplicated,
    [],
    'These are listed in index-deferred.js AND still have their own <script> tag in ' +
      'index.html, so they load twice — once on the critical path:\n  ' + duplicated.join('\n  ')
  );
});
