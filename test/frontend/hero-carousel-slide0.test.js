// Slide 0 of the hero carousel exists TWICE on purpose, and the two copies must match.
//
// The <img> in `.carousel-container` is the homepage's LCP element. It used to be
// created by scripts/carousel.js, which meant its paint was chained behind 128 KB of
// HTML parsing, five render-blocking stylesheets, and that file's own download and
// execute — all while ~60 module files parsed on a throttled mobile CPU. It now ships
// in public/index.html so the preload scanner finds it in the first packet, and
// carousel.js ADOPTS that node instead of re-creating it (replacing it, even with an
// identical src, would restart the LCP candidate at the later time).
//
// The cost of that is duplication: the same <img> is written in index.html AND in
// carousel.js's `items[0].image`, which is still the source for every non-adopt
// consumer. If they drift, the symptom is silent and expensive — a second image
// download, a preload that no longer matches anything, or an LCP element that is not
// the one <head> preloads. Nothing else in the suite would notice. Hence this test.
//
// It also pins the three-way agreement with the <link rel="preload" as="image"> in
// <head>: preload matching is by URL, so a changed path in either place quietly turns
// the preload into dead weight AND delays the image.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const carouselJs = fs.readFileSync(path.join(root, 'public', 'scripts', 'carousel.js'), 'utf8');

/** Pull one attribute out of a tag string. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** The static <img> inside .carousel-container in index.html. */
function staticSlideImg() {
  const container = indexHtml.match(/<div class="carousel-container">([\s\S]*?)<div class="carousel-note"/);
  assert.ok(
    container,
    'could not find `.carousel-container` followed by `.carousel-note` in public/index.html — ' +
      'if the hero markup was restructured, update this test rather than deleting it; the ' +
      'duplication it guards still exists.'
  );
  const img = container[1].match(/<img\b[^>]*>/);
  assert.ok(
    img,
    'public/index.html no longer ships a static <img> in `.carousel-container`. That <img> is ' +
      'the LCP element; without it the paint goes back to waiting on carousel.js, the five ' +
      'render-blocking stylesheets, and the whole module graph. See the comment above the ' +
      'markup in index.html.'
  );
  return img[0];
}

/** items[0].image out of carousel.js — the string the from-scratch path still emits. */
function scriptSlideImg() {
  const idx = carouselJs.indexOf("key: 'original'");
  assert.ok(idx !== -1, "carousel.js no longer has an item with key: 'original'");
  const img = carouselJs.slice(idx).match(/<img\b[^>]*>/);
  assert.ok(img, "carousel.js's items[0] no longer contains an <img> tag");
  return img[0];
}

test('the static hero slide matches carousel.js items[0]', () => {
  const fromHtml = staticSlideImg();
  const fromJs = scriptSlideImg();

  for (const name of ['src', 'data-lang-attr', 'fetchpriority']) {
    assert.equal(
      attr(fromHtml, name),
      attr(fromJs, name),
      `hero slide 0 drifted on \`${name}\`.\n` +
        `  public/index.html    : ${attr(fromHtml, name)}\n` +
        `  scripts/carousel.js  : ${attr(fromJs, name)}\n` +
        'These are the same slide rendered two ways — index.html so the LCP image exists at ' +
        'parse time, carousel.js for consumers that build from scratch. Change both, or the ' +
        'homepage and the fallback render different images.'
    );
  }

  assert.equal(
    attr(fromHtml, 'fetchpriority'),
    'high',
    'the static hero slide lost fetchpriority="high" — it is the LCP element and needs to ' +
      'outrank the below-fold imagery.'
  );
});

test('the <head> image preload still points at the static hero slide', () => {
  const src = attr(staticSlideImg(), 'src');
  const preload = indexHtml.match(/<link\b[^>]*rel="preload"[^>]*as="image"[^>]*>/);
  assert.ok(preload, 'public/index.html lost its <link rel="preload" as="image"> for the LCP image');
  assert.equal(
    attr(preload[0], 'href'),
    src,
    'the LCP image preload no longer matches the static hero slide.\n' +
      `  preload href : ${attr(preload[0], 'href')}\n` +
      `  <img> src    : ${src}\n` +
      'Preload matching is by URL. A mismatch does not error — it silently costs a wasted ' +
      'download AND delays the element the preload was meant to accelerate.'
  );
});

test('the adopt path still publishes the marker its browser-level guard reads', () => {
  // NOTE ON WHAT THIS CAN AND CANNOT CATCH.
  //
  // The regression that matters is someone "simplifying" createCarousel() back to a
  // single `this.container.innerHTML = ...`. On screen that is indistinguishable; the
  // damage is that the LCP <img> is destroyed and re-created after the module graph has
  // run, i.e. exactly the delay the static markup exists to remove.
  //
  // A source scan CANNOT detect that honestly. Stub the adopt branch's querySelector to
  // null and every string worth grepping for — `.carousel-track`, `insertAdjacentHTML` —
  // is still right there in now-unreachable code, so the scan stays green. That mutant
  // survived while this test asserted on those strings, which is why it no longer does.
  //
  // The real guard is in e2e/index.spec.js: it loads the actual page in a real browser
  // and asserts `[data-carousel-adopted]`, which an unreachable branch simply never
  // sets. All this test does is make sure that marker has not been renamed out from
  // under the e2e assertion — the two must agree on the attribute name.
  assert.match(
    carouselJs,
    /setAttribute\('data-carousel-adopted'/,
    'carousel.js no longer sets `data-carousel-adopted`. That attribute is what lets ' +
      'e2e/index.spec.js verify the LCP node was adopted rather than re-created — if you ' +
      'rename it, rename it there too, or the browser-level guard silently stops guarding.'
  );
});
