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
  [750, 900],
  [133, 900],
];

// The bottom edge is NOT in that polygon. It is found per column, below.
//
// It used to be, as a run of hand-placed vertices tracing the bath's rim and right flank,
// and it was the last thing in this post to go wrong. A bath is an ellipse; a polyline
// through seven measured points cuts inside the curve in some places and leaves a margin
// outside it in others, and once the wall went dark green both errors became obvious at
// full size: a stair-stepped white band of original tile along the whole rim, a flat
// chamfer across the tub's top right corner where a chord cut the curve, and a stray white
// stub where a vertex fell wide. Hand-drawn is right for architecture and wrong for a
// silhouette, which is the same lesson the tap taught one round earlier.
//
// So: for every column, find the topmost row occupied by anything standing at the bottom of
// the frame, and treat everything below it as not-wall. The bath announces itself as a run
// of bright rim pixels; the towels are darker than the tile and are caught by contrast; and
// in the strip to the right of the tub, where neither exists, the wall simply runs down to
// the skirting.
// The rim is found as an EDGE, not as a brightness. Brightness alone does not separate
// them: the wall carries specular highlights that reach 255, brighter than the rim, so a
// plain threshold fired early on a glint or a lit grout line and excluded everything below
// it, which rendered as white posts standing up out of the bath. What is actually
// distinctive about the rim is that it is a step. The wall above it sits at 167 to 228 and
// the rim jumps to 246 to 252 within a single row, whereas a highlight arrives gradually.
const BATH_SCAN = {
  xFrom: 88, xTo: 692, yFrom: 560, yTo: 880,
  bright: 238,  // above anything the wall reaches inside this band
  run: 4,       // and it has to stay bright, so a one-row glint is not a rim
  stepOver: 6,  // compare against the pixel this far above
  step: 30,     // and require a jump of at least this much
};
// Right of the tub there is no bath to find, so the wall's own floor junction is used.
const SKIRTING = { xFrom: 693, xTo: 752, y: 812 };

// Where to look for things standing in front of the wall, and how far a pixel has to sit
// from its LOCAL surroundings before it counts as one of them.
//
// Per ROW, not per pixel-neighbourhood, and not against one global tone.
//
// A single wall tone does not work: the tile runs from about 185 in shadow to 225 on a lit
// grout line, so a threshold tight enough to catch the tap also catches every grout line.
//
// A blurred copy of the pixel's own neighbourhood does not work either, and this one was
// subtle enough to reach the finished post. The blur that stands in for "the wall around
// here" is itself darkened by the tap, so the real wall NEXT TO the tap no longer matches
// its own background and gets marked as object too. The result was a pale cone of
// unrecoloured wall flaring out from the tap down to the bath rim, about a tenth of the
// frame wide, sitting directly under the pin whose caption invites the reader to look at
// the tap.
//
// The median of the row inside the box is immune to that: it is a robust estimator, so the
// tap can sit in the middle of the row without moving it, as long as the tap is a minority
// of the row's width.
// Both the tap and the towels are found from the pixels, each against a background chosen
// so the thing it is hunting cannot contaminate it.
//
// Detection was tried for the tap and cannot work here, for a reason worth writing down: the
// tap throws a soft shadow onto the wall to its right, and measured against the row median
// that shadow deviates by -43 to -73 while the tap itself deviates by -57 to -79. There is no
// threshold between them. Every attempt therefore excluded the shadow as though it were part
// of the fitting, which left a pale cone of unrecoloured wall flaring from the tap down to
// the bath rim. The shadow is wall. It must be recoloured, and the model repaints it happily.
//
// So the tap is described directly, as five thin rectangles measured off a 4x crop: spout,
// body, lever, hand-shower riser and its handle. It is a rigid assembly of thin parts, its
// bounding boxes are honest at this size, and no rectangle contains any shadow.
const TAP = {
  // Tight around the fitting, and stopping at x=418 so the shadow that falls to its right
  // is OUTSIDE the search entirely.
  box: [344, 505, 413, 675],
  // Background is read from clean wall to the LEFT of the tap, on the same row, never from
  // the tap's own neighbourhood. Both earlier attempts got this wrong in opposite ways: a
  // blurred local average was darkened by the tap itself, so the wall beside it stopped
  // matching and a pale cone fanned out to the bath; and a row median inside a box wide
  // enough to contain the shadow classified the shadow as fitting, which did the same thing.
  // The shadow is wall and must be recoloured.
  reference: [300, 340],
  contrast: 25,
};

// The towels ARE found from the pixels: dark rolls on a bright rim, nothing casting a shadow
// onto anything, and a silhouette too irregular to box. Background is the median of each row
// inside the box, which is robust to the object sitting in the middle of it as long as the
// object is a minority of the row's width. The box is therefore wider than the towels.
const TOWELS = { box: [455, 656, 660, 710], contrast: 26 };

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

// Greyscale copy of the photograph, for deciding what is wall and what stands in front.
const grey = await sharp(source.path).greyscale().raw().toBuffer();

// Mark every pixel inside a search box that stands out from its own neighbourhood.
const isObject = new Uint8Array(W * H);

{
  const [x0, y0, x1, y1] = TAP.box;
  const [rx0, rx1] = TAP.reference;
  for (let y = y0; y < y1; y += 1) {
    const ref = [];
    for (let x = rx0; x < rx1; x += 1) ref.push(grey[y * W + x]);
    ref.sort((a, b) => a - b);
    const background = ref[Math.floor(ref.length / 2)];
    for (let x = x0; x < x1; x += 1) {
      const i = y * W + x;
      if (Math.abs(grey[i] - background) > TAP.contrast) isObject[i] = 1;
    }
  }
}

{
  const [x0, y0, x1, y1] = TOWELS.box;
  const found = Buffer.alloc(W * H);
  for (let y = y0; y < y1; y += 1) {
    const row = [];
    for (let x = x0; x < x1; x += 1) row.push(grey[y * W + x]);
    row.sort((a, b) => a - b);
    const background = row[Math.floor(row.length / 2)];
    for (let x = x0; x < x1; x += 1) {
      const i = y * W + x;
      if (Math.abs(grey[i] - background) > TOWELS.contrast) found[i] = 255;
    }
  }

  // Opened before use: eroded, then dilated by the same radius. This is what removes
  // SPECKS while leaving the towel rolls untouched.
  //
  // The bath rim is bright, glossy and busy, so a handful of pixels along it always beat the
  // contrast threshold: a bit of the shower hose, a highlight, the dark object lying beside
  // the towels. Each surviving speck excluded its own column from the rim downward and stood
  // up in the finished frame as a small pale tooth on top of the rim. One would be invisible.
  // Six in a row read as a pattern, and they sat directly under the pin whose caption says
  // the bath is unchanged.
  const OPEN = 2;
  const opened = grow(erode(found, OPEN), OPEN);
  for (let i = 0; i < W * H; i += 1) if (opened[i]) isObject[i] = 1;
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

// Everything standing at the bottom of the frame, found per column.
//
// yTop is the highest row in this column that belongs to something in front of the wall:
// the bath's bright rim, or a towel sitting on it, whichever comes first. Everything from
// there down is not wall. Taking the MINIMUM matters, because under the towels the bath's
// rim is hidden and a rim-only rule would run straight through them.
const columnTop = new Float64Array(W).fill(Infinity);
for (let x = BATH_SCAN.xFrom; x <= BATH_SCAN.xTo; x += 1) {
  for (let y = BATH_SCAN.yFrom; y <= BATH_SCAN.yTo; y += 1) {
    let bright = true;
    for (let k = 0; k < BATH_SCAN.run; k += 1) {
      if (grey[(y + k) * W + x] < BATH_SCAN.bright) { bright = false; break; }
    }
    if (!bright) continue;
    if (grey[y * W + x] - grey[(y - BATH_SCAN.stepOver) * W + x] < BATH_SCAN.step) continue;
    columnTop[x] = y;
    break;
  }

  // A towel breaks the rim's silhouette upward, so take whichever starts higher. Two guards:
  //
  // It only applies to columns crossing the TOWELS, because this rule means "something is
  // resting on the rim here". Applied to every column it also caught the tap, which stands
  // in FRONT of the wall a long way above the rim, so each column through the tap put its
  // boundary at the top of the spout and excluded the entire wall below it. That rendered as
  // a pale triangle fanning out from the tap down to the bath.
  //
  // And it needs a real run of object pixels: a single stray one is noise, and accepting it
  // lifts the whole column and leaves a white sliver standing above the rim.
  const TOWEL_RUN = 3;
  const onTheRim = x >= TOWELS.box[0] && x < TOWELS.box[2];
  if (onTheRim) {
    for (let y = TOWELS.box[1]; y < columnTop[x] && y <= BATH_SCAN.yTo; y += 1) {
      let solid = true;
      for (let k = 0; k < TOWEL_RUN; k += 1) {
        if (!grown[(y + k) * W + x]) { solid = false; break; }
      }
      if (solid) { columnTop[x] = y; break; }
    }
  }
}

// Smooth the edge with a MEDIAN of its neighbours, not a minimum.
//
// Some smoothing is needed either way: a column that finds no rim at all would otherwise
// punch a one-pixel stripe of brush straight down over the tub, which renders as a green
// drip on white enamel. A minimum fixes that and introduces a worse failure, because it
// also propagates any column that fires too EARLY to everything within the window, turning
// one bad reading into a wide white post standing out of the bath. A median discards
// outliers in both directions and leaves a boundary that follows the curve.
const SMOOTH = 4;
const smoothed = new Float64Array(W).fill(Infinity);
for (let x = 0; x < W; x += 1) {
  const window = [];
  for (let k = Math.max(0, x - SMOOTH); k <= Math.min(W - 1, x + SMOOTH); k += 1) {
    if (Number.isFinite(columnTop[k])) window.push(columnTop[k]);
  }
  if (!window.length) continue;
  window.sort((a, b) => a - b);
  smoothed[x] = window[Math.floor(window.length / 2)];
}

// Then a wide moving average, because the boundary has to be SMOOTH and not merely correct.
//
// A median over nine columns removes outliers and still leaves a line that jitters by a
// pixel or two from column to column. That jitter is invisible in the mask and not at all
// invisible to the model: buildMarkedRoomImage traces the mask as a magenta outline, and a
// ragged outline is a ragged instruction. Across five rolls on the jagged boundary the model
// returned a wall in two different tile formats every time, fine horizontal ribbing over the
// left and right thirds and the requested squares in the middle, at a flat QA score. The rim
// it is tracing is a smooth ellipse, so a moving average is not a distortion of the truth
// here, it is closer to it.
const CURVE = 12;
const curve = new Float64Array(W).fill(Infinity);
for (let x = 0; x < W; x += 1) {
  let sum = 0;
  let n = 0;
  for (let k = Math.max(0, x - CURVE); k <= Math.min(W - 1, x + CURVE); k += 1) {
    if (Number.isFinite(smoothed[k])) { sum += smoothed[k]; n += 1; }
  }
  if (n) curve[x] = Math.round(sum / n);
}
for (let x = 0; x < W; x += 1) smoothed[x] = curve[x];

for (let x = BATH_SCAN.xFrom; x <= BATH_SCAN.xTo; x += 1) {
  const yTop = smoothed[x];
  if (!Number.isFinite(yTop)) continue;
  // Start one row LOWER than the edge that was found. The transition row is a blend of tile
  // and rim, and leaving it out of the brush is what produced a pale hairline along the
  // whole rim. Giving it to the brush costs one row of the rim's top highlight, which is
  // not visible, and buys a clean join.
  for (let y = yTop + 1; y < H; y += 1) grown[y * W + x] = 1;
}

for (let x = SKIRTING.xFrom; x <= SKIRTING.xTo; x += 1) {
  for (let y = SKIRTING.y; y < H; y += 1) grown[y * W + x] = 1;
}

// The brush: inside the wall, and not on anything standing in front of it.
const brush = Buffer.alloc(W * H);
let brushed = 0;
for (let i = 0; i < W * H; i += 1) {
  const on = wallMask[i] > 127 && !grown[i];
  brush[i] = on ? 255 : 0;
  if (on) brushed += 1;
}

// Feather the edge, inwards.
//
// Every object in this photograph is shot with a shallow depth of field, so its edge is a
// three or four pixel gradient rather than a line. A hard mask has to choose a row within
// that gradient, and whichever it chooses, the pixels on the object's side keep the
// ORIGINAL wall colour. While the new tile was near-white nobody could tell. Against deep
// emerald the same few pixels read as a white collar traced around the tap and a white
// ledge along the towels, which is the "crude cut-out" an image reviewer kept reporting.
//
// Growing the exclusion makes the collar wider. Shrinking it lets the new tile eat into the
// chrome. Neither is right, because the premise is wrong: the boundary is not a line, so it
// should not be drawn as one. compositeForReview already treats the mask's channel as a
// BLEND WEIGHT rather than a switch, so a ramp there blends the new tile into the object's
// soft edge exactly as the product's own soft brush does in the browser.
//
// Eroded BEFORE blurring so the ramp lies entirely inside the old hard brush. Pixels that
// were fully outside stay at exactly zero, which is what keeps "the same pixels" a literal
// claim about the bath, the tap and the towels rather than an approximate one.
function erode(src, radius) {
  const mid = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let keep = true;
      for (let k = Math.max(0, x - radius); k <= Math.min(W - 1, x + radius); k += 1) {
        if (!src[y * W + k]) { keep = false; break; }
      }
      mid[y * W + x] = keep ? 255 : 0;
    }
  }
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let keep = true;
      for (let k = Math.max(0, y - radius); k <= Math.min(H - 1, y + radius); k += 1) {
        if (!mid[k * W + x]) { keep = false; break; }
      }
      out[y * W + x] = keep ? 255 : 0;
    }
  }
  return out;
}

const FEATHER = 2;
// toColourspace('b-w') before .raw() is LOAD-BEARING, not tidiness.
//
// sharp promotes to sRGB during the blur, so a one-channel raw buffer in comes back as
// THREE channels out: 2,359,296 bytes where the code below indexes 786,432. Read as if it
// were single channel, the interleaved RGB turns into a period-three pattern, and that is
// precisely what shipped: every third row of the composite mask was fully transparent, the
// original white wall showed through in one row out of three, and the finished tile came
// back covered in fine horizontal lines.
//
// It cost a long hunt because every other suspect looked plausible. The artifact survived
// four prompts, three mask geometries, five seeds and both image models, and it was in none
// of them: the model's raw output was clean emerald the whole time, and the damage was done
// afterwards, here. The lesson is the same one two inspection scripts already taught during
// this build, which is that a sharp buffer's channel count has to be read, never assumed.
const feathered = await sharp(erode(brush, FEATHER), { raw: { width: W, height: H, channels: 1 } })
  .blur(FEATHER)
  .toColourspace('b-w')
  .raw()
  .toBuffer();
if (feathered.length !== W * H) {
  throw new Error(`feathered mask should be ${W * H} single-channel bytes, got ${feathered.length}.`);
}

// Belt and braces: nothing the hard mask excluded may have picked up a non-zero weight.
for (let i = 0; i < W * H; i += 1) if (!brush[i]) feathered[i] = 0;

// TWO files, because the mask has two jobs that want opposite shapes.
//
// mask.png is crisp and goes to the model, where it becomes the magenta locator outline
// saying "change what is inside this". Handing the feathered copy to the model instead was
// a measurable mistake: QA scores fell from 85 and 100 to a flat 70 over four rolls, and
// the renders came back with the left half of the wall in a fine horizontal ribbed tile and
// the right half in the square tile that was asked for. A soft outline describes a boundary
// the model cannot place, so it stops trusting it.
//
// mask-composite.png is the feathered copy and is used only to blend the result back over
// the photograph, where a hard edge is what leaves a white rim around the tap.
const maskPath = path.join(HERE, 'mask.png');
await sharp(brush, { raw: { width: W, height: H, channels: 1 } })
  .toColourspace('b-w')
  .png()
  .toFile(maskPath);

const compositeMaskPath = path.join(HERE, 'mask-composite.png');
await sharp(feathered, { raw: { width: W, height: H, channels: 1 } })
  .toColourspace('b-w')
  .png()
  .toFile(compositeMaskPath);

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
  if (readBack[i * stride] !== brush[i]) drift += 1;
}
if (drift) throw new Error(`mask.png does not match the computed mask: ${drift} pixel(s) differ.`);

// Overlay it on the photograph so the brushed area can be checked by eye before a render is
// spent on it, in the same magenta the product's own locator uses.
const magenta = await sharp({
  create: { width: W, height: H, channels: 3, background: { r: 255, g: 0, b: 200 } },
}).raw().toBuffer();
// joinChannel APPENDS, so a 4-channel base would gain a fifth and the alpha would be
// ignored, painting the whole frame magenta.
const alpha = Buffer.from(feathered.map((v) => Math.round(v * 0.5)));
const tint = await sharp(magenta, { raw: { width: W, height: H, channels: 3 } })
  .joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } })
  .png()
  .toBuffer();
const tinted = await sharp(source.path).composite([{ input: tint, blend: 'over' }]).png().toBuffer();
await sharp(tinted).resize(650).jpeg({ quality: 90 }).toFile(path.join(HERE, 'preview-mask.jpg'));

console.log(`mask     ${W}x${H} -> ${maskPath}`);
console.log(`brushed  ${(brushed / (W * H) * 100).toFixed(1)}% of the frame`);
