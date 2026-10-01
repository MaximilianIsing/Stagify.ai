// Magic-select (segmentation wand) island for the Masking Studio
// (scripts/masking-studio/masking-studio-app.js).
//
// POSTs the photo to /api/segment, decodes and caches every returned object
// mask, and paints the clicked object into the active area exactly like brush
// strokes (undo snapshot, pixel claiming, painted rescan) via the injected
// draw-tools callbacks. Lifted verbatim from the entry. The stale-result
// contract stays cross-module: the entry's setBaseImage bumps state.segToken
// and nulls state.segCache; ensureSegCache captures the token before the
// fetch and refuses to cache on mismatch.

import { errorMessage } from '../shared/error-message.js';

/**
 * @typedef {import('./types.js').MsState} MsState
 * @typedef {import('./types.js').MsLayer} MsLayer
 * @typedef {import('./types.js').MsBase} MsBase
 * @typedef {import('./types.js').MsSegItem} MsSegItem
 */
/**
 * @param {{
 *   state: MsState,
 *   stack: HTMLElement,
 *   wandBusyEl: HTMLElement,
 *   activeLayer: () => MsLayer | null,
 *   canvasPoint: (e: PointerEvent) => { x: number, y: number } | null,
 *   paintMaskIntoLayer: (layer: MsLayer, maskCanvas: HTMLCanvasElement) => void,
 *   requestError: (status: number, result: any) => string,
 *   showToast: (message: string, type?: 'error' | 'success') => void,
 *   tx: (key: string, def: string) => string,
 *   loadImage: (src: string) => Promise<HTMLImageElement>,
 * }} deps
 */
export function createSegWand(deps) {
  const {
    state,
    stack,
    wandBusyEl,
    activeLayer,
    canvasPoint,
    paintMaskIntoLayer,
    requestError,
    showToast,
    tx,
    loadImage,
  } = deps;
        // ---------------------------------------------------------------------
        // Magic select: Gemini segmentation. The first wand click fetches masks
        // for every object in the photo and caches them, so every later click
        // resolves instantly by hit-testing the cache. Typed queries ("the
        // empty floor") fetch a targeted mask. Either way the result is painted
        // into the active area exactly like brush strokes — the wand is just a
        // faster brush, and undo/pixel-claiming behave identically.
        // ---------------------------------------------------------------------
        function segPayload() {
          const base = /** @type {MsBase} */ (state.base); // the wand only runs with a photo loaded
          // ~1024px is what Google's own segmentation samples send; coordinates
          // come back normalized, so full resolution would only cost tokens.
          const scale = Math.min(1, 1024 / Math.max(base.w, base.h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(base.w * scale));
          c.height = Math.max(1, Math.round(base.h * scale));
          const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(base.canvas, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', 0.9);
        }

        /**
         * @param {string} query
         * @returns {Promise<MsSegItem[]>}
         */
        async function fetchSegmentation(query) {
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const response = await fetch('/api/segment', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
            },
            body: JSON.stringify({ image: segPayload(), query: query || '', authToken: tok || undefined }),
          });
          let result = null;
          try { result = await response.json(); } catch (e) {}
          if (!response.ok || !result || !result.success) {
            throw new Error(requestError(response.status, result));
          }
          return decodeSegItems(result.items || []);
        }

        // box_2d is [y0, x0, y1, x1] normalized to 0-1000; the mask PNG is a
        // probability map covering just that box, binarized at the documented
        // midpoint (>127 keeps). The API frequently omits usable pixel masks
        // (the server nulls them out) — then the box itself becomes the
        // selection, which the brush/eraser can refine.
        /**
         * @param {import('./types.js').MsSegApiItem[]} items
         * @returns {Promise<MsSegItem[]>}
         */
        async function decodeSegItems(items) {
          /** @type {MsSegItem[]} */
          const out = [];
          for (const it of items) {
            try {
              const base = /** @type {MsBase} */ (state.base); // read before this item's await, as before
              const y0 = it.box_2d[0], x0 = it.box_2d[1], y1 = it.box_2d[2], x1 = it.box_2d[3];
              if (y1 <= y0 || x1 <= x0) continue;
              const bx = Math.round((x0 / 1000) * base.w);
              const by = Math.round((y0 / 1000) * base.h);
              const bw = Math.max(1, Math.round(((x1 - x0) / 1000) * base.w));
              const bh = Math.max(1, Math.round(((y1 - y0) / 1000) * base.h));
              const c = document.createElement('canvas');
              c.width = base.w;
              c.height = base.h;
              const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
              let area = 0;
              if (it.mask) {
                const img = await loadImage(it.mask);
                ctx.drawImage(img, bx, by, bw, bh);
                const id = ctx.getImageData(bx, by, bw, bh);
                const d = id.data;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i] > 127) { d[i + 3] = 255; area++; }
                  else d[i + 3] = 0;
                }
                if (!area) continue;
                ctx.putImageData(id, bx, by);
              } else {
                const r = Math.min(24, Math.min(bw, bh) * 0.12);
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
                else ctx.rect(bx, by, bw, bh);
                ctx.fill();
                area = bw * bh;
              }
              out.push({ canvas: c, area: area, label: it.label || '' });
            } catch (e) { /* one undecodable mask never sinks the batch */ }
          }
          return out;
        }

        /** @type {ReturnType<typeof setInterval> | null} */
        let wandMsgTimer = null;
        /** @param {boolean} b */
        function setSegBusy(b) {
          wandBusyEl.classList.toggle('hidden', !b);
          stack.classList.toggle('is-analyzing', b);
          if (wandMsgTimer) { clearInterval(wandMsgTimer); wandMsgTimer = null; }
          if (b) {
            // Cycle through progress lines while Gemini works; hold the last
            // one rather than looping back to "Analyzing…".
            const raw = window.LanguageSystem && window.LanguageSystem.getText('maskingStudio.wandBusyMessages');
            const msgs = Array.isArray(raw) && raw.length ? raw : [
              'Analyzing your photo…',
              'Finding the objects in the room…',
              'Outlining what it found…',
              'Almost there…',
            ];
            let i = 0;
            wandBusyEl.textContent = msgs[0];
            wandMsgTimer = setInterval(() => {
              i++;
              if (i >= msgs.length) { clearInterval(/** @type {ReturnType<typeof setInterval>} */ (wandMsgTimer)); wandMsgTimer = null; return; }
              wandBusyEl.textContent = msgs[i];
            }, 2200);
          }
        }

        // One shared in-flight request: clicks made while the analysis runs
        // await the same promise and land as soon as it resolves, instead of
        // being dropped. Prefetch (on tool select) uses the same path.
        /** @type {Promise<MsSegItem[] | null> | null} */
        let segPromise = null;
        /** @returns {Promise<MsSegItem[] | null>} */
        function ensureSegCache() {
          if (state.segCache) return Promise.resolve(state.segCache);
          if (segPromise) return segPromise;
          const token = state.segToken;
          setSegBusy(true);
          segPromise = (async () => {
            try {
              const items = await fetchSegmentation('');
              if (token !== state.segToken) return null; // photo changed mid-flight
              // Never cache an empty list: Gemini occasionally returns zero
              // items for a full room, and caching that would make every
              // later click insta-miss until the photo changes.
              state.segCache = items.length ? items : null;
              return items;
            } finally {
              segPromise = null;
              setSegBusy(false);
            }
          })();
          return segPromise;
        }

        /** @param {PointerEvent} e */
        async function wandClick(e) {
          const p = canvasPoint(e);
          const layer = activeLayer();
          if (!p || !layer) return;
          let cache;
          try {
            cache = await ensureSegCache();
          } catch (err) {
            showToast(errorMessage(err) || tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
            return;
          }
          if (!cache || state.phase !== 'draw') return; // superseded while analyzing
          const base = /** @type {MsBase} */ (state.base); // the wand only runs with a photo loaded
          const px = Math.max(0, Math.min(base.w - 1, Math.round(p.x)));
          const py = Math.max(0, Math.min(base.h - 1, Math.round(p.y)));
          /** @type {{ canvas: HTMLCanvasElement, area: number } | null} */
          let hit = null;
          // for...of, not forEach: TS can't see an assignment inside a callback, so
          // after a forEach it would still type `hit` as null.
          for (const it of cache) {
            const a = /** @type {CanvasRenderingContext2D} */ (it.canvas.getContext('2d')).getImageData(px, py, 1, 1).data[3];
            if (a > 0 && (!hit || it.area < hit.area)) hit = it; // smallest = most specific
          }
          if (!hit) {
            showToast(tx('maskingStudio.wandMiss', 'No object found there. Try clicking the middle of the object, or highlight it with the brush.'), 'error');
            return;
          }
          paintMaskIntoLayer(layer, hit.canvas);
        }
  return { wandClick, ensureSegCache };
}
