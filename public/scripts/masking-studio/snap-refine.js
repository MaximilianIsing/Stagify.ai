// Refine "Snap to object" island for the Masking Studio
// (scripts/masking-studio-app.js).
//
// The refine step composites each area's AI output through the mask the user
// painted, so anything the model drew just PAST the highlight (a sofa arm, a
// chair leg) lands cut off at the stroke edge. Right after a run this measures
// that overhang per area — the pure detector in ./spill.js floods from the
// painted region through pixels the AI actually changed, bounded to a band
// around the highlight and to the area's Voronoi cell — and stashes it on
// layer.spill. The UI then offers a one-click "Snap to object" that grows the
// mask to include it, applied through the exact same stroke path as a brush
// (undoable, pixel-claimed, re-composited) via draw-tools' paintMaskIntoLayer.
//
// Grow-only: a snap never drops painted pixels, so accepting a slightly noisy
// suggestion is always recoverable with one undo. The heavy pixel math lives in
// the pure module; this island only downsamples canvases in and paints a mask
// back out.
//
// deps: { state, paintMaskIntoLayer }
import { nearestAreaLabels } from './layers.js';
import { computeSpillFill } from './spill.js';

export function createSnapRefine(deps) {
  const { state, paintMaskIntoLayer } = deps;

  // Working resolution for the diff/flood — the same budget the generate
  // pipeline uses for its Voronoi partition. The flood only has to be right to
  // within a pixel or two, so a small grid keeps this near-instant.
  const WORK_MAX = 640;

  function smallDims() {
    const scale = Math.min(1, WORK_MAX / Math.max(state.base.w, state.base.h));
    return {
      pw: Math.max(1, Math.round(state.base.w * scale)),
      ph: Math.max(1, Math.round(state.base.h * scale)),
    };
  }

  // RGBA of any drawImage-able source rendered into a pw×ph scratch.
  function smallRGBA(src, pw, ph) {
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, pw, ph);
    return ctx.getImageData(0, 0, pw, ph).data;
  }

  // Alpha-only downsample of a stroke canvas → one byte per pixel.
  function smallAlpha(src, pw, ph) {
    const rgba = smallRGBA(src, pw, ph);
    const a = new Uint8Array(pw * ph);
    for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
    return a;
  }

  // Recompute the spill suggestion for every done area of a run. Stores
  // layer.spill = { pw, ph, fill, count } (or null) and returns how many areas
  // gained one. Remove-mode areas are skipped: they rebuild the room behind the
  // mask, so there is no object to snap to.
  function computeSpillForDone(participating) {
    if (!state.base) return 0;
    const { pw, ph } = smallDims();
    const paintedLayers = state.layers.filter((l) => l.painted);
    const seeds = paintedLayers.map((l) => smallAlpha(l.canvasEl, pw, ph));
    // Only clip to cells when at least two areas compete for territory.
    const labels = paintedLayers.length >= 2 ? nearestAreaLabels(seeds, pw, ph, 10) : null;
    const base = smallRGBA(state.base.canvas, pw, ph);
    const maxBand = Math.max(12, Math.round(Math.max(pw, ph) * 0.08));

    let suggested = 0;
    (participating || state.layers).forEach((layer) => {
      layer.spill = null;
      if (layer.status !== 'done' || !layer.editedImg || layer.mode === 'remove' || !layer.painted) return;
      const myIdx = paintedLayers.indexOf(layer);
      const painted = myIdx >= 0 ? seeds[myIdx] : smallAlpha(layer.canvasEl, pw, ph);
      const edited = smallRGBA(layer.editedImg, pw, ph);
      const { fill, count } = computeSpillFill({ base, edited, painted, labels, myIdx, w: pw, h: ph, maxBand });
      if (count > 0) {
        layer.spill = { pw, ph, fill, count };
        suggested++;
      }
    });
    return suggested;
  }

  // Grow one area's mask to include its detected spill, exactly as if the user
  // had brushed it in. Consumes the suggestion (a later stroke or re-run
  // recomputes it).
  function snapLayer(id) {
    const layer = state.layers.find((l) => l.id === id);
    if (!layer || !layer.spill || state.phase !== 'draw' || !state.base) return;
    const { pw, ph, fill } = layer.spill;
    // Paint the fill into a small opaque-white stamp…
    const small = document.createElement('canvas');
    small.width = pw;
    small.height = ph;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(pw, ph);
    const d = img.data;
    for (let i = 0; i < fill.length; i++) {
      if (fill[i]) {
        d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    // …then upscale nearest-neighbour to a full-res mask (crisp edge, no fringe).
    const mask = document.createElement('canvas');
    mask.width = state.base.w;
    mask.height = state.base.h;
    const mctx = mask.getContext('2d');
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(small, 0, 0, state.base.w, state.base.h);
    layer.spill = null; // consumed before repaint so the button retires
    paintMaskIntoLayer(layer, mask);
  }

  function hasPendingSpill() {
    return state.layers.some((l) => l.spill && l.spill.count > 0);
  }

  return { computeSpillForDone, snapLayer, hasPendingSpill };
}
