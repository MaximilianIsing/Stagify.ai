// The burned-in "virtually staged" disclosure (lib/image/stamp-disclosure.js). This is a
// legal-compliance feature, so the assertions here are about the two ways it can betray the
// user silently: stamping the WRONG PART of the image, and stamping NOTHING AT ALL while
// reporting success. Real sharp buffers and real committed masters throughout — a fake
// would defeat the point, since the thing under test is whether pixels actually change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  badgeGeometry,
  stampVirtuallyStaged,
  clampStampScale,
  STAMP_STYLE_NAMES,
  DEFAULT_STAMP_STYLE,
  STAMP_SCALE_MIN,
  STAMP_SCALE_MAX,
} from '../../lib/image/stamp-disclosure.js';
import { STAGING_DISCLOSURE_BADGE } from '../../lib/staging/staging-disclosure.js';

const BADGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'image', 'badges');
const manifest = JSON.parse(fs.readFileSync(path.join(BADGE_DIR, 'manifest.json'), 'utf8'));

/** A flat mid-grey PNG data URL — a uniform field so any change is unambiguously the badge. */
async function sourceUrl(w, h, rgb = { r: 128, g: 128, b: 128 }) {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const decode = (dataUrl) => Buffer.from(String(dataUrl).split(',')[1], 'base64');

/** Decode to RGBA with a pixel accessor, matching image-primitives.test.js. */
async function pixels(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    at: (x, y) => {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

/** Raw bytes of a sub-rectangle, for byte-identity comparisons. */
const region = (buf, left, top, width, height) =>
  sharp(buf).extract({ left, top, width, height }).raw().toBuffer();

// Compare big pixel buffers with .equals() behind assert.ok, never assert.deepEqual: on a
// mismatch, deepEqual tries to render a character diff of both operands, and diffing two
// ~600 KB buffers exhausts the heap and takes minutes before it can even report the failure.
const same = (a, b, msg) => assert.ok(Buffer.compare(a, b) === 0, msg);
const differs = (a, b, msg) => assert.ok(Buffer.compare(a, b) !== 0, msg);

test('stampVirtuallyStaged: stamps the bottom-right and leaves the rest byte-identical', async () => {
  const src = await sourceUrl(1536, 1024);
  const out = decode(await stampVirtuallyStaged(src, { lang: 'english' }));
  const before = decode(src);

  const m = await sharp(out).metadata();
  assert.equal(m.width, 1536, 'width unchanged — the stamp must not resize the render');
  assert.equal(m.height, 1024, 'height unchanged');
  assert.equal(m.channels, 3, 'channel count matches the opaque input — no gratuitous alpha channel');

  // Top-left is far from any corner badge; if this differs, the composite is misplaced.
  same(
    await region(out, 0, 0, 400, 400),
    await region(before, 0, 0, 400, 400),
    'top-left 400×400 is untouched',
  );
  // The corner the badge actually lands in.
  const g = badgeGeometry(1536, 1024, manifest.entries.english.width, manifest.entries.english.height);
  differs(
    await region(out, g.left, g.top, g.pillW, g.pillH),
    await region(before, g.left, g.top, g.pillW, g.pillH),
    'the badge rectangle differs from the source',
  );
});

test('stampVirtuallyStaged: keeps an alpha channel when the source had one', async () => {
  const rgba = await sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 40, g: 40, b: 40, alpha: 0.5 } } }).png().toBuffer();
  const out = decode(await stampVirtuallyStaged(`data:image/png;base64,${rgba.toString('base64')}`, { lang: 'english' }));
  assert.equal((await sharp(out).metadata()).channels, 4, 'a transparent source stays transparent');
});

test('stampVirtuallyStaged: the badge contains BOTH the dark pill and light text', async () => {
  // The catastrophic silent failure is a pill with an invisible text layer: the image looks
  // stamped, the render succeeds, and the disclosure says nothing. Asserting only "these
  // pixels changed" would pass in that state, so require both extremes to be present.
  const src = await sourceUrl(1536, 1024);
  const out = decode(await stampVirtuallyStaged(src, { lang: 'english' }));
  const g = badgeGeometry(1536, 1024, manifest.entries.english.width, manifest.entries.english.height);
  const px = await pixels(await sharp(out).extract({ left: g.left, top: g.top, width: g.pillW, height: g.pillH }).png().toBuffer());

  let dark = 0;
  let light = 0;
  for (let y = 0; y < g.pillH; y++) {
    for (let x = 0; x < g.pillW; x++) {
      const v = px.at(x, y)[0];
      if (v < 90) dark += 1;   // source is 128; the pill darkens it
      if (v > 200) light += 1; // white glyphs
    }
  }
  assert.ok(dark > 0, 'the translucent pill darkened part of the badge area');
  assert.ok(light > 0, `white glyph pixels are present (found ${light}) — a pill with no text discloses nothing`);
});

test('stampVirtuallyStaged: the badge survives a dark photo — capsule ends, light edge', async () => {
  // The dark fill does nothing on a dark floor or a shadowed corner: black at ~50% over
  // near-black is still near-black, so the badge stops being a badge and becomes floating
  // white words. The hairline is the only part of the treatment that works there, which
  // makes "is there still a light edge?" the assertion worth having.
  //
  // The corner check rides along because both come from the same rounded-rect distance:
  // if the capsule ever degrades to a rectangle, the badge stops reading as a deliberate
  // tag, and nothing else here would notice.
  const src = await sourceUrl(1200, 800, { r: 0, g: 0, b: 0 });
  const out = decode(await stampVirtuallyStaged(src, { lang: 'english' }));
  const e = manifest.entries.english;
  const g = badgeGeometry(1200, 800, e.width, e.height);
  const px = await pixels(out);

  const midY = g.top + Math.round(g.pillH / 2);
  const edge = px.at(g.left + 1, midY)[0];      // inside the outline, on the hairline
  const fill = px.at(g.left + 8, midY)[0];      // past it, in the fill, clear of the glyphs
  assert.ok(
    edge > fill + 20,
    `the pill's edge (${edge}) must read lighter than its fill (${fill}) — without the hairline `
      + 'the badge dissolves into a dark photo',
  );

  // Two halves, because either alone passes on a shape nobody wanted. The radius is the
  // intent — a capsule is round to the full half-height — and the pixel is the proof that
  // buildPill honours it: a hard-cornered pill would paint fill at both of these points,
  // and a radius that quietly shrank back to a gently rounded rectangle would paint fill
  // at the second one while still passing the first.
  assert.equal(g.radius, Math.round(g.pillH / 2), 'the badge is a capsule: its radius is half its height');
  const inset = Math.round(g.pillH * 0.15); // inside a 0.15-radius corner, outside a capsule's
  for (const [x, y] of [[g.left + 1, g.top + 1], [g.left + inset, g.top + 1]]) {
    assert.deepEqual(
      px.at(x, y),
      [0, 0, 0, 255],
      `(${x - g.left}, ${y - g.top}) inside the pill's box is outside the capsule, so it must be untouched`,
    );
  }
});

test('stampVirtuallyStaged: every language produces visible glyphs', async () => {
  // Guards a missing or blank CJK master, which would otherwise ship a bare pill to exactly
  // the users who cannot read the English fallback.
  for (const lang of Object.keys(STAGING_DISCLOSURE_BADGE)) {
    const src = await sourceUrl(1200, 800, { r: 0, g: 0, b: 0 });
    const out = decode(await stampVirtuallyStaged(src, { lang }));
    const e = manifest.entries[lang];
    const g = badgeGeometry(1200, 800, e.width, e.height);
    const px = await pixels(await sharp(out).extract({ left: g.left, top: g.top, width: g.pillW, height: g.pillH }).png().toBuffer());
    let light = 0;
    for (let y = 0; y < g.pillH; y++) {
      for (let x = 0; x < g.pillW; x++) if (px.at(x, y)[0] > 200) light += 1;
    }
    assert.ok(light > 20, `${lang}: expected white glyph pixels, found ${light}`);
  }
});

test('every style stays legible on BOTH a white and a black photo', async () => {
  // THE COMPLIANCE FLOOR FOR THE STYLE PICKER. The badge exists to be read by a buyer
  // looking at a listing photo, and the user now chooses how it is drawn — so each choice
  // has to survive the two backgrounds that break the naive versions of it. A dark capsule
  // vanishes into a dark floor; a light one vanishes into a white wall; `minimal` has no
  // capsule at all and leans entirely on its shadow. Every one of those failures looks
  // fine on the developer's sample photo and fails on somebody's listing.
  //
  // "Legible" here is deliberately crude and absolute: within the badge's own box there
  // must be pixels far from the background on BOTH fields. A style that quietly stopped
  // drawing its capsule, or whose shadow got tuned down to nothing, could not pass.
  for (const style of STAMP_STYLE_NAMES) {
    for (const [label, bg] of [['white', { r: 255, g: 255, b: 255 }], ['black', { r: 0, g: 0, b: 0 }]]) {
      const src = await sourceUrl(1200, 800, bg);
      const out = decode(await stampVirtuallyStaged(src, { lang: 'english', style }));
      const e = manifest.entries.english;
      const g = badgeGeometry(1200, 800, e.width, e.height, { style });
      const px = await pixels(await sharp(out).extract({ left: g.left, top: g.top, width: g.pillW, height: g.pillH }).png().toBuffer());

      let contrasting = 0;
      for (let y = 0; y < g.pillH; y++) {
        for (let x = 0; x < g.pillW; x++) {
          const v = px.at(x, y)[0];
          if (Math.abs(v - bg.r) > 90) contrasting += 1;
        }
      }
      assert.ok(
        contrasting > 100,
        `${style} on ${label}: only ${contrasting} pixels separate from the background — this style is `
          + 'unreadable on that photo, which means it discloses nothing',
      );
    }
  }
});

test('the styles actually differ from one another', async () => {
  // Guards the wiring rather than the looks: if `style` were dropped anywhere between the
  // request and the compositor, every pick would render the default and the picker would
  // be decoration. Compared on a mid-grey field so the difference cannot come from the
  // photo.
  const src = await sourceUrl(1200, 800);
  const rendered = [];
  for (const style of STAMP_STYLE_NAMES) rendered.push(decode(await stampVirtuallyStaged(src, { lang: 'english', style })));
  for (let i = 0; i < rendered.length; i++) {
    for (let j = i + 1; j < rendered.length; j++) {
      differs(rendered[i], rendered[j], `${STAMP_STYLE_NAMES[i]} and ${STAMP_STYLE_NAMES[j]} render differently`);
    }
  }
});

test('an unknown style falls back to the default rather than failing the render', async () => {
  const src = await sourceUrl(1200, 800);
  const odd = decode(await stampVirtuallyStaged(src, { lang: 'english', style: 'neon' }));
  const fallback = decode(await stampVirtuallyStaged(src, { lang: 'english', style: DEFAULT_STAMP_STYLE }));
  same(odd, fallback, 'an unrecognized style renders the default one');
  same(
    decode(await stampVirtuallyStaged(src, { lang: 'english' })),
    fallback,
    'so does omitting it',
  );
});

test('the size slider changes the badge, and cannot shrink it below the readable floor', async () => {
  const e = manifest.entries.english;
  const small = badgeGeometry(1600, 1067, e.width, e.height, { scale: STAMP_SCALE_MIN });
  const mid = badgeGeometry(1600, 1067, e.width, e.height, {});
  const large = badgeGeometry(1600, 1067, e.width, e.height, { scale: STAMP_SCALE_MAX });
  assert.ok(small.fontPx < mid.fontPx, 'the low end is smaller than the default');
  assert.ok(large.fontPx > mid.fontPx, 'the high end is larger');

  // FONT_MIN does not scale down with the slider — the one thing the control may not do is
  // produce a disclosure too small to read. On a small render the low end therefore lands
  // on the floor rather than below it.
  const tiny = badgeGeometry(600, 400, e.width, e.height, { scale: STAMP_SCALE_MIN });
  assert.equal(tiny.fontPx, 13, 'the floor holds at the bottom of the slider');

  // And the fit guard still outranks the user: a badge bigger than the frame is not an
  // option the slider is allowed to reach.
  for (const scale of [STAMP_SCALE_MIN, 1, STAMP_SCALE_MAX]) {
    for (const style of STAMP_STYLE_NAMES) {
      for (const [w, h] of [[768, 1344], [512, 896], [4096, 2731]]) {
        const g = badgeGeometry(w, h, manifest.entries.russian.width, manifest.entries.russian.height, { style, scale });
        assert.ok(g.left >= 0 && g.top >= 0, `${w}×${h} ${style} @${scale}: non-negative offsets`);
        assert.ok(g.left + g.pillW <= w, `${w}×${h} ${style} @${scale}: fits horizontally`);
        assert.ok(g.top + g.pillH <= h, `${w}×${h} ${style} @${scale}: fits vertically`);
      }
    }
  }
});

test('clampStampScale pins the slider to its range', async () => {
  assert.equal(clampStampScale(1.25), 1.25);
  assert.equal(clampStampScale('1.25'), 1.25, 'a form field arrives as a string');
  assert.equal(clampStampScale(99), STAMP_SCALE_MAX, 'above the range');
  assert.equal(clampStampScale(-4), STAMP_SCALE_MIN, 'below it');
  assert.equal(clampStampScale('huge'), 1, 'nonsense falls back to the default');
  assert.equal(clampStampScale(undefined), 1, 'so does nothing at all');
});

test('a scaled-up badge is drawn larger, not just measured larger', async () => {
  // badgeGeometry is pure, so the assertions above pass even if stampVirtuallyStaged never
  // passes the scale through to it. Count the badge's ink on the image itself.
  const src = await sourceUrl(1600, 1067, { r: 0, g: 0, b: 0 });
  const ink = async (scale) => {
    const out = decode(await stampVirtuallyStaged(src, { lang: 'english', scale }));
    const px = await pixels(out);
    let lit = 0;
    for (let y = 700; y < 1067; y++) {
      for (let x = 800; x < 1600; x++) if (px.at(x, y)[0] > 40) lit += 1;
    }
    return lit;
  };
  assert.ok(await ink(STAMP_SCALE_MAX) > await ink(STAMP_SCALE_MIN) * 1.5, 'the big badge covers far more of the corner');
});

test('stampVirtuallyStaged: an unknown language falls back to English rather than failing', async () => {
  // The language comes from the browser's localStorage, so a stale or hand-rolled value is
  // not a reason to fail a paid render — an English stamp still discloses, no stamp does not.
  const src = await sourceUrl(1200, 800);
  const odd = decode(await stampVirtuallyStaged(src, { lang: 'klingon' }));
  const eng = decode(await stampVirtuallyStaged(src, { lang: 'english' }));
  same(odd, eng, 'unknown language renders the English master');

  const missing = decode(await stampVirtuallyStaged(src, {}));
  same(missing, eng, 'omitted language renders the English master');
});

test('stampVirtuallyStaged: distinct languages produce distinct pixels', async () => {
  // Pins the language actually reaching the compositor. If the lang argument were dropped
  // somewhere in the chain, every locale would silently ship the English sentence.
  const src = await sourceUrl(1200, 800);
  const en = decode(await stampVirtuallyStaged(src, { lang: 'english' }));
  const ja = decode(await stampVirtuallyStaged(src, { lang: 'japanese' }));
  differs(en, ja, 'Japanese output differs from English');
});

test('stampVirtuallyStaged: FAILS CLOSED on unusable input — never returns it unstamped', async () => {
  // Deliberately unlike upscaleForDelivery, which fails open. Anyone "making these
  // consistent" would turn a compliance feature into a silent liability, so pin it.
  for (const bad of ['', 'not-a-data-url', 'https://example.com/a.png', null, undefined]) {
    await assert.rejects(
      () => stampVirtuallyStaged(/** @type {string} */ (bad)),
      (err) => /** @type {{ code?: string }} */ (err).code === 'DISCLOSURE_STAMP_FAILED',
      `rejects ${JSON.stringify(bad)} with DISCLOSURE_STAMP_FAILED`,
    );
  }
  await assert.rejects(
    () => stampVirtuallyStaged(`data:image/png;base64,${Buffer.from('not an image').toString('base64')}`),
    (err) => /** @type {{ code?: string }} */ (err).code === 'DISCLOSURE_STAMP_FAILED',
    'undecodable image bytes reject rather than pass through',
  );
});

test('badgeGeometry: the badge stays inside the frame at every aspect ratio and language', async () => {
  const sizes = [[1536, 1024], [1024, 1024], [768, 1344], [2560, 1097], [4096, 2731], [512, 896], [1344, 768]];
  for (const [w, h] of sizes) {
    for (const [lang, e] of Object.entries(manifest.entries)) {
      const g = badgeGeometry(w, h, e.width, e.height);
      const where = `${w}×${h} ${lang}`;
      assert.ok(g.left >= 0 && g.top >= 0, `${where}: non-negative offsets (sharp rejects negatives)`);
      assert.ok(g.left + g.pillW <= w, `${where}: pill fits horizontally (${g.left}+${g.pillW} > ${w})`);
      assert.ok(g.top + g.pillH <= h, `${where}: pill fits vertically`);
      assert.ok(g.pillW <= Math.ceil(0.68 * w) + 1, `${where}: pill within the fit-guard fraction`);
      assert.ok(g.fontPx >= 11 && g.fontPx <= 40, `${where}: type size ${g.fontPx} within [11,40]`);
    }
  }
});

test('badgeGeometry: sits in the BOTTOM-RIGHT, not any other corner', async () => {
  const e = manifest.entries.english;
  const g = badgeGeometry(1600, 1000, e.width, e.height);
  assert.ok(g.left + g.pillW / 2 > 800, 'horizontal centre is in the right half');
  assert.ok(g.top + g.pillH / 2 > 500, 'vertical centre is in the bottom half');
});

test('badgeGeometry: scales with the image rather than staying a fixed pixel size', async () => {
  const e = manifest.entries.english;
  const small = badgeGeometry(800, 533, e.width, e.height);
  const large = badgeGeometry(3200, 2133, e.width, e.height);
  assert.ok(large.fontPx > small.fontPx, 'a 4× larger render gets larger type');
  assert.ok(large.margin >= small.margin, 'and at least as much edge margin');
});
