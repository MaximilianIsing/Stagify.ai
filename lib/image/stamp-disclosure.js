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
const MARGIN_RATIO = 0.016;      // gap from the image edge, fraction of the long edge
const MARGIN_MIN = 10;
const MARGIN_MAX = 36;
// Fully rounded — the radius is capped at half the height in buildPill(), so this asks for
// a capsule. A chip is what a caption-shaped badge should look like; the earlier gently
// rounded rectangle read as a subtitle bar burnt into the photo, which is exactly the
// "someone watermarked my listing" impression the feature cannot afford.
const RADIUS_RATIO = 0.5;
// The fit guard: the pill may not exceed this share of the image width. A backstop rather
// than a working constraint now that the badge is a two-word tag — the widest master
// (Russian) on a 9:16 portrait still lands well inside it — but it stays because the guard
// is what keeps a future longer translation from running off the edge, and it is set high
// because the alternative to a wide badge is an unreadable one, which discloses nothing.
const MAX_PILL_FRACTION = 0.68;
const RING_RATIO = 0.026;        // hairline width as a fraction of pill height
const SHADOW_BLUR_RATIO = 0.19;  // minimal style: blur radius as a fraction of the type size

/**
 * @typedef {object} StampStyle
 * @property {number} padX        pill padding as a fraction of the type size
 * @property {number} padY        …vertically
 * @property {[number, number, number]} text  glyph colour
 * @property {[number, number, number]|null} fill  capsule colour, or null for no capsule
 * @property {number} fillAlpha
 * @property {[number, number, number]} ring  hairline colour
 * @property {number} ringAlpha   0 for no hairline
 * @property {number} shadowAlpha 0 for no drop shadow behind the glyphs
 */

// THE THREE LOOKS THE USER CAN PICK, and why each is built the way it is.
//
// A translucent pill, not a text shadow, is the default because a shadow alone disappears
// against a blown-out window (white text, white wall, grey halo). The pill is the only
// treatment that stays legible on both a bright window and a dark floor with no content
// analysis, and it reads as a deliberate stamp rather than a compression artifact.
//
// The `dark` hairline is light and the `light` hairline is dark, each for the background
// its fill cannot handle: a dark capsule dissolves into a dark floor, a white one into a
// white wall, and in both cases the outline is the only part still doing any work.
//
// `minimal` is the one the compliance argument had to be made for, because it drops the
// capsule entirely — the treatment the note above says is the reliable one. It ships
// anyway, with a shadow dense enough to survive white, because the realistic alternative
// is not "the user picks a pill": it is the user leaving the whole option off because the
// badge is louder than they will accept on a listing photo, and an unlabelled photo
// discloses nothing at all. The legibility floor is enforced by test rather than by
// judgement — test/image/stamp-disclosure.test.js reads every style back on both a white
// and a black field and fails if the glyphs do not separate from the background.
/** @type {Record<string, StampStyle>} */
export const STAMP_STYLES = {
  // Padding is generous on the horizontal for the two capsules because they are fully
  // rounded: the end caps curve away from the text, so the same numeric padding looks
  // tighter here than it would on a square-cornered box. `minimal` has almost none — with
  // no capsule to sit inside, padding only pushes the text away from the corner.
  dark: {
    padX: 0.95,
    padY: 0.40,
    text: [255, 255, 255],
    // Over pure white, 0.52 lands the capsule at ~#7a7a7a, which holds white text at
    // ~4.2:1. Lighter and the disclosure gets harder to read exactly where photos are
    // brightest; much darker and the badge punches a hole in the photo.
    fill: [0, 0, 0],
    fillAlpha: 0.52,
    ring: [255, 255, 255],
    ringAlpha: 0.26,
    shadowAlpha: 0,
  },
  light: {
    padX: 0.95,
    padY: 0.40,
    // Near-black rather than black: the same ink the site uses, and it keeps the chip from
    // looking like a system dialog dropped onto a photograph.
    text: [23, 24, 28],
    fill: [255, 255, 255],
    fillAlpha: 0.88,
    ring: [0, 0, 0],
    ringAlpha: 0.10,
    shadowAlpha: 0,
  },
  minimal: {
    padX: 0.30,
    padY: 0.30,
    text: [255, 255, 255],
    // No capsule at all, so the fill and hairline are switched off rather than left
    // undefined: `style.fillAlpha > 0` decides whether the pill layer is built, and an
    // undefined there is false only by accident.
    fill: null,
    fillAlpha: 0,
    ring: [0, 0, 0],
    ringAlpha: 0,
    shadowAlpha: 0.78,
  },
};

/** The style used for anything unrecognized, and by every caller that does not choose. */
export const DEFAULT_STAMP_STYLE = 'dark';
/** Valid `stampStyle` values, for the request validator and the frontend's radio group. */
export const STAMP_STYLE_NAMES = Object.keys(STAMP_STYLES);

// The size slider's range, as a multiplier on the type size the badge would otherwise get.
// Asymmetric on purpose: 1.0 is already the size this thing should be, so most of the
// travel is upward, for the agent who wants the disclosure unmissable.
export const STAMP_SCALE_MIN = 0.7;
export const STAMP_SCALE_MAX = 1.6;
export const STAMP_SCALE_DEFAULT = 1;

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
 * Resolve a style name, falling back rather than throwing for the same reason the language
 * does: it arrives from the browser, and a stale or hand-rolled value is not a reason to
 * fail a paid render. A badge in the wrong style still discloses; no badge does not.
 * @param {string} [name] - A key of STAMP_STYLES.
 * @returns {StampStyle} The style to draw.
 */
export function resolveStampStyle(name) {
  return STAMP_STYLES[String(name || '').toLowerCase()] || STAMP_STYLES[DEFAULT_STAMP_STYLE];
}

/**
 * Coerce the size slider's value into the supported range. Shared by the request validator
 * and the preview route so the two cannot disagree about what "1.35" means.
 * @param {unknown} value - Whatever arrived on the request.
 * @returns {number} A multiplier in [STAMP_SCALE_MIN, STAMP_SCALE_MAX], to 2 decimals.
 */
export function clampStampScale(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return STAMP_SCALE_DEFAULT;
  return Math.round(Math.min(STAMP_SCALE_MAX, Math.max(STAMP_SCALE_MIN, n)) * 100) / 100;
}

/**
 * Work out where the badge goes and how big it is. Pure — no I/O, no sharp — so the
 * sizing rules can be tested across aspect ratios without rendering anything.
 *
 * The fit guard is the part that earns its keep. The badge tag varies a lot in length
 * between languages (the Chinese master is 510px wide against Russian's 1647 at the same
 * type size), so a width that is comfortable in one language can run off the edge in
 * another — most visibly on a 9:16 portrait render. Rather than iterating, it solves for
 * the type size that lands the pill exactly at MAX_PILL_FRACTION and takes the smaller of
 * that and the ideal size. The user's size slider is applied BEFORE that guard, so asking
 * for a bigger badge than the frame can hold gets a badge that fits, not one that spills.
 * @param {number} imageW - Image width in px.
 * @param {number} imageH - Image height in px.
 * @param {number} masterW - Badge master width in px.
 * @param {number} masterH - Badge master height in px.
 * @param {{ style?: string, scale?: number }} [options] - The user's badge style and size multiplier.
 * @returns {{ fontPx: number, textW: number, textH: number, padX: number, padY: number, pillW: number, pillH: number, radius: number, ring: number, margin: number, left: number, top: number }} Placement in image pixels.
 */
export function badgeGeometry(imageW, imageH, masterW, masterH, options = {}) {
  const style = resolveStampStyle(options.style);
  const sizeScale = clampStampScale(options.scale ?? STAMP_SCALE_DEFAULT);
  const long = Math.max(imageW, imageH);
  // FONT_MIN is an absolute readability floor and does NOT scale down with the slider — a
  // disclosure the buyer cannot read is the one thing the slider may not produce. The
  // ceiling does scale, because a user who drags it up has decided the badge should be
  // louder than the default restraint, and that is their call to make.
  const ideal = Math.min(
    Math.round(FONT_MAX * sizeScale),
    Math.max(FONT_MIN, Math.round(long * FONT_RATIO * sizeScale)),
  );

  // pillW(f) ≈ f * (masterW / baseFontPx) + 2 * f * padX, so the size that puts the pill
  // exactly at the cap is a straight division — no search loop.
  const widthPerPx = masterW / manifest.baseFontPx + 2 * style.padX;
  const fitted = Math.floor((MAX_PILL_FRACTION * imageW) / widthPerPx);
  const fontPx = Math.max(FONT_FLOOR, Math.min(ideal, fitted));

  const scale = fontPx / manifest.baseFontPx;
  const textW = Math.max(1, Math.round(masterW * scale));
  const textH = Math.max(1, Math.round(masterH * scale));
  const padX = Math.round(fontPx * style.padX);
  const padY = Math.round(fontPx * style.padY);
  const pillW = textW + padX * 2;
  const pillH = textH + padY * 2;
  const radius = Math.round(pillH * RADIUS_RATIO);
  // Never below 1px: a sub-pixel hairline would render as a faint grey smear along the
  // edge, which looks like a compression halo rather than an outline.
  const ring = Math.max(1, Math.round(pillH * RING_RATIO));
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
    ring,
    margin,
    // max(0, …) keeps the composite inside the frame even on a pathologically narrow image
    // where the floored type size still overflows — sharp rejects a negative offset.
    left: Math.max(0, imageW - pillW - margin),
    top: Math.max(0, imageH - pillH - margin),
  };
}

/**
 * Signed distance from a point to the edge of a rounded rectangle — negative inside,
 * positive outside, in pixels. Used instead of the per-corner arc test the mask builders
 * use because it describes the whole outline in one expression, which is what makes an
 * evenly-inset copy of that outline (the hairline) a single subtraction rather than a
 * second set of corner cases.
 * @param {number} x - Sample x, in pill pixels.
 * @param {number} y - Sample y, in pill pixels.
 * @param {number} w - Pill width in px.
 * @param {number} h - Pill height in px.
 * @param {number} r - Corner radius in px.
 * @returns {number} Distance to the outline; negative inside.
 */
function roundedRectDistance(x, y, w, h, r) {
  const halfW = (w - 1) / 2;
  const halfH = (h - 1) / 2;
  const qx = Math.abs(x - halfW) - (halfW - r);
  const qy = Math.abs(y - halfH) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Build the translucent capsule as raw RGBA, the same hand-rolled-buffer approach
 * buildMarkedRoomImage() uses in image-primitives.js (no SVG, so no rasterizer and no font
 * anywhere in this path).
 *
 * Two shapes, one buffer: the fill, and a hairline sitting just inside its edge. They are
 * flattened here rather than composited as two sharp layers because sharp would then blend
 * two antialiased edges over each other and leave a visibly darker seam where the ring's
 * outer fade meets the fill's.
 * @param {number} w - Pill width in px.
 * @param {number} h - Pill height in px.
 * @param {number} radius - Corner radius in px.
 * @param {number} ring - Hairline width in px.
 * @param {StampStyle} style - Supplies the fill and hairline colours.
 * @returns {Buffer} Raw RGBA pixels, w*h*4 bytes.
 */
function buildPill(w, h, radius, ring, style) {
  const buf = Buffer.alloc(w * h * 4);
  const r = Math.min(radius, Math.floor(Math.min(w, h) / 2));
  const fill = style.fill || [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = roundedRectDistance(x, y, w, h, r);
      // Coverage from the distance, so the outline is antialiased rather than stepped — a
      // hard-edged curve reads as a JPEG block at these sizes.
      const outer = Math.min(1, Math.max(0, 0.5 - d));
      const inner = Math.min(1, Math.max(0, 0.5 - (d + ring)));
      const ringA = style.ringAlpha * (outer - inner);
      const fillA = style.fillAlpha * outer;
      // Hairline OVER the fill, resolved to the single RGBA sample sharp will composite
      // onto the photo.
      const alpha = ringA + fillA * (1 - ringA);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[i + c] = alpha > 0
          ? Math.round((style.ring[c] * ringA + fill[c] * fillA * (1 - ringA)) / alpha)
          : fill[c];
      }
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

/**
 * Load the language's master and recolour its glyphs, returning raw RGBA.
 *
 * The masters are white text on transparency, so a style with dark glyphs cannot just
 * composite one — it has to repaint the RGB. Repainting every pixel, transparent ones
 * included, is deliberate and matches what the generator does: leaving stale colour under
 * alpha 0 bleeds it into the glyph edges the moment anything resamples the layer.
 * @param {BadgeEntry} entry - The master to load.
 * @param {number} w - Target width in px.
 * @param {number} h - Target height in px.
 * @param {StampStyle} style - Supplies the glyph colour.
 * @returns {Promise<{ data: Buffer, width: number, height: number }>} The text layer.
 */
async function buildTextLayer(entry, w, h, style) {
  const { data, info } = await sharp(path.join(BADGE_DIR, entry.file))
    .resize(w, h, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = style.text[0];
    data[i + 1] = style.text[1];
    data[i + 2] = style.text[2];
  }
  return { data, width: info.width, height: info.height };
}

/**
 * Blur a text layer's alpha into a soft dark shadow, so the `minimal` style stays readable
 * with no capsule under it.
 *
 * Hand-rolled for the same reason buildPill is: this is one small buffer (a few hundred by
 * sixty pixels), and doing it here keeps the shadow's density under direct control instead
 * of chasing what sharp's blur does to an alpha channel it is also premultiplying.
 * Two box-blur passes rather than one — a single pass leaves a visibly square halo.
 *
 * `pad` is what stops the shadow from being clipped to the glyphs' own box: the layer is
 * grown on every side and composited that much further up and left.
 * @param {{ data: Buffer, width: number, height: number }} text - The recoloured text layer.
 * @param {number} radius - Box-blur radius in px.
 * @param {number} pad - Padding added on every side, in px.
 * @param {number} alpha - Peak shadow opacity, 0-1.
 * @returns {{ data: Buffer, width: number, height: number }} The shadow layer.
 */
function buildTextShadow(text, radius, pad, alpha) {
  const w = text.width + pad * 2;
  const h = text.height + pad * 2;
  let src = new Float32Array(w * h);
  for (let y = 0; y < text.height; y++) {
    for (let x = 0; x < text.width; x++) {
      src[(y + pad) * w + (x + pad)] = text.data[(y * text.width + x) * 4 + 3];
    }
  }

  let dst = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = x + k;
          if (sx < 0 || sx >= w) continue;
          sum += src[y * w + sx];
          n += 1;
        }
        dst[y * w + x] = sum / n;
      }
    }
    [src, dst] = [dst, src];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = y + k;
          if (sy < 0 || sy >= h) continue;
          sum += src[sy * w + x];
          n += 1;
        }
        dst[y * w + x] = sum / n;
      }
    }
    [src, dst] = [dst, src];
  }

  // Blurring spreads a glyph's alpha over the whole kernel, so the peak drops to a fraction
  // of what it was. SHADOW_GAIN pushes it back up and lets it saturate: what a drop shadow
  // needs is a dense core under the letterforms with a soft edge, not a faithfully dimmed
  // copy of them.
  const SHADOW_GAIN = 2.7;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4 + 3] = Math.min(255, Math.round(src[i] * SHADOW_GAIN * alpha));
  }
  return { data: out, width: w, height: h };
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
 * @param {{ lang?: string, style?: string, scale?: number }} [options] - `lang` is a name from
 *   lib/i18n/locales.js; `style` a key of STAMP_STYLES; `scale` the size slider's multiplier.
 * @returns {Promise<string>} A `data:image/png;base64,...` URL with the badge burned in.
 * @throws {Error & { code: 'DISCLOSURE_STAMP_FAILED' }} On any failure — never returns the input unstamped.
 */
export async function stampVirtuallyStaged(dataUrl, options = {}) {
  const entry = resolveEntry(options.lang);
  const style = resolveStampStyle(options.style);

  const m = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!m) throw stampError('input is not a base64 data URL');

  let image;
  try {
    const buffer = Buffer.from(m[2], 'base64');
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error('could not read image dimensions');

    const g = badgeGeometry(meta.width, meta.height, entry.width, entry.height, options);
    const text = await buildTextLayer(entry, g.textW, g.textH, style);
    const textLeft = g.left + g.padX;
    const textTop = g.top + g.padY;

    /** @type {import('sharp').OverlayOptions[]} */
    const layers = [];
    if (style.fillAlpha > 0 || style.ringAlpha > 0) {
      layers.push({
        input: buildPill(g.pillW, g.pillH, g.radius, g.ring, style),
        raw: { width: g.pillW, height: g.pillH, channels: 4 },
        left: g.left,
        top: g.top,
        blend: 'over',
      });
    }
    if (style.shadowAlpha > 0) {
      const radius = Math.max(1, Math.round(g.fontPx * SHADOW_BLUR_RATIO));
      // The shadow spills outside the glyphs, so its layer is grown by `pad` and moved back
      // up and left by the same amount. Capped by how much room there actually is above and
      // left of the text — sharp rejects a negative offset — and by the margin on the other
      // two sides, since a layer running past the frame is an error, not a clip.
      const pad = Math.max(0, Math.min(radius * 2, textLeft, textTop, g.margin + g.padX - 1, g.margin + g.padY - 1));
      const shadow = buildTextShadow(text, radius, pad, style.shadowAlpha);
      layers.push({
        input: shadow.data,
        raw: { width: shadow.width, height: shadow.height, channels: 4 },
        left: textLeft - pad,
        top: textTop - pad,
        blend: 'over',
      });
    }
    layers.push({
      input: text.data,
      raw: { width: text.width, height: text.height, channels: 4 },
      left: textLeft,
      top: textTop,
      blend: 'over',
    });

    const composited = sharp(buffer).composite(layers);

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
