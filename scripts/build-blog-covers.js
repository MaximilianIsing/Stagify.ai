// Render the localized blog cover images.
//
//   node scripts/build-blog-covers.js [--cover=cover-10] [--lang=es] [--check]
//
// Six of the fifteen blog covers carry English words burned into the picture — an eyebrow,
// a headline, a row of labels. Served unchanged under /es/blog/… they put English type on
// the largest, most shareable asset the article has: the og:image a reader sees before they
// see the page. This script repaints those regions and redraws the type per language.
//
// THE ENGLISH COVERS ARE NEVER TOUCHED. Only `cover-N.<lang>.webp` and its two derivatives
// are written, so the existing assets — and the English pages that reference them — cannot
// regress, and the brand face (Inter) survives where anyone would notice it. The localized
// variants are set in Noto, which is a deliberate trade: see "Fonts" below.
//
// WHY node-canvas AND NOT sharp's TEXT API. Exactly the reasoning in
// to-build/disclosure-badges/README.md, which solved this problem first and whose font set
// this reuses. sharp's `text:` goes through pango + fontconfig, and when no font is found
// it does not throw — it returns a fully transparent layer. A cover that silently renders
// its headline to nothing is worse than shipping English. The `fontfile` escape hatch is a
// silent no-op on this repo's win32 libvips build. @napi-rs/canvas registers a font FILE
// and fails loudly, so the wiring is verifiable on the machine doing the rendering.
//
// FONTS. Noto Sans (Latin + Cyrillic) plus the three regional CJK families, downloaded to
// to-build/disclosure-badges/fonts/ — the same directory, the same files, the same licence.
// Inter is the site's font but has no CJK glyphs, so a localized cover set cannot use it
// without rendering zh/ja/ko as tofu. See that README for the download commands.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { LOCALES } from '../lib/i18n/locales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'public', 'media-webp', 'blog');
const RECIPE = path.join(ROOT, 'to-build', 'media-png', 'blog', 'covers');
const DEFAULT_FONT_DIR = path.join(ROOT, 'to-build', 'disclosure-badges', 'fonts');

const FONT_FILES = [
  { family: 'Noto Sans', file: 'NotoSans.ttf' },
  { family: 'Noto Sans SC', file: 'NotoSansSC.ttf' },
  { family: 'Noto Sans JP', file: 'NotoSansJP.ttf' },
  { family: 'Noto Sans KR', file: 'NotoSansKR.ttf' },
];
/** @type {Record<string, string>} */
const FAMILY_FOR_LANG = { chinese: 'Noto Sans SC', japanese: 'Noto Sans JP', korean: 'Noto Sans KR' };

/** Derivative sizes, matching what the existing English covers ship. */
const OG = { width: 1200, height: 630 };
const THUMB_WIDTH = 800;

/**
 * Wrap `text` to at most `maxW` px, breaking on spaces for spaced scripts and between
 * characters for CJK, which does not use them.
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {string} text
 * @param {number} maxW
 * @returns {string[]}
 */
function wrap(ctx, text, maxW) {
  const spaced = /\s/.test(text.trim());
  const units = spaced ? text.split(/\s+/) : [...text];
  const joiner = spaced ? ' ' : '';
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const unit of units) {
    const next = line ? line + joiner + unit : unit;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = unit;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draw one text block, shrinking the type until the wrapped result fits its box.
 *
 * Shrink-to-fit is not a nicety. The same headline is two words in English and five in
 * German, and a fixed size either clips the German or leaves the English looking timid.
 * The box is the design constraint; the size is what gives.
 *
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {{text: string, x: number, y: number, maxW: number, maxH?: number, size: number,
 *   minSize?: number, weight?: number, fill?: string, tracking?: number, lineHeight?: number,
 *   align?: 'left'|'right', upper?: boolean, noWrap?: boolean, anchor?: 'top'|'bottom'}} item
 * @param {string} family
 */
function drawBlock(ctx, item, family) {
  const text = item.upper ? String(item.text).toUpperCase() : String(item.text);
  const minSize = item.minSize ?? Math.round(item.size * 0.6);
  let size = item.size;
  /** @type {string[]} */
  let lines = [];

  for (; size >= minSize; size -= 1) {
    ctx.font = `${item.weight ?? 400} ${size}px "${family}"`;
    ctx.letterSpacing = `${item.tracking ?? 0}px`;
    // `noWrap` is for the label/value rows of a table-like card: a row that wraps stops
    // lining up with the row beside it and pushes the last one out through the bottom of
    // the card. Those shrink instead, which keeps the grid a grid.
    lines = item.noWrap ? [text] : wrap(ctx, text, item.maxW);
    const lh = size * (item.lineHeight ?? 1.15);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (widest <= item.maxW && (!item.maxH || lines.length * lh <= item.maxH)) break;
  }

  ctx.fillStyle = item.fill ?? '#0f1729';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = item.align ?? 'left';
  const lh = size * (item.lineHeight ?? 1.15);
  // Which end of the block `y` pins. A headline is anchored to its LAST baseline so it
  // keeps sitting just above the rule below it whether the language needs one line or
  // three; anchoring the first line instead would leave a short translation floating in a
  // gap sized for the English. Everything else grows downward from a fixed top.
  const first = item.anchor === 'bottom' ? item.y - (lines.length - 1) * lh : item.y;
  lines.forEach((line, i) => ctx.fillText(line, item.x, first + i * lh));
}

/**
 * Draw one line made of several differently-styled runs, shrunk as a unit to fit `maxW`.
 *
 * The covers set a figure and its caption on the same baseline at very different sizes —
 * "**77%** of new homes for sale are unfinished", "**$0** on the free plan". Splitting
 * those into two independently-placed items would work in English and fall apart in every
 * other language, because the caption's x depends on how wide the figure's word rendered.
 * Laying them out together and scaling the group keeps the relationship the design has.
 *
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {{x: number, y: number, maxW: number, runs: any[], align?: 'left'|'right'}} item
 * @param {Record<string, any>} strings
 * @param {string} family
 */
function drawRuns(ctx, item, strings, family) {
  const parts = item.runs.map((r) => ({
    ...r,
    text: r.text ?? (r.key ? (r.upper ? String(resolve(strings, r.key) ?? '').toUpperCase() : resolve(strings, r.key)) : null),
  }));
  if (parts.some((p) => p.text == null)) throw new Error(`missing run text in ${JSON.stringify(item.runs.map((r) => r.key))}`);

  let scale = 1;
  const widthAt = (/** @type {number} */ k) => parts.reduce((sum, p) => {
    ctx.font = `${p.weight ?? 400} ${Math.round(p.size * k)}px "${family}"`;
    ctx.letterSpacing = `${(p.tracking ?? 0) * k}px`;
    return sum + ctx.measureText(p.text).width + (p.gapBefore ?? 0) * k;
  }, 0);
  while (scale > 0.5 && widthAt(scale) > item.maxW) scale -= 0.02;

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let x = item.align === 'right' ? item.x - widthAt(scale) : item.x;
  for (const p of parts) {
    ctx.font = `${p.weight ?? 400} ${Math.round(p.size * scale)}px "${family}"`;
    ctx.letterSpacing = `${(p.tracking ?? 0) * scale}px`;
    ctx.fillStyle = p.fill ?? '#ffffff';
    x += (p.gapBefore ?? 0) * scale;
    ctx.fillText(p.text, x, item.y);
    const w = ctx.measureText(p.text).width;
    if (p.strike) {
      // Struck-through prices are a claim the design makes ("$16-$75 → $0"), so the rule
      // has to track the text it crosses out rather than sit at a fixed width.
      ctx.fillRect(x, item.y - Math.round(p.size * scale) * 0.28, w, Math.max(2, Math.round(p.size * scale * 0.05)));
    }
    x += w;
  }
}

/**
 * Repaint a cover's text regions and draw the localized type over them.
 * @param {any} recipe
 * @param {Record<string, any>} strings  this language's text for this cover
 * @param {string} family
 * @returns {Promise<Buffer>} PNG of the finished 1600x900 cover
 */
async function renderCover(recipe, strings, family) {
  const basePath = path.join(MEDIA, recipe.base);
  const base = sharp(basePath);
  const { width, height } = await base.metadata();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. The plates. Each covers one region of burned-in English so it can be redrawn.
  //    A plate is either a flat fill or a single clean row of the original stretched down
  //    its height — the second exists for gradient bands, which no flat colour can match
  //    and which are vertically uniform, so one row IS the whole band.
  for (const plate of recipe.plates || []) {
    if (plate.rowFrom !== undefined) {
      const strip = await sharp(basePath)
        .extract({ left: plate.x, top: plate.rowFrom, width: plate.w, height: 1 })
        .resize({ width: plate.w, height: plate.h, fit: 'fill' })
        .png()
        .toBuffer();
      // loadImage, not `new Image()` with a Buffer src: that decodes lazily, so drawImage
      // silently paints nothing and the English text shows straight through the plate.
      const img = await loadImage(strip);
      ctx.drawImage(img, plate.x, plate.y);
    } else {
      ctx.fillStyle = plate.fill;
      roundRect(ctx, plate.x, plate.y, plate.w, plate.h, plate.rx ?? 0);
      ctx.fill();
    }
  }

  // 2. The rules — hairlines the plates wiped out.
  for (const rule of recipe.rules || []) {
    ctx.fillStyle = rule.fill ?? '#e5e7eb';
    ctx.fillRect(rule.x, rule.y, rule.w, rule.h ?? 1);
  }

  // 3. Dots and other small solid marks. Drawn as geometry rather than as a bullet
  //    CHARACTER because the variable Noto builds this repo ships have no U+25CF, and a
  //    missing glyph renders as a tofu box — which looks like a bug on a brand asset.
  for (const c of recipe.circles || []) {
    ctx.fillStyle = c.fill;
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4. The type.
  for (const item of recipe.items) {
    if (item.runs) { drawRuns(ctx, item, strings, family); continue; }
    const text = resolve(strings, item.key);
    if (text == null) throw new Error(`no text for key '${item.key}'`);
    drawBlock(ctx, { ...item, text }, family);
  }

  const overlay = canvas.toBuffer('image/png');
  return sharp(basePath).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}

/**
 * Rounded-rect path.
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Dotted-path lookup.
 * @param {unknown} obj
 * @param {string} key
 * @returns {string | null}
 */
function resolve(obj, key) {
  let cur = obj;
  for (const part of String(key).split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = /** @type {Record<string, unknown>} */ (cur)[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * Write the served trio for one rendered cover.
 * @param {Buffer} png @param {string} coverId @param {string} lang
 */
async function writeDerivatives(png, coverId, lang) {
  const stem = path.join(MEDIA, `${coverId}.${lang}`);
  await sharp(png).webp({ quality: 82 }).toFile(`${stem}.webp`);
  await sharp(png).resize(THUMB_WIDTH).webp({ quality: 80 }).toFile(`${stem}-thumb.webp`);
  await sharp(png).resize(OG.width, OG.height, { fit: 'cover' }).jpeg({ quality: 82 }).toFile(`${stem}-og.jpg`);
  return [`${coverId}.${lang}.webp`, `${coverId}.${lang}-thumb.webp`, `${coverId}.${lang}-og.jpg`];
}

async function main() {
  const args = process.argv.slice(2);
  const only = (/** @type {string} */ flag) => (args.find((a) => a.startsWith(`--${flag}=`)) || '').split('=')[1] || null;
  const onlyCover = only('cover');
  const onlyLang = only('lang');

  const fontDir = process.env.BADGE_FONT_DIR || DEFAULT_FONT_DIR;
  const missing = FONT_FILES.filter((f) => !fs.existsSync(path.join(fontDir, f.file)));
  if (missing.length) {
    throw new Error(
      `missing font(s): ${missing.map((m) => m.file).join(', ')} in ${fontDir}. `
      + 'See to-build/disclosure-badges/README.md for the download commands, or set BADGE_FONT_DIR.',
    );
  }
  for (const { file } of FONT_FILES) {
    if (!GlobalFonts.registerFromPath(path.join(fontDir, file))) {
      throw new Error(`could not register ${file} — refusing to render text in an unknown face`);
    }
  }

  const recipes = JSON.parse(fs.readFileSync(path.join(RECIPE, 'covers.json'), 'utf8'));
  const written = [];

  for (const [coverId, recipe] of Object.entries(recipes)) {
    if (onlyCover && coverId !== onlyCover) continue;
    for (const locale of LOCALES) {
      if (onlyLang && locale.prefix !== onlyLang && locale.lang !== onlyLang) continue;
      const textFile = path.join(RECIPE, 'text', `${locale.lang}.json`);
      if (!fs.existsSync(textFile)) {
        console.log(`skip ${coverId}/${locale.lang}: no text file`);
        continue;
      }
      const strings = JSON.parse(fs.readFileSync(textFile, 'utf8'))[coverId];
      if (!strings) {
        console.log(`skip ${coverId}/${locale.lang}: no strings for this cover`);
        continue;
      }
      const family = FAMILY_FOR_LANG[locale.lang] || 'Noto Sans';
      const png = await renderCover(recipe, strings, family);
      written.push(...(await writeDerivatives(png, coverId, locale.lang)));
      console.log(`${coverId}.${locale.lang}`);
    }
  }

  writeManifest();
  console.log(`Done. ${written.length} file(s) written.`);
}

/**
 * Regenerate lib/i18n/blog-covers-manifest.js from the variants on disk.
 *
 * Committed rather than scanned at import for the reason lib/i18n/blog-packs.js gives at
 * length: the renderer must not do filesystem work to answer "does this image exist", and
 * a generated-and-committed file turns a forgotten rebuild into a failing test instead of
 * a broken <img> in one language nobody checks.
 */
function writeManifest() {
  /** @type {Record<string, string[]>} */
  const found = {};
  for (const name of fs.readdirSync(MEDIA)) {
    const m = /^(cover-\d+)\.([a-z]+)\.webp$/.exec(name);
    if (!m) continue;
    (found[m[1]] ||= []).push(m[2]);
  }
  const order = LOCALES.map((l) => l.lang);
  const rows = Object.keys(found)
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((id) => `  '${id}': [${order.filter((l) => found[id].includes(l)).map((l) => `'${l}'`).join(', ')}],`);

  const file = path.join(ROOT, 'lib', 'i18n', 'blog-covers-manifest.js');
  const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = prior.includes('\r\n') ? '\r\n' : '\n';
  const body = [
    '// GENERATED FILE — do not edit by hand.',
    '// Regenerate with `node scripts/build-blog-covers.js`.',
    '//',
    '// Which blog covers have a localized variant rendered, and in which languages. A cover',
    '// absent from this map has no text to translate, or text that cannot be swapped — see',
    '// lib/i18n/blog-covers.js. Either way its English image is served everywhere.',
    '',
    '/** @type {Record<string, string[]>} */',
    'export const BLOG_COVER_LOCALES = {',
    ...rows,
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(file, body.split('\n').join(eol));
  console.log('lib/i18n/blog-covers-manifest.js regenerated');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

export { wrap, drawBlock, drawRuns, renderCover };
