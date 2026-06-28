// Shared mask-editor image-processing core.
//
// Pure canvas math for the brush-mask workflow — no DOM lookups by id, no i18n,
// no app/page state. Imported by BOTH the main Stagify tool (scripts/app.js) and
// the AI Designer (ai-designer.html) via dynamic import so these algorithms are
// defined exactly once. Each consumer wraps these in thin same-named helpers and
// feeds them <canvas> elements / HTMLImageElements; see each page's mask editor
// for the surrounding UI wiring.
//
// Inputs are sources drawImage() accepts (canvas/image); outputs are offscreen
// <canvas> elements (or, for compositeMaskedEdit, a PNG data URL).

// Turn the user's brush strokes into a solid white-on-transparent mask grown
// outward by `grow` px (the "secret brush size increase" — covers slightly more
// than the user actually painted so small under-brushing is forgiven).
export function growBinaryMask(drawSrc, w, h, grow) {
  const bin = document.createElement('canvas');
  bin.width = w; bin.height = h;
  const bctx = bin.getContext('2d');
  bctx.drawImage(drawSrc, 0, 0, w, h);
  const id = bctx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const on = d[i + 3] > 10;
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = on ? 255 : 0;
  }
  bctx.putImageData(id, 0, 0);
  const grown = document.createElement('canvas');
  grown.width = w; grown.height = h;
  const gctx = grown.getContext('2d');
  const steps = 28;
  const ringStep = Math.max(2, grow / 5);
  for (let r = grow; r > 0; r -= ringStep) {
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      gctx.drawImage(bin, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  gctx.drawImage(bin, 0, 0);
  return grown;
}

// White-on-black opaque mask for the model: the grown brushed region the AI is
// allowed to edit. Sending the grown mask (not the raw brush) is what makes the
// secret brush increase actually enlarge the edit.
export function buildModelMask(drawSrc, w, h, grow) {
  const grown = growBinaryMask(drawSrc, w, h, grow);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, w, h);
  octx.drawImage(grown, 0, 0);
  return out;
}

// Soft "keep" mask for compositing: a solid core grown by coreGrow, then a
// gradual alpha falloff over featherPx so the edited region fades into the
// original with no visible seam. The alpha channel is the blend weight
// (1 = fully edited, 0 = fully original).
export function buildBlendMask(drawSrc, w, h, coreGrow, featherPx) {
  const grown = growBinaryMask(drawSrc, w, h, coreGrow + featherPx);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  let blurred = false;
  try {
    if (typeof octx.filter !== 'undefined') {
      octx.filter = 'blur(' + featherPx + 'px)';
      octx.drawImage(grown, 0, 0);
      octx.filter = 'none';
      blurred = true;
    }
  } catch (e) { blurred = false; }
  if (!blurred) {
    // Fallback (no canvas filter): approximate the fade with decreasing-alpha
    // ring stamps around the solid core.
    octx.drawImage(grown, 0, 0);
    const steps = 28;
    const rings = 8;
    for (let i = 1; i <= rings; i++) {
      octx.globalAlpha = 0.5 * (1 - i / (rings + 1));
      const rr = featherPx * (i / rings);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        octx.drawImage(grown, Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    octx.globalAlpha = 1;
  }
  return out;
}

// Hard-composite the AI output onto the original: keep the original everywhere,
// paste the edited pixels only inside the (expanded) mask. This makes it
// physically impossible for unbrushed areas to change.
export function compositeMaskedEditCanvas(origCanvas, keepMask, editedImg, w, h) {
  const me = document.createElement('canvas');
  me.width = w; me.height = h;
  const mctx = me.getContext('2d');
  mctx.drawImage(editedImg, 0, 0, w, h);
  mctx.globalCompositeOperation = 'destination-in';
  mctx.drawImage(keepMask, 0, 0, w, h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  octx.drawImage(origCanvas, 0, 0);
  octx.drawImage(me, 0, 0);
  return out;
}

// Same composite, returned as a PNG data URL (used when committing a version).
export function compositeMaskedEdit(origCanvas, keepMask, editedImg, w, h) {
  return compositeMaskedEditCanvas(origCanvas, keepMask, editedImg, w, h).toDataURL('image/png');
}
