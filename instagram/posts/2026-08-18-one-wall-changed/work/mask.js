// Paint the mask, exactly as a Masking Studio user would paint it.
//
// The region is the big tiled wall behind the bath, minus the things standing in front of
// it. It is built in two halves, and the split is the lesson of this post:
//
//   THE WALL is a hand-drawn polygon, because its edges are architecture. Corners and the
//   ceiling line are straight, they are where a person would say the wall ends, and no
//   amount of pixel inspection improves on measuring them off a coordinate grid.
//
//   THE TAP is derived from the photograph, because it is a thin cross and no arrangement
//   of rectangles approximates it. Every attempt kept a corner of wall the tap does not
//   actually cover, that corner held the ORIGINAL tile, and it landed in the finished post
//   as a hard-edged white halo around the fitting.
//
// The bath is drawn, not derived, and that is a correction to a first attempt at deriving
// it. Thresholding finds the bath's bright outer skin and misses its shaded INTERIOR, which
// sits within a couple of levels of the wall tone, so half the tub came back classified as
// wall and went into the brush. Bright-against-grey is a safe test for a thin chrome tap
// surrounded by clean tile, and an unsafe one for a large object with its own shading.
//
// That failure was invisible while the new tile was nearly the same colour as the old one.
// The moment the wall went properly green, an image reviewer found three of them, including
// a white rectangular halo around the tap that the post's own legend invited the reader to
// go and look at. The geometry had been wrong the whole time; only the contrast was new.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(fs.readFileSync(path.join(HERE, 'source.json'), 'utf8'));
const { width: W, height: H } = await sharp(source.path).metadata();

// The tiled wall. Left edge is the internal corner at x=132, right edge the corner at
// x=755, top runs off the frame. The bottom traces the bath: along its far rim, then down
// its right flank, then out to the wall-to-floor junction at y=806 in the strip beside it.
//
// That strip is the fix for a real miss. An earlier bottom edge ran straight from the rim
// to the right corner at y=683, which cut off the whole run of wall visible to the RIGHT of
// the tub, between it and the corner, all the way down to the skirting. With the tile still
// nearly white nobody noticed; with the tile emerald it was a white wedge in the corner of
// the frame, and an image reviewer called it out as the wall being painted two colours.
const WALL = [
  [133, 100],
  [197, 20],
  [750, 6],
  [750, 806],   // down the internal corner to the skirting
  [664, 806],   // left along the floor junction to the foot of the bath
  [668, 790],   // then up the bath's right flank, two pixels clear of it
  [675, 760],
  [685, 730],
  [691, 700],   // the tub's widest point
  [687, 672],
  [670, 656],
  [550, 651],   // along the far rim, about five pixels above it
  [384, 648],
  [200, 661],
  [133, 683],
];

// Where to look for things standing in front of the wall, and how far a pixel has to sit
// from its LOCAL surroundings before it counts as one of them.
//
// Local, not global. Comparing against a single wall tone does not work: the tile runs from
// about 185 in shadow to 225 on a lit grout line, so any threshold tight enough to catch
// the tap also catches every grout line and the sheen down the right of the wall, and the
// first attempt left big pale blocks of unbrushed wall scattered round the fitting. Against
// a blurred copy of its own neighbourhood, a grout line is a few levels of nothing and the
// chrome is unmistakable.
const OBJECTS = [
  { name: 'tap', box: [330, 486, 428, 686], contrast: 26 },
  // Insurance only. The towels sit below the polygon's rim edge already, so this normally
  // marks nothing; it is here so a towel that pokes above the rim cannot be tiled over.
  { name: 'towels on the rim', box: [478, 640, 640, 716], contrast: 26 },
];
// Radius of the neighbourhood each pixel is judged against. Wide enough that the tap is a
// local anomaly rather than part of its own background.
const LOCAL_RADIUS = 10;
// Grow every derived silhouette by this much.
//
// One pixel, not three. Three was chosen to be safe and is the wrong direction to err in.
// Every pixel of margin is a pixel of the ORIGINAL wall kept alive next to the tap, and once
// the tile went emerald that margin showed up at full size as a white outline tracing the
// fitting, which is the same halo the rectangles produced, merely better shaped. Erring the
// other way costs almost nothing: a pixel shaved off the inside of the margin is a pixel of
// new tile against chrome, which reads as the tile meeting the tap, because it is.
const GROW = 1;

const points = WALL.map(([x, y]) => `${x},${y}`).join(' ');
const wallSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#000"/>
  <polygon points="${points}" fill="#fff"/>
</svg>`;
const wallMask = await sharp(Buffer.from(wallSvg)).extractChannel(0).raw().toBuffer();

// Greyscale copy of the photograph, and a blurred copy of it standing in for "what the wall
// is doing around here".
const grey = await sharp(source.path).greyscale().raw().toBuffer();
const local = await sharp(source.path).greyscale().blur(LOCAL_RADIUS).raw().toBuffer();

// Mark every pixel inside a search box that stands out from its own neighbourhood.
const isObject = new Uint8Array(W * H);
for (const { box: [x0, y0, x1, y1], contrast } of OBJECTS) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * W + x;
      if (Math.abs(grey[i] - local[i]) > contrast) isObject[i] = 1;
    }
  }
}

// Grow the silhouettes. Separable: a horizontal pass then a vertical one, which is a square
// kernel rather than a disc and is the right shape for covering an edge halo cheaply.
function grow(src, radius) {
  const mid = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!src[y * W + x]) continue;
      const lo = Math.max(0, x - radius);
      const hi = Math.min(W - 1, x + radius);
      for (let k = lo; k <= hi; k += 1) mid[y * W + k] = 1;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!mid[y * W + x]) continue;
      const lo = Math.max(0, y - radius);
      const hi = Math.min(H - 1, y + radius);
      for (let k = lo; k <= hi; k += 1) out[k * W + x] = 1;
    }
  }
  return out;
}
const grown = grow(isObject, GROW);

// The brush: inside the wall, and not on anything standing in front of it.
const brush = Buffer.alloc(W * H);
let brushed = 0;
for (let i = 0; i < W * H; i += 1) {
  const on = wallMask[i] > 127 && !grown[i];
  brush[i] = on ? 255 : 0;
  if (on) brushed += 1;
}

const maskPath = path.join(HERE, 'mask.png');
await sharp(brush, { raw: { width: W, height: H, channels: 1 } })
  .toColourspace('b-w')
  .png()
  .toFile(maskPath);

// Read the file back and prove it is the mask that was computed.
//
// Worth the twenty lines because the mask is the one input nothing downstream can sanity
// check. It is handed to the model as a locator and used again to composite, so a mask that
// picked up encoder noise on the way to disk would put that noise on the brush edge, and the
// only symptom would be a slightly wrong-looking edge in the finished post. Read back with
// an explicit channel count rather than a trusting index: a greyscale PNG and an RGB one
// both answer .raw(), and reading a 3-channel buffer as though it were 1 channel produces a
// convincing periodic pattern that looks exactly like a bug in the mask itself. That
// misreading cost real time here, twice.
const { data: readBack, info: readInfo } = await sharp(maskPath).raw().toBuffer({ resolveWithObject: true });
const stride = readInfo.channels;
let drift = 0;
for (let i = 0; i < W * H; i += 1) {
  if ((readBack[i * stride] > 127) !== (brush[i] > 127)) drift += 1;
}
if (drift) throw new Error(`mask.png does not match the computed mask: ${drift} pixel(s) differ.`);

// Overlay it on the photograph so the brushed area can be checked by eye before a render is
// spent on it, in the same magenta the product's own locator uses.
const magenta = await sharp({
  create: { width: W, height: H, channels: 3, background: { r: 255, g: 0, b: 200 } },
}).raw().toBuffer();
// joinChannel APPENDS, so a 4-channel base would gain a fifth and the alpha would be
// ignored, painting the whole frame magenta.
const alpha = Buffer.from(brush.map((v) => Math.round(v * 0.5)));
const tint = await sharp(magenta, { raw: { width: W, height: H, channels: 3 } })
  .joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } })
  .png()
  .toBuffer();
const tinted = await sharp(source.path).composite([{ input: tint, blend: 'over' }]).png().toBuffer();
await sharp(tinted).resize(650).jpeg({ quality: 90 }).toFile(path.join(HERE, 'preview-mask.jpg'));

console.log(`mask     ${W}x${H} -> ${maskPath}`);
console.log(`brushed  ${(brushed / (W * H) * 100).toFixed(1)}% of the frame`);
