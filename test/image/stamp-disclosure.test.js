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
import { badgeGeometry, stampVirtuallyStaged } from '../../lib/image/stamp-disclosure.js';
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
