// Generation-pipeline island for the Masking Studio
// (scripts/masking-studio-app.js).
//
// Every painted area runs as its own parallel mask edit (POST /api/mask-edit,
// bounded concurrency, 429/503 retries); the composites chain over the
// pristine original and the refine-phase ghost backdrop mirrors the main
// tool's renderRefinePreview. Lifted verbatim from the entry. Self-wires the
// Apply Edit button; phase/view changes go through the injected setPhase/
// setView so the entry keeps owning the phase machine.
//
// deps: { state, generateBtn, progressEl, progressBar, progressText,
//         baseCanvas, resultCanvas, setPhase, setView, renderLayers,
//         updateControls, renderBusyDots, hasAnyResults, getLayer,
//         requestError, showToast, tx, loadImage }
import { createPool } from './layers.js';
import {
  regionNameFromBounds,
  buildAreaContext as _buildAreaContext,
} from './generation.js';

export function createGeneratePipeline(deps) {
  const {
    state,
    generateBtn,
    progressEl,
    progressBar,
    progressText,
    baseCanvas,
    resultCanvas,
    setPhase,
    setView,
    renderLayers,
    updateControls,
    renderBusyDots,
    hasAnyResults,
    getLayer,
    requestError,
    showToast,
    tx,
    loadImage,
  } = deps;

        // Shared mask math (growBinaryMask/buildModelMask/buildBlendMask/
        // compositeMaskedEditCanvas) — same module the main tool and the AI
        // Designer use, so the pixel-preservation guarantee is identical.
        let growBinaryMask, buildModelMask, buildBlendMask, compositeMaskedEditCanvas;
        const maskCoreReady = import('/scripts/mask-core.js').then((m) => {
          growBinaryMask = m.growBinaryMask;
          buildModelMask = m.buildModelMask;
          buildBlendMask = m.buildBlendMask;
          compositeMaskedEditCanvas = m.compositeMaskedEditCanvas;
        });

        // Rough position of a mask inside the photo ("lower left", "center"…)
        // from its bounding box on a small alpha scan — feeds the cross-area
        // context so parallel generations know what lands where.
        function maskRegionName(canvasEl) {
          const s = 48;
          const c = document.createElement('canvas');
          c.width = s; c.height = s;
          const sctx = c.getContext('2d');
          sctx.drawImage(canvasEl, 0, 0, s, s);
          const d = sctx.getImageData(0, 0, s, s).data;
          let minX = s, minY = s, maxX = -1, maxY = -1;
          for (let y = 0; y < s; y++) {
            for (let x = 0; x < s; x++) {
              if (d[(y * s + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          return regionNameFromBounds(minX, minY, maxX, maxY, s);
        }

        // Areas generate in parallel and never see each other's output, so each
        // prompt carries a sketch of the neighbors' plans — enough for the model
        // to keep lighting, perspective, and style coherent across areas.
        function buildAreaContext(layer, participants) {
          return _buildAreaContext(layer, participants, (l) => maskRegionName(l.canvasEl));
        }

        // At most 3 mask edits in flight at once: smoother on the server's rate
        // limiter and Gemini quotas than firing all 6 areas simultaneously,
        // while progressive compositing keeps the wait feeling short.
        const enqueueRun = createPool(3);

        // Union of every OTHER area's painted pixels, binarized. The grow +
        // feather halo may spill into unpainted photo (that forgiveness is the
        // point), but it must never cross into pixels the user assigned to a
        // different area — those are that area's exclusive territory.
        function othersStamp(layer, fillColor) {
          const others = state.layers.filter((l) => l !== layer && l.painted);
          if (!others.length) return null;
          const u = document.createElement('canvas');
          u.width = state.base.w;
          u.height = state.base.h;
          const uctx = u.getContext('2d');
          others.forEach((l) => uctx.drawImage(l.canvasEl, 0, 0));
          const stamp = growBinaryMask(u, state.base.w, state.base.h, 0); // grow 0 = binarize
          if (fillColor) {
            const sctx = stamp.getContext('2d');
            sctx.globalCompositeOperation = 'source-in';
            sctx.fillStyle = fillColor;
            sctx.fillRect(0, 0, state.base.w, state.base.h);
          }
          return stamp;
        }

        // buildModelMask / buildBlendMask with the halo clipped at neighboring
        // areas: black out (editable-region mask) or erase (compositing mask)
        // every pixel another area has painted.
        function layerModelMask(layer, coreGrow) {
          const mask = buildModelMask(layer.canvasEl, state.base.w, state.base.h, coreGrow);
          const stamp = othersStamp(layer, '#000');
          if (stamp) mask.getContext('2d').drawImage(stamp, 0, 0);
          return mask;
        }

        function layerBlendMask(layer, coreGrow, featherPx) {
          const mask = buildBlendMask(layer.canvasEl, state.base.w, state.base.h, coreGrow, featherPx);
          const stamp = othersStamp(layer);
          if (stamp) {
            const mctx = mask.getContext('2d');
            mctx.globalCompositeOperation = 'destination-out';
            mctx.drawImage(stamp, 0, 0);
            mctx.globalCompositeOperation = 'source-over';
          }
          return mask;
        }

        async function runLayer(layer, imageDataUrl, coreGrow, run, context, batchSize) {
          await maskCoreReady;
          const maskDataUrl = layerModelMask(layer, coreGrow).toDataURL('image/png');
          let prompt;
          if (layer.mode === 'remove') {
            prompt = tx(
              'maskingStudio.removePrompt',
              'Remove everything inside the highlighted area. Reconstruct what belongs behind it — floor, walls, baseboards, and trim — continuing the room’s existing surfaces, textures, and lighting seamlessly. Do not add any new furniture or objects.'
            );
            if (layer.prompt.trim()) prompt = (prompt + ' ' + layer.prompt.trim()).slice(0, 1000);
          } else {
            prompt = layer.prompt.trim() || tx(
              'maskingStudio.defaultFurniturePrompt',
              'Add the furniture from the reference photo into the highlighted area. Place it naturally on the floor with correct perspective, scale, and lighting for the room.'
            );
          }
          // Server caps prompts at 1000 chars — own prompt wins, context yields.
          if (context) prompt = (prompt + context).slice(0, 1000);
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const body = JSON.stringify({
            image: imageDataUrl,
            mask: maskDataUrl,
            prompt: prompt,
            authToken: tok || undefined,
            // Best-effort reproducibility passthrough + retry-budget hint for
            // multi-area batches (the server trims its quality retries).
            seed: (Math.random() * 0x7fffffff) | 0,
            batch: batchSize || 1,
            ...(layer.furniture && layer.mode !== 'remove' ? { referenceImage: layer.furniture } : {}),
          });
          let response, result;
          // Rate-limit pressure (429) and transient overload (503) get two
          // jittered retries before the area is declared failed.
          for (let attempt = 0; ; attempt++) {
            response = await fetch('/api/mask-edit', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
              },
              body: body,
            });
            result = null;
            try { result = await response.json(); } catch (e) {}
            if (run !== state.genRun) return; // a newer run/reset superseded this one
            if ((response.status !== 429 && response.status !== 503) || attempt >= 2) break;
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = retryAfter > 0 && retryAfter <= 120
              ? retryAfter * 1000
              : 1500 * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise((r) => setTimeout(r, waitMs));
            if (run !== state.genRun) return;
          }
          if (!response.ok || !result || !result.editedImage) {
            throw new Error(requestError(response.status, result));
          }
          const img = await loadImage(result.editedImage);
          if (run !== state.genRun) return;
          // Keep every version so the user can flip between them (capped to
          // bound memory: each is a full-resolution image).
          layer.candidates.push(img);
          if (layer.candidates.length > 4) layer.candidates.shift();
          layer.candIdx = layer.candidates.length - 1;
          layer.editedImg = img;
        }

        // The room payload goes up as JPEG (~10x smaller than PNG across N
        // parallel requests). This never touches the pixel-preservation
        // guarantee: compositing happens client-side from the pristine canvas,
        // so the upload encoding only affects what the model sees inside the
        // masked areas. Flattened onto white in case the source had alpha.
        function roomPayload() {
          const c = document.createElement('canvas');
          c.width = state.base.w;
          c.height = state.base.h;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, state.base.w, state.base.h);
          ctx.drawImage(state.base.canvas, 0, 0);
          return c.toDataURL('image/jpeg', 0.92);
        }

        function updateRunProgress(doneCount, total) {
          progressBar.style.width = Math.round((doneCount / total) * 100) + '%';
          const template = tx('maskingStudio.progressCount', '{done} of {total} areas staged');
          progressText.textContent = template.replace('{done}', String(doneCount)).replace('{total}', String(total));
        }

        async function generate() {
          if (generateBtn.disabled || !state.base) return;
          const participating = state.layers.filter((l) => l.painted);
          if (!participating.length) {
            showToast(tx('maskingStudio.needHighlight', 'Paint at least one area on the photo first.'), 'error');
            return;
          }
          const missing = participating.find((l) => l.mode !== 'remove' && !l.prompt.trim() && !l.furniture);
          if (missing) {
            state.activeId = missing.id;
            renderLayers();
            showToast(tx('maskingStudio.needPromptOrFurniture', 'Each highlighted area needs a short prompt or a furniture photo.'), 'error');
            return;
          }

          const run = ++state.genRun;
          const maxDim = Math.max(state.base.w, state.base.h);
          // ~10% of the single-mask editor's expansion: the studio promises
          // precise containment, so edits hug the highlight with only a thin
          // softening edge instead of the main tool's generous outward fade.
          const coreGrow = Math.max(2, Math.round(maxDim * 0.0023));
          const featherPx = Math.max(2, Math.round(maxDim * 0.004));
          state.genMeta = { coreGrow: coreGrow, featherPx: featherPx };
          const imageDataUrl = roomPayload();

          await maskCoreReady;
          participating.forEach((l) => {
            l.status = 'generating';
            l.editedImg = null;
            l.candidates = [];
            l.candIdx = 0;
            l.errorMsg = '';
            l.canvasEl.classList.remove('is-landed');
            // Freeze the compositing mask now — strokes can't change mid-run.
            l.blendMask = layerBlendMask(l, coreGrow, featherPx);
          });
          setPhase('generating');
          renderBusyDots(participating);
          progressEl.classList.remove('hidden');
          progressText.classList.remove('hidden');
          updateRunProgress(0, participating.length);

          let settled = 0;
          await Promise.all(participating.map((layer) =>
            enqueueRun(() => runLayer(layer, imageDataUrl, coreGrow, run, buildAreaContext(layer, participating), participating.length))
              .then(() => { if (run === state.genRun) layer.status = 'done'; })
              .catch((err) => {
                if (run !== state.genRun) return;
                layer.status = 'failed';
                layer.errorMsg = err && err.message ? err.message : '';
              })
              .then(() => {
                if (run !== state.genRun) return;
                settled++;
                updateRunProgress(settled, participating.length);
                renderBusyDots(participating);
                renderLayers();
                updateControls(); // keep layer controls disabled through the run
                if (layer.status === 'done') {
                  layer.canvasEl.classList.add('is-landed');
                  updateStageBackdrop();
                }
              })
          ));
          if (run !== state.genRun) return;

          state.layers.forEach((l) => l.canvasEl && l.canvasEl.classList.remove('is-landed'));
          progressEl.classList.add('hidden');
          progressText.classList.add('hidden');
          compositeAll();
          const done = participating.filter((l) => l.status === 'done').length;
          if (done > 0) {
            // Land in Refine Edit: highlights over the pure After (raw output
            // ghosted outside them), and Looks Good waiting in the header.
            setPhase('draw');
          } else {
            setPhase('review');
            setView('before');
          }
          if (done === participating.length) {
            showToast(tx('maskingStudio.doneToast', 'All areas staged!'), 'success');
          } else if (done > 0) {
            const t = tx('maskingStudio.partialToast', '{done} of {total} areas staged — retry the failed ones.');
            showToast(t.replace('{done}', String(done)).replace('{total}', String(participating.length)), 'error');
          } else {
            showToast(tx('maskingStudio.failedToast', 'Staging failed. Please try again.'), 'error');
          }
        }
        generateBtn.addEventListener('click', generate);

        // Pick a different generated version of an area and recomposite.
        function selectCandidate(layer, idx) {
          if (!layer.candidates.length || state.phase === 'generating') return;
          layer.candIdx = ((idx % layer.candidates.length) + layer.candidates.length) % layer.candidates.length;
          layer.editedImg = layer.candidates[layer.candIdx];
          compositeAll();
          setView(state.view);
          renderLayers();
        }

        // Re-run a single failed/done area, then rebuild the composite.
        async function retryLayer(id) {
          const layer = getLayer(id);
          if (!layer || !state.base || state.phase === 'generating' || !state.genMeta) return;
          if (!layer.painted) return;
          const run = state.genRun;
          layer.status = 'generating';
          layer.errorMsg = '';
          if (!layer.blendMask) {
            await maskCoreReady;
            layer.blendMask = layerBlendMask(layer, state.genMeta.coreGrow, state.genMeta.featherPx);
          }
          renderLayers();
          updateControls();
          try {
            await enqueueRun(() => runLayer(layer, roomPayload(), state.genMeta.coreGrow, run, buildAreaContext(layer, state.layers.filter((l) => l.painted)), 1));
            if (run !== state.genRun) return;
            layer.status = 'done';
          } catch (err) {
            if (run !== state.genRun) return;
            if (layer.candidates.length) {
              // "Try another version" failed but earlier versions survive.
              layer.status = 'done';
              layer.editedImg = layer.candidates[layer.candIdx];
              showToast(err && err.message ? err.message : tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
            } else {
              layer.status = 'failed';
              layer.errorMsg = err && err.message ? err.message : '';
            }
          }
          compositeAll();
          setView(state.view);
          renderLayers();
          updateControls();
          updateStageBackdrop(); // retries can happen from the refine phase too
        }

        // Chain the per-area composites over the pristine original, in layer
        // order. compositeMaskedEditCanvas keeps its input untouched outside
        // each area's feathered mask, so anything never highlighted is the
        // original image, pixel for pixel.
        function compositeAll() {
          if (!state.base) return;
          let acc = document.createElement('canvas');
          acc.width = state.base.w;
          acc.height = state.base.h;
          acc.getContext('2d').drawImage(state.base.canvas, 0, 0);
          state.layers.forEach((layer) => {
            if (layer.status !== 'done' || !layer.editedImg) return;
            // Strokes edited since the run invalidate the cached mask; rebuild
            // from the current strokes — same "re-crop, don't re-generate"
            // semantics as the single-mask editor's refine step.
            if (!layer.blendMask && state.genMeta && buildBlendMask) {
              layer.blendMask = layerBlendMask(layer, state.genMeta.coreGrow, state.genMeta.featherPx);
            }
            if (layer.blendMask) {
              acc = compositeMaskedEditCanvas(acc, layer.blendMask, layer.editedImg, state.base.w, state.base.h);
            }
          });
          const ctx = resultCanvas.getContext('2d');
          ctx.clearRect(0, 0, state.base.w, state.base.h);
          ctx.drawImage(acc, 0, 0);
        }

        // What the display canvas shows underneath the highlights. Normally the
        // original photo; while refining after a run it mirrors the main tool's
        // renderRefinePreview: highlighted areas show exactly the composited
        // After, and each area's raw AI output is ghosted on top so content the
        // model painted just past the strokes stays visible and brushable-in.
        function updateStageBackdrop() {
          if (!state.base) return;
          const ctx = baseCanvas.getContext('2d');
          ctx.clearRect(0, 0, state.base.w, state.base.h);
          if (state.phase === 'generating' && hasAnyResults()) {
            // Progressive composite: each finished area lands in the backdrop
            // while the rest of the run is still generating.
            compositeAll();
            ctx.drawImage(resultCanvas, 0, 0);
          } else if (state.phase === 'draw' && hasAnyResults()) {
            compositeAll();
            ctx.drawImage(resultCanvas, 0, 0);
            // Ghost each area's raw output only OUTSIDE the highlights. A raw
            // frame holds original-looking pixels where OTHER areas' edits sit,
            // so an unclipped ghost would wash a neighbor's pure After back
            // toward the Before — clip it out per layer.
            ctx.globalAlpha = 0.55;
            state.layers.forEach((layer) => {
              if (layer.status !== 'done' || !layer.editedImg) return;
              const g = document.createElement('canvas');
              g.width = state.base.w;
              g.height = state.base.h;
              const gctx = g.getContext('2d');
              gctx.drawImage(layer.editedImg, 0, 0, state.base.w, state.base.h);
              const stamp = othersStamp(layer);
              if (stamp) {
                gctx.globalCompositeOperation = 'destination-out';
                gctx.drawImage(stamp, 0, 0);
                gctx.globalCompositeOperation = 'source-over';
              }
              ctx.drawImage(g, 0, 0);
            });
            ctx.globalAlpha = 1;
          } else {
            ctx.drawImage(state.base.canvas, 0, 0);
          }
        }
  return { compositeAll, updateStageBackdrop, selectCandidate, retryLayer };
}
