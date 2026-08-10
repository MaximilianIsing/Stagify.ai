/**
 * Builds the LinkedIn company-page cover banner.
 *
 * Source master — not runtime code. Run from the repo root so `sharp` resolves:
 *   node to-build/brand/linkedin/make-banner.js
 *
 * Before2/After2 are the same camera on the same room, so scaling both to the
 * banner width and taking the identical horizontal band makes the wipe line up
 * pixel for pixel: one continuous room where the furniture appears at the seam.
 */
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(OUT_DIR, '../../..');
const SRC = path.join(ROOT, 'public/media-webp/Homepage/BeforeAfter');
fs.mkdirSync(OUT_DIR, { recursive: true });

// LinkedIn company cover renders at 1128x191. Author at 2x for retina.
const W = 2256;
const H = 382;
const SEAM = Math.round(W * 0.38);

// Source photos are 1280x860 -> 2256x1516 once scaled to banner width.
// BAND_TOP picks which 382px band of that survives the 5.9:1 crop.
const BAND_TOP = Number(process.env.BAND_TOP || 700);

async function band(file, { desaturate = 1 } = {}) {
  return sharp(path.join(SRC, file))
    .resize({ width: W })
    .extract({ left: 0, top: BAND_TOP, width: W, height: H })
    .modulate({ saturation: desaturate })
    .toBuffer();
}

const afterBand = await band('After2.webp');
const beforeBand = await band('Before2.webp', { desaturate: 0.8 });

const beforeSlice = await sharp(beforeBand)
  .extract({ left: 0, top: 0, width: SEAM, height: H })
  .toBuffer();

const svg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0.56" stop-color="#1e3a8a" stop-opacity="0"/>
      <stop offset="0.70" stop-color="#1e3a8a" stop-opacity="0.55"/>
      <stop offset="0.82" stop-color="#1e3a8a" stop-opacity="0.92"/>
      <stop offset="1"    stop-color="#1e3a8a" stop-opacity="0.96"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0"   stop-color="#93c5fd" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#93c5fd" stop-opacity="0.5"/>
      <stop offset="1"   stop-color="#93c5fd" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="lift" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"    stop-color="#0b1a3a" stop-opacity="0.28"/>
      <stop offset="0.55" stop-color="#0b1a3a" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>
  <rect x="0" y="0" width="${W}" height="140" fill="url(#lift)"/>

  <!-- seam: soft glow + crisp line -->
  <rect x="${SEAM - 26}" y="0" width="52" height="${H}" fill="url(#glow)"/>
  <rect x="${SEAM - 2}" y="0" width="4" height="${H}" fill="#ffffff" opacity="0.92"/>

  <g font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="21" letter-spacing="2.2">
    <rect x="56" y="42" width="150" height="46" rx="23" fill="#ffffff" opacity="0.94"/>
    <text x="131" y="72" fill="#1e3a8a" text-anchor="middle">BEFORE</text>

    <rect x="${SEAM + 42}" y="42" width="132" height="46" rx="23" fill="#2563eb"/>
    <text x="${SEAM + 108}" y="72" fill="#ffffff" text-anchor="middle">AFTER</text>
  </g>

  <g font-family="Segoe UI, Arial, sans-serif" text-anchor="end">
    <text x="${W - 80}" y="192" font-size="56" font-weight="700" fill="#ffffff">Staged in seconds.</text>
    <text x="${W - 80}" y="238" font-size="24" font-weight="400" fill="#dbeafe">AI virtual staging for real estate listings.</text>
    <rect x="${W - 80 - 88}" y="264" width="88" height="5" rx="2.5" fill="#60a5fa"/>
  </g>
</svg>`;

const png = await sharp(afterBand)
  .composite([
    { input: beforeSlice, left: 0, top: 0 },
    { input: Buffer.from(svg), left: 0, top: 0 },
  ])
  .png()
  .toBuffer();

const name = process.env.OUT_NAME || 'linkedin-banner';
await sharp(png).toFile(path.join(OUT_DIR, `${name}-2256x382.png`));
await sharp(png).resize(1128, 191).toFile(path.join(OUT_DIR, `${name}-1128x191.png`));

console.log('written to', OUT_DIR);
