// The hero picker's default pair is written down in THREE places, and they must agree.
//
// The homepage hero is a sentence with two dropdowns in it ("Stage this <room> in <style>")
// and a photo that changes with them. The photo is the page's LCP element, so it ships as a
// static <img> in public/index.html rather than being created by scripts/hero-picker.js —
// built by JS its paint was chained behind 128 KB of HTML parsing, five render-blocking
// stylesheets and the whole module graph on a throttled CPU.
//
// The cost of that is a three-way agreement nothing else would notice breaking:
//
//   1. <link rel="preload" as="image"> in <head>   — matching is by URL
//   2. the static <img> in .hp-canvas              — the LCP element itself
//   3. DEFAULT_ROOM / DEFAULT_STYLE in hero-picker.js — what the script thinks is showing
//
// Break 1-vs-2 and the preload is dead weight AND the image it was meant to accelerate
// arrives late. Break 2-vs-3 and the first paint shows one room while the script believes
// another is selected, so the sentence and the photo disagree until the visitor touches
// something. Neither errors. Neither shows up in any other test.
//
// The last test here is the one that catches the expensive mistake: adding a room type or a
// style to hero-picker.js without generating its renders. There is one image per
// combination and the script builds the path arithmetically, so a missing file is a broken
// hero for that pair and nothing at build time would say so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pickerJs = fs.readFileSync(path.join(root, 'public', 'scripts', 'hero-picker.js'), 'utf8');
const EXAMPLE_DIR = path.join(root, 'public', 'media-webp', 'example');

/* The srcset ladder, read out of hero-picker.js rather than written down a third time.
   WIDTHS there is itself a mirror of CANDIDATES in the generator, so pinning against it
   catches the thing that actually happens: someone edits one of the two and not the other. */
const CANDIDATE_SUFFIXES = (() => {
  const block = pickerJs.slice(pickerJs.indexOf('const WIDTHS = ['));
  const found = [...block.slice(0, block.indexOf('];')).matchAll(/suffix: '([^']*)'/g)].map((m) => m[1]);
  assert.ok(found.length >= 2, 'hero-picker.js no longer declares a WIDTHS ladder');
  return found;
})();

/** Pull one attribute out of a tag string. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** The static <img> inside .hp-canvas in index.html. */
function stageImg() {
  const start = indexHtml.indexOf('<div class="hp-canvas"');
  assert.notEqual(
    start,
    -1,
    'could not find `.hp-canvas` in public/index.html. If the hero markup was restructured, ' +
      'update this test rather than deleting it: the three-way agreement it guards still exists.'
  );
  // Scanned forward from the canvas rather than matched inside a balanced block: `.hp-canvas`
  // now contains the whole hero (top rail, scrim bar, headline), so a non-greedy `</div>`
  // stops at the first nested close and a greedy one runs past the section.
  const img = indexHtml.slice(start).match(/<img\b[^>]*data-hp-img[^>]*>/);
  assert.ok(
    img,
    'public/index.html no longer ships a static <img data-hp-img> in `.hp-canvas`. That <img> ' +
      'is the LCP element; without it the paint goes back to waiting on hero-picker.js, the ' +
      'five render-blocking stylesheets and the whole module graph. See the comment above the ' +
      'markup.'
  );
  return img[0];
}

/** A `const NAME = 'value';` string out of hero-picker.js. */
function constant(name) {
  const m = pickerJs.match(new RegExp(`const ${name} = '([^']+)'`));
  assert.ok(m, `hero-picker.js no longer declares ${name}`);
  return m[1];
}

/** Every `slug: 'x'` inside the ROOMS or STYLES array literal. */
function slugs(arrayName) {
  const start = pickerJs.indexOf(`const ${arrayName} = [`);
  assert.ok(start !== -1, `hero-picker.js no longer declares ${arrayName}`);
  const body = pickerJs.slice(start, pickerJs.indexOf('];', start));
  const found = [...body.matchAll(/slug: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(found.length > 0, `${arrayName} has no entries`);
  return found;
}

test('the static hero photo, the preload and the script agree on the default pair', () => {
  const img = stageImg();
  const src = attr(img, 'src');
  const expected = `media-webp/example/${constant('DEFAULT_STYLE')}-${constant('DEFAULT_ROOM')}.webp`;

  assert.equal(
    src,
    expected,
    'the static hero photo is not the pair hero-picker.js defaults to.\n' +
      `  index.html <img> src : ${src}\n` +
      `  DEFAULT_STYLE-ROOM   : ${expected}\n` +
      'The first paint would show one room while the sentence names another, until the ' +
      'visitor touches a dropdown. Change both, or change neither.'
  );

  const preload = indexHtml.match(/<link\b[^>]*rel="preload"[^>]*as="image"[^>]*>/);
  assert.ok(preload, 'public/index.html lost its <link rel="preload" as="image"> for the LCP image');
  assert.equal(
    attr(preload[0], 'href'),
    src,
    'the LCP image preload no longer matches the static hero photo.\n' +
      `  preload href : ${attr(preload[0], 'href')}\n` +
      `  <img> src    : ${src}\n` +
      'Preload matching is by URL. A mismatch does not error, it silently costs a wasted ' +
      'download AND delays the element the preload was meant to accelerate.'
  );
});

test('the static hero photo keeps the attributes that make it the LCP element', () => {
  const img = stageImg();

  assert.equal(
    attr(img, 'fetchpriority'),
    'high',
    'the static hero photo lost fetchpriority="high" — it is the LCP element and needs to ' +
      'outrank the below-fold imagery.'
  );
  assert.ok(
    !/loading="lazy"/.test(img),
    'the static hero photo is loading="lazy". It is above the fold and preloaded; lazy ' +
      'forfeits the preload and defers the very paint this markup exists to bring forward.'
  );
  assert.ok(
    !/\swidth="/.test(img) && !/\sheight="/.test(img),
    'the static hero photo has width/height attributes. `.hp-canvas` sets the box height and ' +
      'the image fills it with object-fit:cover; intrinsic attributes override that and ' +
      'letterbox the photo inside the canvas.'
  );
});

test('the static hero photo is visible without JavaScript having run', () => {
  // BOTH HALVES, because either one alone is a silent regression.
  //
  // hero-picker.css gives every .hp-canvas__img `opacity: 0` and lifts it with `.is-on`.
  // That is right for the layers the script stacks — they have to start invisible to
  // cross-fade — but LCP IGNORES AN ELEMENT AT OPACITY 0. So for as long as `is-on` was
  // added only by hero-picker.js, the static, preloaded, fetchpriority=high photo could
  // not become an LCP candidate until the whole 254 KB document had parsed, all five
  // render-blocking stylesheets had arrived and the module had executed — which is the
  // exact chain the static markup exists to escape. Everything above was true of the
  // photo's DOWNLOAD and false of its PAINT, and nothing failed.
  //
  // So: the markup must ship the class, AND the stylesheet must still be the thing that
  // reads it. Delete the rule and the class here is inert; delete the class and the paint
  // re-chains to the module graph. Neither shows up anywhere else.
  const img = stageImg();
  const cls = attr(img, 'class') || '';
  assert.ok(
    /(^|\s)is-on(\s|$)/.test(cls),
    'the static hero photo does not ship `is-on` in its class list (found: "' + cls + '"). ' +
      'hero-picker.css hides .hp-canvas__img at opacity 0 until that class lands, and LCP ' +
      'skips elements at opacity 0 — so without it the LCP element cannot paint until the ' +
      'whole module graph has executed, which is what the static <img> exists to avoid.'
  );

  const pickerCss = fs.readFileSync(
    path.join(root, 'public', 'styles', 'hero-picker.css'),
    'utf8'
  );
  assert.match(
    pickerCss,
    /\.hp-canvas__img\.is-on\s*\{[^}]*opacity:\s*1/,
    'hero-picker.css no longer declares `.hp-canvas__img.is-on { opacity: 1 }`. The class ' +
      'shipped on the static <img> in index.html is what makes the LCP element paintable ' +
      'before hero-picker.js runs; if the rule was renamed, rename it in the markup too.'
  );
});

test('hero-picker.js stays the first module tag on the homepage', () => {
  // Load-bearing twice over, and neither reason is obvious from the tag itself.
  //
  // 1. LCP: modules execute in document order, so behind app.js's import graph this file
  //    used to wait for ~34 other modules before it could adopt the hero.
  // 2. CLS: fitSentence() writes `.is-fitted` (white-space: nowrap) on the headline. The
  //    headline is only VISIBLE once language-loader.js has resolved its pack — and that
  //    module registers its init on DOMContentLoaded and then awaits a fetch, so it is
  //    unconditionally later than this file, which inits at module eval. That ordering is
  //    what guarantees the sentence is never seen mid-wrap. Demote this tag and the
  //    guarantee goes with it, silently.
  // Not literally first: scripts/lazy-css.js sits above it, next to the <link>s it
  // promotes, and it is 1.5 KB with zero imports — it cannot delay anything. What must
  // not appear ahead of hero-picker.js is a module that drags an import graph behind it.
  const ALLOWED_AHEAD = new Set(['scripts/lazy-css.js']);
  const tags = [...indexHtml.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)].map((m) => m[1]);
  const at = tags.indexOf('scripts/hero-picker.js');
  assert.notEqual(at, -1, 'index.html no longer loads scripts/hero-picker.js as a module');
  const ahead = tags.slice(0, at).filter((s) => !ALLOWED_AHEAD.has(s));
  assert.deepEqual(
    ahead,
    [],
    'these module tags now run before scripts/hero-picker.js: ' + ahead.join(', ') + '. ' +
      'Modules run in document order, so anything ahead of it — and its whole import ' +
      'graph — has to execute before the hero can be adopted. If the new tag genuinely ' +
      'has no imports and must load first, add it to ALLOWED_AHEAD with the reason.'
  );
});

test('the adopt path still publishes the marker its browser-level guard reads', () => {
  // A source scan cannot honestly prove the LCP node was adopted rather than re-created:
  // stub the branch out and every string worth grepping for is still sitting in unreachable
  // code. The real guard is in e2e/index.spec.js, which loads the page in a real browser and
  // asserts [data-hp-adopted]. All this does is make sure the marker has not been renamed
  // out from under that assertion.
  assert.match(
    pickerJs,
    /setAttribute\('data-hp-adopted'/,
    'hero-picker.js no longer sets `data-hp-adopted`. That attribute is what lets ' +
      'e2e/index.spec.js verify the LCP node was adopted rather than re-created — if you ' +
      'rename it, rename it there too, or the browser-level guard silently stops guarding.'
  );
});

test('every room/style combination the picker offers has a render on disk', () => {
  const rooms = slugs('ROOMS');
  const styles = slugs('STYLES');
  const missing = [];

  for (const style of styles) {
    for (const room of rooms) {
      // EVERY candidate in the ladder, because the srcset names all of them and a hole in
      // it is the sneakiest failure here: the others still exist, so the hero looks right on
      // whatever machine you happen to be testing on, and 404s only at the device pixel
      // ratio that resolves to the missing one. `--rebuild` re-cuts the whole ladder from
      // the PNG masters without calling any API.
      for (const suffix of CANDIDATE_SUFFIXES) {
        const file = `${style}-${room}${suffix}.webp`;
        if (!fs.existsSync(path.join(EXAMPLE_DIR, file))) missing.push(file);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `${missing.length} of ${rooms.length * styles.length * CANDIDATE_SUFFIXES.length} hero image files are absent from ` +
      'public/media-webp/example/. hero-picker.js builds the path arithmetically from the ' +
      'slugs, so each of these is a hero that silently shows nothing when picked. Generate ' +
      'them with:\n' +
      '  node to-build/media-png/example/tools/generate-combos.mjs\n' +
      'and read that folder\'s README first — two room types cannot work from this source photo.'
  );
});

test('the hero photo, its preload and hero-picker.js agree on the srcset candidates', () => {
  // Three copies of one `sizes` string, and they cannot be collapsed into one: the preload
  // scanner reads <head> before any script runs, so the markup cannot be handed a value from
  // hero-picker.js, and the picker has to know the same string to set it on the elements it
  // creates at swap time. Duplication that cannot be removed is duplication that has to be
  // pinned — a preload whose imagesizes disagrees with the <img> resolves to a DIFFERENT
  // candidate, which turns the preload from an accelerator into a second download.
  const img = stageImg();
  const preload = indexHtml.match(/<link [^>]*rel="preload"[^>]*as="image"[^>]*>/);
  assert.ok(preload, 'public/index.html lost its <link rel="preload" as="image"> for the LCP image');

  const imgSrcset = attr(img, 'srcset');
  const imgSizes = attr(img, 'sizes');
  assert.ok(imgSrcset, 'the static hero photo lost its srcset — every viewport now pays for the 1248w file.');
  assert.ok(imgSizes, 'the static hero photo lost its sizes — without it the browser assumes 100vw and over-picks.');

  assert.equal(
    attr(preload[0], 'imagesrcset'),
    imgSrcset,
    'the preload and the <img> disagree on srcset. The scanner would fetch one candidate and ' +
      'the layout would then ask for the other.'
  );
  assert.equal(
    attr(preload[0], 'imagesizes'),
    imgSizes,
    'the preload and the <img> disagree on sizes, which selects the candidate — so they can ' +
      'name identical srcsets and still resolve to different files.'
  );

  const inPicker = pickerJs.match(/const SIZES = '([^']+)'/);
  assert.ok(inPicker, 'hero-picker.js no longer declares SIZES');
  assert.equal(
    inPicker[1],
    imgSizes,
    'hero-picker.js SIZES has drifted from the sizes in public/index.html. The first paint ' +
      'would pick one candidate and every swap after it a different one, on the same canvas.'
  );

  // The default pair has to be the one named in the srcset, or the preload warms a file the
  // page does not use — the same failure the href/src check above catches, one level down.
  const expected = `media-webp/example/${constant('DEFAULT_STYLE')}-${constant('DEFAULT_ROOM')}`;
  const widths = [...pickerJs.slice(pickerJs.indexOf('const WIDTHS = [')).matchAll(/suffix: '([^']*)', w: (\d+)/g)];
  assert.equal(
    imgSrcset,
    widths.map(([, suffix, w]) => `${expected}${suffix}.webp ${w}w`).join(', '),
    'the srcset in index.html does not match the WIDTHS ladder in hero-picker.js for the ' +
      'default pair. The markup is what the preload scanner reads and WIDTHS is what every ' +
      'swap after it uses, so a mismatch means the first paint and every paint after it ' +
      'pull from different files.'
  );
});
