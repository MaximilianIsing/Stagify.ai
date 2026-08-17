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
//   2. the static <img> in .hp-stage               — the LCP element itself
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

/** Pull one attribute out of a tag string. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** The static <img> inside .hp-stage in index.html. */
function stageImg() {
  const stage = indexHtml.match(/<div class="hp-stage"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(
    stage,
    'could not find `.hp-stage` in public/index.html. If the hero markup was restructured, ' +
      'update this test rather than deleting it: the three-way agreement it guards still exists.'
  );
  const img = stage[1].match(/<img\b[^>]*>/);
  assert.ok(
    img,
    'public/index.html no longer ships a static <img> in `.hp-stage`. That <img> is the LCP ' +
      'element; without it the paint goes back to waiting on hero-picker.js, the five ' +
      'render-blocking stylesheets and the whole module graph. See the comment above the markup.'
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
    'the static hero photo has width/height attributes. `.hp-stage` sets the box via ' +
      'aspect-ratio and the image fills it with object-fit:cover; intrinsic attributes ' +
      'override that and letterbox the photo.'
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
      const file = `${style}-${room}.webp`;
      if (!fs.existsSync(path.join(EXAMPLE_DIR, file))) missing.push(file);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `${missing.length} of ${rooms.length * styles.length} hero combinations have no image in ` +
      'public/media-webp/example/. hero-picker.js builds the path arithmetically from the ' +
      'slugs, so each of these is a hero that silently shows nothing when picked. Generate ' +
      'them with:\n' +
      '  node to-build/media-png/example/tools/generate-combos.mjs\n' +
      'and read that folder\'s README first — two room types cannot work from this source photo.'
  );
});
