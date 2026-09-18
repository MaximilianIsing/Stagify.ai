// Read geometry off a cover's pixels, the way to-build/media-png/blog/covers/README.md
// describes: find the flat region a plate must cover, then the ink bands inside it.
import { createCanvas, loadImage } from '@napi-rs/canvas';

const file = process.argv[2];
const img = await loadImage(file);
const W = img.width, H = img.height;
const c = createCanvas(W, H);
const ctx = c.getContext('2d');
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;
const at = (x, y) => {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

console.log(`${file}  ${W}x${H}`);

const cmd = process.argv[3];

if (cmd === 'col') {
  // Vertical scan of one column: print runs of constant colour.
  const x = +process.argv[4];
  let y0 = 0, prev = hex(at(x, 0));
  for (let y = 1; y <= H; y++) {
    const cur = y < H ? hex(at(x, y)) : null;
    if (cur !== prev) {
      if (y - y0 > 1) console.log(`  y ${String(y0).padStart(4)}..${String(y - 1).padStart(4)} (${String(y - y0).padStart(4)})  ${prev}`);
      y0 = y; prev = cur;
    }
  }
} else if (cmd === 'row') {
  const y = +process.argv[4];
  let x0 = 0, prev = hex(at(0, y));
  for (let x = 1; x <= W; x++) {
    const cur = x < W ? hex(at(x, y)) : null;
    if (cur !== prev) {
      if (x - x0 > 1) console.log(`  x ${String(x0).padStart(4)}..${String(x - 1).padStart(4)} (${String(x - x0).padStart(4)})  ${prev}`);
      x0 = x; prev = cur;
    }
  }
} else if (cmd === 'ink') {
  // Ink bands inside a box: rows whose pixels differ from the box's dominant colour.
  const [x, y, w, h] = process.argv.slice(4, 8).map(Number);
  const mode = process.argv[8] || 'auto';
  // dominant colour = most common in the box
  const counts = new Map();
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const k = hex(at(xx, yy));
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const bg = [...counts].sort((a, b) => b[1] - a[1])[0];
  const bgLum = lum(at(x, y));
  console.log(`  bg ${bg[0]} (${((bg[1] / (w * h)) * 100).toFixed(1)}% of box)  mode=${mode}`);
  const isInk = (p) => {
    const l = lum(p);
    if (mode === 'dark') return l < bgLum - 40;
    if (mode === 'light') return l > bgLum + 40;
    return Math.abs(l - bgLum) > 40;
  };
  const bands = [];
  let start = null;
  for (let yy = y; yy < y + h; yy++) {
    let n = 0, minX = 1e9, maxX = -1;
    for (let xx = x; xx < x + w; xx++) {
      if (isInk(at(xx, yy))) { n++; if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; }
    }
    if (n > 0) {
      if (!start) start = { y0: yy, minX, maxX };
      else { start.minX = Math.min(start.minX, minX); start.maxX = Math.max(start.maxX, maxX); }
      start.y1 = yy;
    } else if (start) { bands.push(start); start = null; }
  }
  if (start) bands.push(start);
  for (const b of bands) {
    const bh = b.y1 - b.y0 + 1;
    console.log(`  band y ${b.y0}..${b.y1} (h=${bh})  x ${b.minX}..${b.maxX} (w=${b.maxX - b.minX + 1})`
      + `  capSize≈${(bh / 0.714).toFixed(0)}  capDescSize≈${(bh / 0.924).toFixed(0)}  baseline≈${b.y1}`);
  }
}
