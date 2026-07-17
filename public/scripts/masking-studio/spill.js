// Pure "spill" detection for the Masking Studio refine step
// (scripts/masking-studio/snap-refine.js).
//
// After a run an area's AI output sometimes draws the object slightly PAST the
// highlight the user painted — a sofa arm, a chair leg, the top of a lamp that
// pokes out. The client composite clips that overhang to the brushed mask, so
// it lands cut off at the stroke edge. This finds the overhang so the refine
// step can grow the mask to the whole object: it floods outward FROM the
// painted region, THROUGH pixels the AI actually changed, bounded to a band
// around the highlight and to this area's own Voronoi cell. It is GROW-ONLY —
// it never proposes dropping painted pixels — so the worst case is a harmless
// over-suggestion the user can undo.
//
// No DOM and no module state: inputs are typed arrays (RGBA for base/edited,
// alpha for the strokes, the nearest-area label grid), so this runs under
// node --test with no shim (see test/masking-studio-spill.test.js). The browser
// island downsamples the canvases into these arrays and upsamples the result
// back into a mask canvas.

// 8-neighbour offsets for the flood (diagonals included so a slanted object
// edge stays one connected region).
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * @param {object} opts
 * @param {Uint8ClampedArray|Uint8Array} opts.base   Original photo RGBA (w*h*4).
 * @param {Uint8ClampedArray|Uint8Array} opts.edited  AI output RGBA (w*h*4).
 * @param {Uint8ClampedArray|Uint8Array} opts.painted This area's stroke alpha (w*h).
 * @param {Int16Array|null} opts.labels  Nearest-area labels (w*h), or null when
 *   only one area is painted (then the whole photo is this area's territory).
 * @param {number} opts.myIdx  This area's index within the painted set (labels
 *   value that means "mine"); <0 disables the cell clip.
 * @param {number} opts.w
 * @param {number} opts.h
 * @param {number} [opts.diffThreshold] Euclidean RGB distance above which a
 *   pixel counts as "the AI repainted it". Set high enough to reject the
 *   whole-frame tone/JPEG drift a full regeneration leaves everywhere.
 * @param {number} [opts.maxBand]  Max flood depth in px past the highlight —
 *   caps how far an object may extend beyond the painted region.
 * @param {number} [opts.minFill]  Below this many pixels the spill is not worth
 *   surfacing (returns count 0).
 * @param {number} [opts.maxGrowthRatio] If the fill would exceed this multiple
 *   of the painted area the diff is deemed unreliable (e.g. a global change) and
 *   the suggestion is declined.
 * @param {number} [opts.seedAlpha]  Stroke-alpha above which a pixel is "painted".
 * @returns {{ fill: Uint8Array, count: number }} `fill` is 1 only on the ADDED
 *   pixels (never the already-painted ones); `count` is how many were added.
 */
export function computeSpillFill({
  base,
  edited,
  painted,
  labels,
  myIdx,
  w,
  h,
  diffThreshold = 70,
  maxBand = 48,
  minFill = 16,
  maxGrowthRatio = 1.5,
  seedAlpha = 12,
}) {
  const n = w * h;
  const empty = () => ({ fill: new Uint8Array(n), count: 0 });
  if (!base || !edited || !painted || w <= 0 || h <= 0) return empty();

  // 1. changed[i]: the AI meaningfully repainted this pixel. A high-ish
  //    threshold keeps real object-over-background changes and rejects the mild
  //    tone/compression drift a whole-frame regeneration sprinkles everywhere.
  const thrSq = diffThreshold * diffThreshold;
  const changed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const dr = base[p] - edited[p];
    const dg = base[p + 1] - edited[p + 1];
    const db = base[p + 2] - edited[p + 2];
    if (dr * dr + dg * dg + db * db > thrSq) changed[i] = 1;
  }

  // 2. Denoise: keep a changed pixel only when a majority of its 3x3 neighbours
  //    also changed. A cheap erode that kills lone specks and the hairline
  //    leaks a global tone shift can trace along the mask boundary.
  const solid = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!changed[i]) continue;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          c += changed[yy * w + xx];
        }
      }
      if (c >= 5) solid[i] = 1;
    }
  }

  // 3. Flood from the painted region outward through `solid` pixels, bounded by
  //    band distance (BFS depth) and this area's Voronoi cell. Painted pixels
  //    are the seeds; the fill is the changed pixels reachable from them.
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  let paintedCount = 0;
  for (let i = 0; i < n; i++) {
    if (painted[i] > seedAlpha) {
      dist[i] = 0;
      queue[qt++] = i;
      paintedCount++;
    }
  }
  if (!paintedCount) return empty();

  const clip = labels && myIdx >= 0;
  const fill = new Uint8Array(n);
  let count = 0;
  while (qh < qt) {
    const i = queue[qh++];
    const d = dist[i];
    if (d >= maxBand) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k];
      const ny = y + NY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] !== -1) continue;      // already a seed or already filled
      if (!solid[j]) continue;           // only grow through real changes
      if (painted[j] > seedAlpha) continue; // painted pixels seed, never fill
      if (clip && labels[j] !== myIdx) continue; // never cross into another cell
      dist[j] = d + 1;
      fill[j] = 1;
      count++;
      queue[qt++] = j;
    }
  }

  // 4. Guards. Too little → not worth a button. Too much relative to the
  //    highlight → the diff is unreliable, so decline rather than mislead.
  if (count < minFill || count > paintedCount * maxGrowthRatio) return empty();
  return { fill, count };
}
