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
//
// THE FOUR FIELDS
// The same mark sits on four backgrounds — blue (Stagify.ai), gold (Stagify+), navy
// with a skyline (Enterprise) and navy with a grid (the API) — and the site already
// paints all four: stagify-plus.html, enterprise.html, developers.html and
// scripts/profile-menu.js read them out of public/media-webp/logo/. The kit ships the
// PNG masters of the same artwork, so a partner writing about Stagify+ has the gold
// field rather than cropping it out of a screenshot. The webp copies stay where they
// are: they are page assets, and the kit is a download.

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
  // The core mark.
  'stagify-logo-full.png': 'to-build/media-png/logo/logo-full.png',
  'stagify-icon-180.png': 'to-build/media-png/logo/Logo180x180.png',
  'stagify-icon-64.png': 'to-build/media-png/logo/Logo64x64.png',
  'stagify-icon-32.png': 'to-build/media-png/logo/Logo32x32.png',
  'stagify-icon.svg': 'public/bimi-logo.svg',

  // Stagify+ — the subscription. Gold field, same mark.
  'stagify-plus-logo-full.png': 'to-build/media-png/logo/pro-full.png',
  'stagify-plus-icon-180.png': 'to-build/media-png/logo/Pro180x180.png',
  'stagify-plus-icon-64.png': 'to-build/media-png/logo/Pro64x64.png',
  'stagify-plus-icon-32.png': 'to-build/media-png/logo/Pro32x32.png',

  // Stagify Enterprise — domain-wide accounts. Navy field with the skyline.
  'stagify-enterprise-logo-full.png': 'to-build/media-png/logo/enterprise-full.png',
  'stagify-enterprise-icon-180.png': 'to-build/media-png/logo/Enterprise180x180.png',
  'stagify-enterprise-icon-64.png': 'to-build/media-png/logo/Enterprise64x64.png',
  'stagify-enterprise-icon-32.png': 'to-build/media-png/logo/Enterprise32x32.png',

  // Stagify API — the developer platform. Navy field with the grid.
  'stagify-api-logo-full.png': 'to-build/media-png/logo/api-full.png',
  'stagify-api-icon-180.png': 'to-build/media-png/logo/Api180x180.png',
  'stagify-api-icon-64.png': 'to-build/media-png/logo/Api64x64.png',
  'stagify-api-icon-32.png': 'to-build/media-png/logo/Api32x32.png',

  // Social.
  'stagify-avatar.png': 'to-build/brand/pfp/Stagify_pfp.png',
  'stagify-linkedin-logo.png': 'to-build/brand/linkedin/LinkedIn-logo.png',
  'stagify-og-image.png': 'to-build/OG_Image/OG_Image.png',
};

/**
 * The swatches shown on /about and listed in the README, as `token -> display name`.
 *
 * Nine of the palette, not all twenty: the blue ramp end to end, plus the slate the
 * site sets secondary text in and the ink it sets headings in. That is what somebody
 * drawing a partner badge or a press page needs. The rest of the ramp — the status
 * colours, the CTA gradient stops — stays in styles.css, where the app uses it.
 *
 * @type {Record<string, string>}
 */
export const PALETTE_TOKENS = {
  '--brand': 'Brand blue',
  '--brand-strong': 'Strong blue',
  '--brand-deep': 'Navy',
  '--brand-soft': 'Soft blue',
  '--brand-pale': 'Pale blue',
  '--brand-tint': 'Tint',
  '--brand-wash': 'Wash',
  '--slate': 'Slate',
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

THE FOUR MARKS
  Stagify.ai has one mark on four fields. The drawing never changes; only what is
  behind it does. Pick the field that matches what you are writing about, and if in
  doubt use the blue one.

    Blue             Stagify.ai itself — the product, the company, the website.
    Gold             Stagify+, the subscription.
    Navy + skyline   Stagify Enterprise, the domain-wide plan.
    Navy + grid      The Stagify API, for developer and integration listings.

FILES
  Core (blue)
    stagify-logo-full.png             The mark at 356x356, transparent.
    stagify-icon-180.png              180x180, for app tiles and touch icons.
    stagify-icon-64.png               64x64, for small inline marks.
    stagify-icon-32.png               32x32, for favicons and table rows.
    stagify-icon.svg                  Vector. Scales to any size; use it if you can.

  Stagify+ (gold)
    stagify-plus-logo-full.png        356x356.
    stagify-plus-icon-180.png         180x180.
    stagify-plus-icon-64.png          64x64.
    stagify-plus-icon-32.png          32x32.

  Stagify Enterprise (navy, skyline)
    stagify-enterprise-logo-full.png  356x356.
    stagify-enterprise-icon-180.png   180x180.
    stagify-enterprise-icon-64.png    64x64.
    stagify-enterprise-icon-32.png    32x32.

  Stagify API (navy, grid)
    stagify-api-logo-full.png         356x356.
    stagify-api-icon-180.png          180x180.
    stagify-api-icon-64.png           64x64.
    stagify-api-icon-32.png           32x32.

  Social
    stagify-avatar.png                512x512 profile picture, as used on our accounts.
    stagify-linkedin-logo.png         The square company logo as LinkedIn shows it.
    stagify-og-image.png              1200x630 social preview card.

  The core mark is the only one supplied as vector. The three product fields are
  raster only — at the sizes they are used for (a badge, a plan row, a listing) the
  180px file is already past what a screen resolves.

  There is no vector wordmark: "Stagify.ai" is set in Inter, not drawn. Set it as
  type rather than scaling up a PNG of it.

COLOURS
${swatches}

  The gold of the Stagify+ field and the navy of the Enterprise and API fields are
  part of those artworks, not site tokens. Take them from the PNGs if you need them;
  do not repaint the blue mark in either.

TYPE
  Inter, at weights 400, 600 and 700. Free from https://rsms.me/inter/ and also
  on Google Fonts. Where Inter is unavailable, any neutral grotesque is fine —
  we fall back to the system UI stack ourselves.

  The name is one word: Stagify.ai. Capital S, lowercase .ai, no space, no hyphen.
  The products are written "Stagify+" (no space before the plus), "Stagify
  Enterprise" and "the Stagify API". In running text after the first mention,
  "Stagify" on its own is fine.

CLEAR SPACE AND MINIMUM SIZE
  Keep clear space around the mark of at least the height of the "S". Do not place
  anything — type, rules, another logo — inside that margin.

  Minimum size is 24px on screen and 8mm in print. Below that the tripod and the
  lamp collapse into a smudge; use the 32px file rather than scaling 180 down.

PLEASE DO
  Use the marks as supplied, at any size, on white or on a dark background.
  Use the field that matches the product you are writing about.
  Write the name as "Stagify.ai" — one word, capital S, lowercase .ai.

PLEASE DO NOT
  Recolour, rotate, outline, add effects to, or redraw any of the marks.
  Swap a field onto the wrong product, or invent a fifth one.
  Stretch it non-proportionally, or crop the circle.
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
