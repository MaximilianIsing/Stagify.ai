// Pure area-layer / concurrency helpers for the Masking Studio.
//
// No DOM, no module state — inputs come in as parameters, so these run under
// node --test with no shim (see test/masking-studio-layers.test.js). The browser
// entry keeps the DOM-bound layer bookkeeping and passes its `layers` array,
// palette, and translate function in. Anything here that needs a live canvas
// (painting, compositing) stays in the entry; only the plain-object view-model
// derivations live here.

// Bounded-concurrency promise pool: at most `size` jobs run at once, the rest
// queue. Returns an enqueue(fn) that resolves/rejects with fn()'s result. Used
// to cap in-flight /api/mask-edit calls (smoother on rate limits than firing
// every area at once) while progressive compositing keeps the wait short.
export function createPool(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (!queue.length || active >= size) return;
    active++;
    const job = queue.shift();
    job.fn().then(job.resolve, job.reject).then(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn: fn, resolve: resolve, reject: reject });
    next();
  });
}

// Lowest palette index not yet claimed by an existing layer, or -1 when the
// palette is exhausted (all `paletteLength` colors are in use).
export function nextColorIdx(layers, paletteLength) {
  for (let i = 0; i < paletteLength; i++) {
    if (!layers.some((l) => l.colorIdx === i)) return i;
  }
  return -1;
}

// Default shape of an area layer. The entry owns id/colorIdx allocation and the
// backing <canvas> element; this just stamps out the bookkeeping fields so the
// initial state lives in one place. `el` (the rendered card) is filled in later
// by the renderer.
export function createLayer({ id, colorIdx, canvasEl }) {
  return {
    id: id,
    colorIdx: colorIdx,
    canvasEl: canvasEl,
    painted: false,
    name: '',            // user-given name; empty → "Area {n}"
    prompt: '',
    mode: 'stage',       // 'stage' adds furniture; 'remove' clears the area
    presetsOpen: false,  // prompt-idea chips revealed via the + button
    furniture: null,
    furnitureName: '',   // original file name, shown in the header peek
    status: 'idle',      // idle | generating | done | failed
    editedImg: null,     // the selected candidate (what compositeAll uses)
    candidates: [],      // every generated version of this area (capped)
    candIdx: 0,
    blendMask: null,
    errorMsg: '',
    el: null,
  };
}

// Highlight color for a layer, from its assigned palette slot.
export function layerColor(layer, palette) {
  return palette[layer.colorIdx].hex;
}

// Display name for a layer: the user-given name, else "Area {n}" where n is the
// layer's 1-based position in the list.
export function layerTitle(layer, layers, translate) {
  if (layer.name) return layer.name;
  const template = translate('maskingStudio.areaName', 'Area {n}');
  const n = layers.indexOf(layer) + 1;
  return template.replace('{n}', String(n));
}

// One-line summary shown on a collapsed layer card: the prompt if any, else the
// mode ("Remove object") or the furniture file name.
export function previewText(layer, translate) {
  if (layer.prompt.trim()) return layer.prompt.trim();
  if (layer.mode === 'remove') return translate('maskingStudio.modeRemove', 'Remove object');
  return layer.furniture ? (layer.furnitureName || '') : '';
}

// Status pill ({ cls, text }) for a layer card. Generating/done/failed reflect
// the last run; otherwise it nudges the user toward what the area still needs.
export function statusChip(layer, translate) {
  if (layer.status === 'generating') return { cls: 'ms-layer-status--generating', text: translate('maskingStudio.statusGenerating', 'Staging…') };
  if (layer.status === 'done') return { cls: 'ms-layer-status--done', text: translate('maskingStudio.statusDone', 'Done') };
  if (layer.status === 'failed') return { cls: 'ms-layer-status--failed', text: translate('maskingStudio.statusFailed', 'Failed') };
  if (!layer.painted) return { cls: '', text: translate('maskingStudio.statusEmpty', 'Not highlighted yet') };
  if (layer.mode === 'remove' || layer.prompt.trim() || layer.furniture) return { cls: 'ms-layer-status--ready', text: translate('maskingStudio.statusReady', 'Ready') };
  return { cls: '', text: translate('maskingStudio.statusNeedsDetails', 'Needs a prompt or photo') };
}
