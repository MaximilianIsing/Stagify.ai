// Overlay a labelled coordinate grid so the mask can be authored from measurements rather
// than from guesses. The first attempt at this post cost three rounds partly because the
// mask edges were eyeballed, and every one of them was wrong in a different direction.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [input, output] = process.argv.slice(2);
const src = path.join(HERE, input ?? 'gen-01.jpg');

const { width: W, height: H } = await sharp(src).metadata();
const STEP = 64;
const parts = [];

for (let x = 0; x <= W; x += STEP) {
  parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#ff00c8" stroke-width="1" opacity="0.7"/>`);
  parts.push(`<text x="${x + 3}" y="15" fill="#ff00c8" font-size="13" font-family="monospace">${x}</text>`);
}
for (let y = 0; y <= H; y += STEP) {
  parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ff00c8" stroke-width="1" opacity="0.7"/>`);
  parts.push(`<text x="4" y="${y - 4}" fill="#ff00c8" font-size="13" font-family="monospace">${y}</text>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;
await sharp(src)
  .composite([{ input: Buffer.from(svg) }])
  .jpeg({ quality: 95 })
  .toFile(path.join(HERE, output ?? 'gen-01-grid.jpg'));

console.log(`${W}x${H} grid every ${STEP}px`);
