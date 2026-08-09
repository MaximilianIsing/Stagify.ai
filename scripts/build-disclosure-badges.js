// Build step for the burned-in "virtually staged" disclosure. Run after changing any
// string in STAGING_DISCLOSURE_BADGE (lib/staging/staging-disclosure.js):
//
//   node scripts/build-disclosure-badges.js
//
// It renders each language's badge sentence once, here, offline, and commits the result
// as an alpha PNG master under lib/image/badges/. At request time lib/image/stamp-disclosure.js
// only scales and composites those masters — it never touches a font.
//
// WHY PRE-RENDER INSTEAD OF DRAWING TEXT AT REQUEST TIME
// sharp's text API (`sharp({ text: … })`) goes through pango + fontconfig, and its failure
// mode is not an exception — it is a VALID, FULLY TRANSPARENT layer when no font is found.
// A disclosure that silently renders to nothing is worse than no feature at all. Worse, the
// `fontfile` escape hatch is a silent no-op on this repo's win32 libvips build (it has no
// FcConfigAppFontAddFile symbol): a real path, a bogus path and a nonsense family all
// produce byte-identical output, so a Windows dev box CANNOT validate the font wiring —
// only the Linux container could, at runtime, in front of a paying user.
// Pre-rendering moves that risk to a build step on a machine a human is watching, and makes
// the served pixels byte-identical on every platform.
//
// WHY @napi-rs/canvas AND NOT sharp
// It is already a devDependency, it registers a font file directly instead of going through
// fontconfig discovery, and it never ships to production — this script does not run on
// Render. Nothing here becomes a runtime dependency.
//
// THE FONTS ARE NOT COMMITTED. See to-build/disclosure-badges/README.md for the download
// (Noto Sans + Noto Sans SC/JP/KR, OFL-1.1). Inter — the site's own font — cannot be used:
// it has no CJK glyphs, so zh/ja/ko would render as tofu boxes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { STAGING_DISCLOSURE_BADGE } from '../lib/staging/staging-disclosure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'lib', 'image', 'badges');
const DEFAULT_FONT_DIR = path.join(ROOT, 'to-build', 'disclosure-badges', 'fonts');

// Rendered once at this size, then downscaled per image at request time. Big enough that
// the ~13-40px on-image badge is always a DOWNscale (which stays crisp) rather than an
// upscale (which would not).
const BASE_FONT_PX = 128;
const FONT_WEIGHT = 600; // SemiBold — holds up against a busy photo better than Regular
const CANVAS_W = 6000;   // generous; the master is cropped to its ink bounds anyway
const CANVAS_H = 400;

// Which family covers which language. Noto Sans carries Latin + Latin-ext + Cyrillic, so
// it serves eight of the eleven; the CJK three each get their own regional font so Han
// characters render with the right regional glyph variants (a JP kanji and a SC hanzi can
// be the same codepoint and still be drawn differently).
const FONT_FILES = [
  { family: 'Noto Sans', file: 'NotoSans.ttf' },
  { family: 'Noto Sans SC', file: 'NotoSansSC.ttf' },
  { family: 'Noto Sans JP', file: 'NotoSansJP.ttf' },
  { family: 'Noto Sans KR', file: 'NotoSansKR.ttf' },
];
const FAMILY_FOR_LANG = { chinese: 'Noto Sans SC', japanese: 'Noto Sans JP', korean: 'Noto Sans KR' };

/**
 * Draw one sentence onto a scratch canvas and return its pixels plus its ink bounds.
 *
 * Bounds come from the rendered ALPHA, never from measureText: this repo's variable Noto
 * builds report identical advance widths for weight 400 and 600 even though the glyphs
 * visibly bolden, so trusting the metrics would size the pill too narrow and clip the last
 * character. Ink bounds cannot lie.
 * @param {string} text - The badge sentence.
 * @param {string} family - Registered font family name.
 * @returns {{ px: Uint8ClampedArray, minX: number, maxX: number, minY: number, maxY: number }} Pixels and ink bounds.
 */
function draw(text, family) {
  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext('2d');
  ctx.font = `${FONT_WEIGHT} ${BASE_FONT_PX}px "${family}"`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 40, CANVAS_H / 2);

  const px = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
  let minX = CANVAS_W, minY = CANVAS_H, maxX = -1, maxY = -1;
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      if (px[(y * CANVAS_W + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error(`no glyphs rendered for "${text}" in ${family} — is the font missing those scripts?`);
  return { px, minX, maxX, minY, maxY };
}

/**
 * Crop a drawn sentence to its own ink horizontally but to a SHARED vertical band.
 *
 * The shared band is the point. Cropping vertically to each sentence's own ink would make
 * the master's height depend on whether that translation happens to contain a descender:
 * "Dieses Bild wurde virtuell möbliert" has none and measured 103px tall, while "This image
 * has been virtually staged" has g and y and measured 133px. Scaling each master to a
 * common on-image height would then render German ~29% larger than English. One band for
 * every language keeps the optical size identical and makes every pill the same height.
 * @param {ReturnType<typeof draw>} drawn - Output of draw().
 * @param {number} bandTop - Shared band top edge, in scratch-canvas coordinates.
 * @param {number} bandH - Shared band height in px.
 * @returns {{ data: Buffer, width: number, height: number }} RGBA pixels of the master.
 */
function crop(drawn, bandTop, bandH) {
  const { px, minX, maxX } = drawn;
  const w = maxX - minX + 1;
  const out = Buffer.alloc(w * bandH * 4);
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y + bandTop) * CANVAS_W + (x + minX)) * 4;
      const dst = (y * w + x) * 4;
      // Force RGB to white everywhere, including fully transparent pixels. Canvas leaves
      // RGB at 0 where alpha is 0, and resampling that on the way down would bleed black
      // into the glyph edges — a grey halo around white text on every stamped image.
      out[dst] = 255;
      out[dst + 1] = 255;
      out[dst + 2] = 255;
      out[dst + 3] = px[src + 3];
    }
  }
  return { data: out, width: w, height: bandH };
}

const fontDir = process.env.BADGE_FONT_DIR || DEFAULT_FONT_DIR;
const missing = FONT_FILES.filter((f) => !fs.existsSync(path.join(fontDir, f.file)));
if (missing.length) {
  console.error(`Missing font files in ${fontDir}:\n  ${missing.map((f) => f.file).join('\n  ')}\n`
    + 'See to-build/disclosure-badges/README.md for the download commands, or set BADGE_FONT_DIR.');
  process.exit(1);
}
for (const { family, file } of FONT_FILES) {
  if (!GlobalFonts.registerFromPath(path.join(fontDir, file), family)) {
    console.error(`Failed to register ${file} as "${family}"`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const sharp = (await import('sharp')).default;

// Pass 1: draw every language and find the vertical band that contains all of their ink,
// so pass 2 can crop them all to the same height. Padded by 4px so antialiasing at the
// extremes is never clipped.
const drawn = Object.entries(STAGING_DISCLOSURE_BADGE).map(([lang, text]) => ({
  lang,
  text,
  family: FAMILY_FOR_LANG[lang] || 'Noto Sans',
  ink: draw(text, FAMILY_FOR_LANG[lang] || 'Noto Sans'),
}));
const bandTop = Math.min(...drawn.map((d) => d.ink.minY)) - 4;
const bandH = Math.max(...drawn.map((d) => d.ink.maxY)) + 4 - bandTop + 1;

/** @type {Record<string, { file: string, text: string, sha256: string, width: number, height: number }>} */
const entries = {};
for (const { lang, text, family, ink } of drawn) {
  const { data, width, height } = crop(ink, bandTop, bandH);
  const file = `${lang}.png`;
  await sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT_DIR, file));
  entries[lang] = {
    file,
    text,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    width,
    height,
  };
  console.log(`${lang.padEnd(11)} ${String(width).padStart(4)}×${height}  ${family}`);
}

// Drop masters for languages that no longer exist, so a removed locale can't leave an
// orphan behind that badge-manifest.test.js would then fail on.
for (const stale of fs.readdirSync(OUT_DIR)) {
  if (stale.endsWith('.png') && !entries[stale.replace(/\.png$/, '')]) {
    fs.unlinkSync(path.join(OUT_DIR, stale));
    console.log(`removed orphan ${stale}`);
  }
}

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  `${JSON.stringify({ baseFontPx: BASE_FONT_PX, fontWeight: FONT_WEIGHT, bandHeight: bandH, entries }, null, 2)}\n`,
);
console.log(`\nWrote ${Object.keys(entries).length} masters + manifest.json to lib/image/badges/`);
