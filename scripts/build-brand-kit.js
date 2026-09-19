// Build step for the downloadable brand kit linked from /about#brand-kit. Run after
// changing any logo master, or any brand token in public/styles/styles.css:
//
//   node scripts/build-brand-kit.js
//
// It copies the brand masters out of to-build/ into public/brand/, writes the
// palette into public/brand/README.txt, and packs the whole folder into
// public/brand/stagify-brand-kit.zip. All of its output is COMMITTED — the script
// does not run on Render, exactly like scripts/build-disclosure-badges.js.
//
// WHY THE MASTERS ARE COPIED AND NOT LINKED
// to-build/ is design source: it is out of the ESLint scope, out of express.static,
// and its filenames are internal (Logo180x180.png, Stagify_pfp.png). What a
// journalist or a partner downloads should be named for what it is, and should live
// under public/ where the static middleware already caches images immutably. The
// copy is the boundary between those two worlds, and this script is the only thing
// allowed to write across it.
//
// WHY THE PALETTE IS PARSED, NOT RETYPED
// public/styles/styles.css is the single source of truth for the brand colours
// (test/frontend/css-tokens.test.js enforces that for the sheets). A README that
// restated the hexes by hand would be a sixth copy waiting to go stale, so the
// swatch values are read out of :root at build time. test/frontend/brand-kit.test.js
// checks the same tokens against the swatch markup in about.html.
//
// CACHING: public/brand/*.png|svg are served `immutable` for a year by the static
// middleware, under stable filenames. So a master that changes will NOT reach anybody
// who has already downloaded the old one — the usual rule in docs/reference/caching.md
// applies: rename the file (and its link in about.html) rather than replacing it in
// place. The zip is not in that cache list and revalidates, so it is safe to replace.
//
// NOT IN THE KIT: a vector wordmark. public/bimi-logo.svg is the only SVG the brand
// owns and it is the icon; the "Stagify.ai" wordmark is rendered as markup
// (.brand-strong + .brand-light in the site header), not as artwork. Ship the PNGs
// honestly rather than tracing something and calling it official.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip-archive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'brand');
const STYLES = path.join(ROOT, 'public', 'styles', 'styles.css');

export const ZIP_NAME = 'stagify-brand-kit.zip';

/**
 * The kit, as `published name -> source path relative to the repo root`.
 *
 * Exported so test/frontend/brand-kit.test.js can assert that every one of these
 * exists under public/brand/ and appears in the zip — i.e. that somebody edited a
 * master and forgot to rerun this script.
 *
 * @type {Record<string, string>}
 */
export const KIT_FILES = {
  'stagify-logo-full.png': 'to-build/media-png/logo/logo-full.png',
  'stagify-icon-180.png': 'to-build/media-png/logo/Logo180x180.png',
  'stagify-icon-64.png': 'to-build/media-png/logo/Logo64x64.png',
  'stagify-icon.svg': 'public/bimi-logo.svg',
  'stagify-avatar.png': 'to-build/brand/pfp/Stagify_pfp.png',
  'stagify-og-image.png': 'to-build/OG_Image/OG_Image.png',
};

/**
 * The swatches shown on /about and listed in the README, as `token -> display name`.
 *
 * Six of the palette, not all twenty: this is what somebody drawing a Stagify logo
 * lockup or a partner badge needs. The full ramp stays in styles.css, where the app
 * actually uses it.
 *
 * @type {Record<string, string>}
 */
export const PALETTE_TOKENS = {
  '--brand': 'Brand blue',
  '--brand-strong': 'Strong blue',
  '--brand-deep': 'Navy',
  '--brand-soft': 'Soft blue',
  '--brand-tint': 'Tint',
  '--text-heading': 'Ink',
};

/**
 * Read the brand hexes out of the `:root` block in styles.css.
 *
 * Comments are stripped first — the prose above :root names several tokens inline
 * (`--primary is deliberately NOT redefined to #2563eb`) and would otherwise be read
 * as declarations.
 *
 * @returns {Record<string, string>} token -> lowercase hex, for PALETTE_TOKENS only.
 */
export function readPalette() {
  const css = fs.readFileSync(STYLES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {Record<string, string>} */
  const out = {};
  for (const token of Object.keys(PALETTE_TOKENS)) {
    const m = css.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
    if (!m) throw new Error(`${token} is not defined in public/styles/styles.css`);
    out[token] = m[1].toLowerCase();
  }
  return out;
}

/**
 * The plain-text usage sheet that ships inside the zip.
 * @param {Record<string, string>} palette @returns {string}
 */
function readmeText(palette) {
  const swatches = Object.entries(PALETTE_TOKENS)
    .map(([token, name]) => `  ${name.padEnd(20)} ${palette[token]}   (CSS token ${token})`)
    .join('\n');

  return `Stagify.ai brand kit
====================

Everything in this archive may be used to refer to Stagify.ai — in press, in a
partner or integration listing, in a review, in documentation. You do not need to
ask first.

FILES
  stagify-logo-full.png   Full logo. Use this one unless you need a square.
  stagify-icon-180.png    Square icon, 180x180.
  stagify-icon-64.png     Square icon, 64x64, for favicons and small inline marks.
  stagify-icon.svg        Square icon as vector. Scales to any size.
  stagify-avatar.png      Profile picture, as used on our social accounts.
  stagify-og-image.png    1200x630 social preview card.

  There is no vector wordmark: "Stagify.ai" is set in Inter, not drawn. Set it as
  type rather than scaling up a PNG of it.

COLOURS
${swatches}

TYPE
  Inter, at weights 400, 600 and 700. Free from https://rsms.me/inter/ and also
  on Google Fonts. Where Inter is unavailable, any neutral grotesque is fine —
  we fall back to the system UI stack ourselves.

PLEASE DO
  Use the logo as supplied, at any size, on white or on a dark background.
  Keep clear space around it of at least the height of the mark's cap height.
  Write the name as "Stagify.ai" — one word, capital S, lowercase .ai.

PLEASE DO NOT
  Recolour, rotate, outline, add effects to, or redraw the mark.
  Stretch it non-proportionally.
  Use it in a way that implies we endorse, sponsor or supply your product.
  Use it as your own app icon, avatar, or favicon.
  Combine it with another mark into a single lockup.

NOT US
  stagify.io, stagify.app, stagify.online and stagifyai.com are unrelated
  companies with similar names. This kit is only for Stagify.ai.

The current version of this kit is always at https://stagify.ai/brand
Questions, or need a format that is not here: https://stagify.ai/contact.html
`;
}

/**
 * Copy the masters, write the README, and pack the zip.
 * @returns {void}
 */
function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const palette = readPalette();

  /** @type {{ name: string, data: Buffer }[]} */
  const members = [];

  for (const [name, src] of Object.entries(KIT_FILES)) {
    const from = path.join(ROOT, src);
    if (!fs.existsSync(from)) throw new Error(`missing brand master: ${src}`);
    const data = fs.readFileSync(from);
    fs.writeFileSync(path.join(OUT_DIR, name), data);
    members.push({ name, data });
    console.log(`  ${src}  ->  public/brand/${name}  (${data.length} bytes)`);
  }

  // LF, not the platform newline: the file is committed, and a CRLF README would
  // flip every line of the diff when the script is next run on a Mac or on CI.
  const readme = Buffer.from(readmeText(palette), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'), readme);
  members.push({ name: 'README.txt', data: readme });
  console.log('  (generated)  ->  public/brand/README.txt');

  const zip = createZip(members);
  fs.writeFileSync(path.join(OUT_DIR, ZIP_NAME), zip);
  console.log(`\n${ZIP_NAME}: ${members.length} files, ${zip.length} bytes`);
}

// Importable for the tests, runnable as a script — the same split the other build
// scripts use.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
