// Pure session-persistence shape helpers for the Masking Studio.
//
// The IndexedDB transport, canvas→Blob encoding, and Blob→canvas decoding all
// stay in the browser entry — they need a live canvas / IndexedDB. What lives
// here is the plain-object ⇄ layer projection and the restorability guard: pure
// data shaping with no DOM and no module state, so it runs under node --test with
// no shim (see test/masking-studio-session.test.js).

import { createLayer } from './layers.js';

// Plain-object projection of one area layer for storage. The caller encodes the
// mask canvas to a Blob (null when the area is unpainted) and passes it in; the
// field selection — which layer fields survive a reload — lives here. Generated
// results (candidates/editedImg/status) are deliberately NOT persisted: a restore
// returns to the draw phase ready to re-run, so only the inputs are kept. The
// `painted` guard mirrors the encode: an unpainted layer stores no mask.
export function serializeLayer(layer, maskBlob) {
  return {
    colorIdx: layer.colorIdx,
    name: layer.name,
    prompt: layer.prompt,
    mode: layer.mode,
    furniture: layer.furniture,
    furnitureName: layer.furnitureName,
    painted: layer.painted,
    mask: layer.painted ? maskBlob : null,
  };
}

// Envelope wrapping the base-photo Blob and the serialized layers with a save
// timestamp. `savedAt` is supplied by the caller (Date.now()) so this stays pure
// and deterministic under test.
export function serializeSession(baseBlob, layerData, savedAt) {
  return { savedAt: savedAt, baseBlob: baseBlob, layers: layerData };
}

// Rebuild a live layer object from its stored projection. The caller creates the
// backing <canvas>, decodes the mask onto it, and passes the resulting element
// plus whether the decode actually produced paint. Everything else is pure and
// lives here — clamping a stored colorIdx into the current palette (a shrunken or
// reordered palette must never index out of range), normalizing the mode, and
// filling defaults for missing/legacy fields — reusing createLayer so the layer
// default shape stays single-sourced with the live add-layer path.
export function deserializeLayer(stored, { id, canvasEl, painted, paletteLength }) {
  const colorIdx = Math.min(paletteLength - 1, Math.max(0, stored.colorIdx || 0));
  const layer = createLayer({ id: id, colorIdx: colorIdx, canvasEl: canvasEl });
  layer.painted = painted;
  layer.name = stored.name || '';
  layer.prompt = stored.prompt || '';
  layer.mode = stored.mode === 'remove' ? 'remove' : 'stage';
  layer.furniture = stored.furniture || null;
  layer.furnitureName = stored.furnitureName || '';
  return layer;
}

// A stored session is worth offering to restore only if it actually carries a
// base photo — an empty or malformed record is dropped silently.
export function isRestorableSession(saved) {
  return !!(saved && saved.baseBlob);
}
