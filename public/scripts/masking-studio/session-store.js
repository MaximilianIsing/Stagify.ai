// IndexedDB session-persistence island for the Masking Studio
// (scripts/masking-studio-app.js).
//
// The photo, strokes, prompts, and furniture refs are saved to IndexedDB
// (debounced) so a crash or closed tab doesn't lose the work. Generated
// results are deliberately not persisted — restore returns to the draw phase
// with everything ready to re-run. All storage calls fail silently (private
// mode, quota, old browsers). Lifted verbatim from the entry: this island owns
// the transport, the canvas⇄Blob codecs, the save/restore choreography, and
// the resume dialog; the pure shape projection stays in ./session.js.
//
// deps: { state, MAX_LAYERS, PALETTE, stack, resultCanvas, resumeEl,
//         resumeYesBtn, resumeNoBtn, setBaseImage, addLayer, renderLayers,
//         updateControls, showToast, tx }
import {
  serializeLayer,
  serializeSession,
  deserializeLayer,
  isRestorableSession,
} from './session.js';

export function createSessionStore(deps) {
  const {
    state,
    MAX_LAYERS,
    PALETTE,
    stack,
    resultCanvas,
    resumeEl,
    resumeYesBtn,
    resumeNoBtn,
    setBaseImage,
    addLayer,
    renderLayers,
    updateControls,
    showToast,
    tx,
  } = deps;

        let idbPromise = null;
        let saveTimer = null;
        let restoring = false; // block saves while a restore is rebuilding state
        let saveSeq = 0;       // bumped on clear so in-flight saves abort

        function idb() {
          if (!idbPromise) {
            idbPromise = new Promise((resolve) => {
              try {
                const req = indexedDB.open('stagify-masking-studio', 1);
                req.onupgradeneeded = () => { req.result.createObjectStore('session'); };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
              } catch (e) { resolve(null); }
            });
          }
          return idbPromise;
        }

        function idbOp(mode, fn) {
          return idb().then((db) => new Promise((resolve) => {
            if (!db) { resolve(null); return; }
            try {
              const tr = db.transaction('session', mode);
              const out = fn(tr.objectStore('session'));
              tr.oncomplete = () => resolve(out && 'result' in out ? out.result : null);
              tr.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
          }));
        }

        const sessionSave = (value) => idbOp('readwrite', (s) => s.put(value, 'current'));
        const sessionLoad = () => idbOp('readonly', (s) => s.get('current'));
        const sessionClear = () => idbOp('readwrite', (s) => s.delete('current'));

        function toBlob(canvas, type, q) {
          return new Promise((resolve) => {
            try { canvas.toBlob(resolve, type, q); } catch (e) { resolve(null); }
          });
        }

        function scheduleSessionSave() {
          if (!state.base || restoring) return;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(saveSessionNow, 1500);
        }

        async function saveSessionNow() {
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          if (!state.base || restoring) return;
          if (state.phase === 'generating') {
            // Don't drop edits made just before Apply Edit — retry after the run.
            scheduleSessionSave();
            return;
          }
          const seq = saveSeq;
          try {
            const baseBlob = await toBlob(state.base.canvas, 'image/jpeg', 0.9);
            if (!baseBlob) return;
            const layerData = [];
            for (const l of state.layers) {
              const maskBlob = l.painted ? await toBlob(l.canvasEl, 'image/png') : null;
              layerData.push(serializeLayer(l, maskBlob));
            }
            // A clear/reset while we were encoding wins — never resurrect a
            // session the user just discarded.
            if (seq !== saveSeq) return;
            await sessionSave(serializeSession(baseBlob, layerData, Date.now()));
          } catch (e) {}
        }

        function clearStoredSession() {
          saveSeq++;
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          sessionClear();
        }

        function blobToImage(blob) {
          return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const im = new Image();
            im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
            im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
            im.src = url;
          });
        }

        async function restoreSession(saved) {
          // A half-finished restore must never overwrite the stored session
          // (the debounced save could fire while masks are still decoding).
          restoring = true;
          try {
            await restoreSessionInner(saved);
          } finally {
            restoring = false;
          }
          scheduleSessionSave();
        }

        async function restoreSessionInner(saved) {
          const img = await blobToImage(saved.baseBlob);
          setBaseImage(img, { noLayer: true });
          for (const ld of saved.layers || []) {
            if (state.layers.length >= MAX_LAYERS) break;
            const c = document.createElement('canvas');
            c.width = state.base.w;
            c.height = state.base.h;
            c.className = 'ms-layer-canvas';
            stack.insertBefore(c, resultCanvas);
            let painted = false;
            if (ld.mask) {
              try {
                const maskImg = await blobToImage(ld.mask);
                c.getContext('2d').drawImage(maskImg, 0, 0, state.base.w, state.base.h);
                painted = true;
              } catch (e) {}
            }
            state.layers.push(deserializeLayer(ld, {
              id: 'L' + (++state.layerSeq),
              canvasEl: c,
              painted: painted,
              paletteLength: PALETTE.length,
            }));
          }
          if (!state.layers.length) addLayer();
          state.activeId = state.layers[0].id;
          renderLayers();
          updateControls();
        }

        // Returns true if the resume dialog was shown (suppresses first-visit help).
        async function maybeOfferResume() {
          let saved = null;
          try { saved = await sessionLoad(); } catch (e) {}
          if (!isRestorableSession(saved) || state.base) return false;
          resumeEl.classList.add('active');
          resumeYesBtn.focus();
          resumeYesBtn.addEventListener('click', async () => {
            resumeEl.classList.remove('active');
            try {
              await restoreSession(saved);
            } catch (e) {
              showToast(tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
              sessionClear();
            }
          }, { once: true });
          resumeNoBtn.addEventListener('click', () => {
            resumeEl.classList.remove('active');
            clearStoredSession();
          }, { once: true });
          return true;
        }

        // Flush the pending save when the tab goes to the background.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden' && saveTimer) saveSessionNow();
        });
  return { scheduleSessionSave, maybeOfferResume };
}
