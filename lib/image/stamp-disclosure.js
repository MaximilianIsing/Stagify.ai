// Burns the short "virtually staged" disclosure into the bottom-right of a finished render,
// when the user ticked "Label as virtually staged" in the staging modal.
//
// NO FONT AT REQUEST TIME. The eleven sentences are pre-rendered to alpha PNG masters by
// scripts/build-disclosure-badges.js and committed under lib/image/badges/; this module only
// scales one down and composites it over a translucent pill. See
// to-build/disclosure-badges/README.md for why drawing text here was rejected — the short
// version is that sharp's text path fails by producing a VALID, FULLY TRANSPARENT layer when
// fontconfig finds nothing, and a disclosure that silently renders to nothing is worse than
// no feature at all.
//
// THIS MODULE FAILS CLOSED — deliberately the opposite of upscaleForDelivery, which returns
// its input on any error. If the stamp cannot be applied, the render is NOT delivered:
// handing back an image the user believes is labelled, unlabelled, is precisely the MLS /
// NAR Article 12 exposure the feature exists to prevent (see lib/staging/staging-disclosure.js).
// The user's quota is not burned by that: metering in lib/staging/virtual-staging-handler.js
// runs after the render settles, so a rejection never reaches recordFreeGeneration.
//
// A separate module rather than an addition to image-primitives.js only because that file is
// already near the 650-line cap in eslint.config.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const BADGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'badges');

/**
 * @typedef {object} BadgeEntry
 * @property {string} file    PNG filename under lib/image/badges/
 * @property {string} text    the sentence this master depicts
 * @property {string} sha256  hash of `text`, checked by test/image/badge-manifest.test.js
 * @property {number} width   master width in px
 * @property {number} height  master height in px (identical across languages)
 */

/** @type {{ baseFontPx: number, fontWeight: number, bandHeight: number, entries: Record<string, BadgeEntry> }} */
const manifest = JSON.parse(fs.readFileSync(path.join(BADGE_DIR, 'manifest.json'), 'utf8'));

// Geometry, all derived from the image's long edge so a 1 MP model output and a 4K pro
// render get a proportionally identical stamp. Measured on the POST-crop, PRE-upscale
// image — the delivery upscale enlarges the badge along with everything else.
const FONT_RATIO = 0.020;        // badge type size as a fraction of the long edge
const FONT_MIN = 13;             // …never smaller than this (px), or it stops being readable
const FONT_MAX = 40;             // …never larger than this, or it reads as a watermark
const FONT_FLOOR = 11;           // absolute floor the fit guard may shrink to
const PAD_X_RATIO = 0.70;        // pill padding, as a fraction of the type size
const PAD_Y_RATIO = 0.42;
const MARGIN_RATIO = 0.016;      // gap from the image edge, fraction of the long edge
const MARGIN_MIN = 10;
const MARGIN_MAX = 36;
const RADIUS_RATIO = 0.30;       // corner radius as a fraction of pill height
// The fit guard: the pill may not exceed this share of the image width. Only binds on
// narrow/portrait renders (a 3:2 landscape never reaches it), so it is set for legibility
// rather than restraint — at 0.55 a 9:16 portrait in a long language like Russian or
// Italian was driven down to 17px type against a 31px landscape, and an unreadable
// disclosure discloses nothing. 0.68 still leaves a third of the width clear.
const MAX_PILL_FRACTION = 0.68;
const PILL_ALPHA = 122;          // ~0.48 — see note below

// A translucent dark pill, not a text shadow. A shadow alone disappears against a
// blown-out window (white text, white wall, grey halo); the pill is the only treatment
// that stays legible on both a bright window and a dark floor with no content analysis,
// and it reads as a deliberate stamp rather than a compression artifact.
const PILL_R = 0;
const PILL_G = 0;
const PILL_B = 0;

/** Data-URL shape, matching upscaleForDelivery's parser in image-primitives.js. */
const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

/**
 * Fail closed with a stable code the routes and the frontend both branch on.
 * @param {string} message - Operator-facing detail.
 * @returns {Error & { code: string }} The error to throw.
 */
function stampError(message) {
  const err = /** @type {Error & { code: string }} */ (new Error(`Disclosure stamp failed: ${message}`));
  err.code = 'DISCLOSURE_STAMP_FAILED';
  return err;
}

/**
 * Pick the master for a language, falling back to English exactly as
 * disclosureBadgeText() does — the two must agree or the pixels would disagree with the
 * string the rest of the app thinks it stamped.
 * @param {string} [lang] - A `lang` name from lib/i18n/locales.js, e.g. 'german'.
 * @returns {BadgeEntry} The master to composite.
 */
function resolveEntry(lang) {
  const entry = manifest.entries[String(lang || '').toLowerCase()] || manifest.entries.english;
  // English missing means the committed assets are corrupt or absent, not that the caller
  // asked for something odd. Fail closed rather than shipping an unlabelled image.
  if (!entry) throw stampError('no badge masters found in lib/image/badges/');
  return entry;
}

/**
 * Work out where the badge goes and how big it is. Pure — no I/O, no sharp — so the
 * sizing rules can be tested across aspect ratios without rendering anything.
 *
 * The fit guard is the part that earns its keep. The badge sentence varies enormously in
 * length between languages (the Chinese master is 1143px wide against Italian's 2851 at
 * the same type size), so a width that is comfortable in one language can run off the edge
 * in another — most visibly on a 9:16 portrait render. Rather than iterating, it solves
 * for the type size that lands the pill exactly at MAX_PILL_FRACTION and takes the smaller
 * of that and the ideal size.
 * @param {number} imageW - Image width in px.
 * @param {number} imageH - Image height in px.
 * @param {number} masterW - Badge master width in px.
 * @param {number} masterH - Badge master height in px.
 * @returns {{ fontPx: number, textW: number, textH: number, padX: number, padY: number, pillW: number, pillH: number, radius: number, margin: number, left: number, top: number }} Placement in image pixels.
 */
export function badgeGeometry(imageW, imageH, masterW, masterH) {
  const long = Math.max(imageW, imageH);
  const ideal = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(long * FONT_RATIO)));

  // pillW(f) ≈ f * (masterW / baseFontPx) + 2 * f * PAD_X_RATIO, so the size that puts the
  // pill exactly at the cap is a straight division — no search loop.
  const widthPerPx = masterW / manifest.baseFontPx + 2 * PAD_X_RATIO;
  const fitted = Math.floor((MAX_PILL_FRACTION * imageW) / widthPerPx);
  const fontPx = Math.max(FONT_FLOOR, Math.min(ideal, fitted));

  const scale = fontPx / manifest.baseFontPx;
  const textW = Math.max(1, Math.round(masterW * scale));
  const textH = Math.max(1, Math.round(masterH * scale));
  const padX = Math.round(fontPx * PAD_X_RATIO);
  const padY = Math.round(fontPx * PAD_Y_RATIO);
  const pillW = textW + padX * 2;
  const pillH = textH + padY * 2;
  const radius = Math.round(pillH * RADIUS_RATIO);
  const margin = Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.round(long * MARGIN_RATIO)));

  return {
    fontPx,
    textW,
    textH,
    padX,
    padY,
    pillW,
    pillH,
    radius,
    margin,
    // max(0, …) keeps the composite inside the frame even on a pathologically narrow image
    // where the floored type size still overflows — sharp rejects a negative offset.
    left: Math.max(0, imageW - pillW - margin),
    top: Math.max(0, imageH - pillH - margin),
  };
}

/**
 * Build the rounded translucent pill as raw RGBA, the same hand-rolled-buffer approach
 * buildMarkedRoomImage() uses in image-primitives.js (no SVG, so no rasterizer and no font
 * anywhere in this path).
 * @param {number} w - Pill width in px.
 * @param {number} h - Pill height in px.
 * @param {number} radius - Corner radius in px.
 * @returns {Buffer} Raw RGBA pixels, w*h*4 bytes.
 */
function buildPill(w, h, radius) {
  const buf = Buffer.alloc(w * h * 4);
  const r = Math.min(radius, Math.floor(Math.min(w, h) / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance past the corner arc, so the rounding is antialiased rather than stepped —
      // a hard-edged corner reads as a JPEG block at these sizes.
      let coverage = 1;
      const dx = x < r ? r - x : (x >= w - r ? x - (w - r - 1) : 0);
      const dy = y < r ? r - y : (y >= h - r ? y - (h - r - 1) : 0);
      if (dx > 0 && dy > 0) {
        coverage = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(dx, dy)));
      }
      const i = (y * w + x) * 4;
      buf[i] = PILL_R;
      buf[i + 1] = PILL_G;
      buf[i + 2] = PILL_B;
      buf[i + 3] = Math.round(PILL_ALPHA * coverage);
    }
  }
  return buf;
}

/**
 * Composite the localized "virtually staged" disclosure onto the bottom-right of a render.
 *
 * Called from processStaging() BEFORE the onNative gallery hook and before
 * upscaleForDelivery, so the one call covers every copy of the image — the API response,
 * the user's download, and the gallery master that gets re-downloaded months later. Moving
 * it after the upscale would leave the stored copy unlabelled, which is the failure that
 * actually reaches a buyer.
 *
 * The badge is composited pre-upscale and then goes through lanczos3 ×2 + sharpen. That is
 * fine: lanczos UPscaling of antialiased text does not alias, and the faint ringing it does
 * produce lands on the translucent pill edge where nothing can see it. If badge crispness is
 * ever raised as a complaint, the fix is NOT to move this call after the upscale — it is to
 * composite the text at 2× and lanczos-downscale it into place.
 * @param {string} dataUrl - The finished image as a `data:<mime>;base64,...` URL.
 * @param {{ lang?: string }} [options] - `lang` is a name from lib/i18n/locales.js.
 * @returns {Promise<string>} A `data:image/png;base64,...` URL with the badge burned in.
 * @throws {Error & { code: 'DISCLOSURE_STAMP_FAILED' }} On any failure — never returns the input unstamped.
 */
export async function stampVirtuallyStaged(dataUrl, options = {}) {
  const entry = resolveEntry(options.lang);

  const m = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!m) throw stampError('input is not a base64 data URL');

  let image;
  try {
    const buffer = Buffer.from(m[2], 'base64');
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error('could not read image dimensions');

    const g = badgeGeometry(meta.width, meta.height, entry.width, entry.height);
    const text = await sharp(path.join(BADGE_DIR, entry.file))
      .resize(g.textW, g.textH, { fit: 'fill' })
      .png()
      .toBuffer();

    const composited = sharp(buffer)
      .composite([
        { input: buildPill(g.pillW, g.pillH, g.radius), raw: { width: g.pillW, height: g.pillH, channels: 4 }, left: g.left, top: g.top, blend: 'over' },
        { input: text, left: g.left + g.padX, top: g.top + g.padY, blend: 'over' },
      ]);

    // Compositing an RGBA overlay onto an opaque RGB render leaves the RESULT carrying a
    // pointless all-255 alpha channel — a third more raw bytes, for nothing. Match whatever
    // the input had so the stamp never changes an image's channel count behind the caller's
    // back; the gallery and the delivery encode both re-read this buffer.
    image = await (meta.hasAlpha ? composited : composited.removeAlpha()).png().toBuffer();
  } catch (error) {
    // Re-wrap so callers only ever see the one code, whatever sharp threw underneath.
    throw stampError(error instanceof Error ? error.message : String(error));
  }

  return `data:image/png;base64,${image.toString('base64')}`;
}
