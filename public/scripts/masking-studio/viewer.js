// The phase/view presentation layer for the Masking Studio entry
// (scripts/masking-studio-app.js): the setPhase state machine, the
// before/compare/after view toggle, the compare divider, zoom & pan, and the
// busy overlay + control-enablement (updateControls). Lifted verbatim from the
// entry; the private comparePos / busyMsgTimer / busyOverlay module state
// travels with this slice. Cross-island collaborators (renderLayers,
// updateChipbarVisibility, layerColor, layerTitle from layers-ui;
// updateStageBackdrop from generate-pipeline; hideCursor from draw-tools) arrive
// via `deps`.
export function createViewer(deps) {
  const {
    state,
    MAX_LAYERS,
    stack,
    baseCanvas,
    resultCanvas,
    viewerEl,
    viewToggle,
    viewerHeader,
    viewerActions,
    editHighlightsBtn,
    viewResultBtn,
    downloadBtn,
    toggleBeforeBtn,
    toggleCompareBtn,
    toggleAfterBtn,
    compareEl,
    compareGrip,
    compareLabelBefore,
    compareLabelAfter,
    addLayerBtn,
    replaceBtn,
    brushSlider,
    brushBtn,
    eraseBtn,
    rectBtn,
    wandBtn,
    undoBtn,
    redoBtn,
    layerList,
    generateBtn,
    ctaHint,
    tx,
    renderLayers,
    updateChipbarVisibility,
    updateStageBackdrop,
    hideCursor,
    layerColor,
    layerTitle,
  } = deps;

  let busyMsgTimer = null;
  let comparePos = 0.5;     // compare-view divider, 0..1 of photo width
  let busyOverlay = null;

  // Zoom & pan. Zoom works by setting an explicit CSS width on the base
  // canvas (the overlay canvases are inset:0/100%, so they follow), which
  // keeps all pointer math valid: it already reads getBoundingClientRect.
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;

  function setZoom(nz, focal) {
    if (!state.base) return;
    nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nz));
    const rect = baseCanvas.getBoundingClientRect();
    if (!rect.width) return;
    const fitW = rect.width / state.zoom; // current width always equals fit × zoom
    const prev = state.zoom;
    state.zoom = nz;
    if (state.zoom === 1) {
      baseCanvas.style.width = '';
      baseCanvas.style.maxWidth = '';
      baseCanvas.style.maxHeight = '';
    } else {
      baseCanvas.style.width = (fitW * state.zoom) + 'px';
      baseCanvas.style.maxWidth = 'none';
      baseCanvas.style.maxHeight = 'none';
    }
    viewerEl.classList.toggle('is-zoomed', state.zoom > 1);
    // Keep the focal point (viewport coords) stationary while scaling.
    if (focal && prev !== state.zoom) {
      const vr = viewerEl.getBoundingClientRect();
      const ratio = state.zoom / prev;
      viewerEl.scrollLeft = (viewerEl.scrollLeft + (focal.x - vr.left)) * ratio - (focal.x - vr.left);
      viewerEl.scrollTop = (viewerEl.scrollTop + (focal.y - vr.top)) * ratio - (focal.y - vr.top);
    }
  }

  function resetZoom() {
    state.zoom = 1;
    baseCanvas.style.width = '';
    baseCanvas.style.maxWidth = '';
    baseCanvas.style.maxHeight = '';
    viewerEl.classList.remove('is-zoomed');
  }

  viewerEl.addEventListener('wheel', (e) => {
    if (!state.base || !e.ctrlKey) return; // plain scroll stays plain scroll
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX, y: e.clientY });
  }, { passive: false });

  function setPhase(p) {
    state.phase = p;
    const inReview = p === 'review';
    // "Edit highlights" must not strand the user away from their results:
    // in the draw phase, existing results stay reachable via "View result".
    const hasResults = state.layers.some((l) => l.status === 'done' && l.editedImg);
    viewToggle.classList.toggle('hidden', !inReview);
    // The header only ever holds the view toggle and the review actions;
    // collapse it entirely when neither shows so the photo sits higher.
    viewerHeader.classList.toggle('hidden', !(inReview || (p === 'draw' && hasResults)));
    viewerActions.classList.toggle('hidden', !(inReview || (p === 'draw' && hasResults)));
    editHighlightsBtn.classList.toggle('hidden', !inReview);
    viewResultBtn.classList.toggle('hidden', !(p === 'draw' && hasResults));
    downloadBtn.classList.toggle('hidden', !inReview);
    stack.classList.toggle('can-draw', p === 'draw');
    stack.classList.toggle('is-busy', p === 'generating');
    if (p !== 'draw') hideCursor();
    if (busyOverlay) busyOverlay.classList.toggle('hidden', p !== 'generating');
    if (p === 'generating') startBusyMessages(); else stopBusyMessages();
    updateStageBackdrop();
    if (inReview) {
      setView(state.view);
    } else {
      resultCanvas.classList.add('hidden');
      resultCanvas.style.clipPath = '';
      state.layers.forEach((l) => l.canvasEl.classList.remove('hidden'));
      compareEl.classList.add('hidden');
      compareLabelBefore.classList.add('hidden');
      compareLabelAfter.classList.add('hidden');
      stack.classList.remove('is-compare');
      state.comparing = false;
    }
    renderLayers();
    updateControls();
  }

  function setView(v) {
    state.view = v === 'before' ? 'before' : v === 'compare' ? 'compare' : 'after';
    toggleBeforeBtn.classList.toggle('active', state.view === 'before');
    toggleCompareBtn.classList.toggle('active', state.view === 'compare');
    toggleAfterBtn.classList.toggle('active', state.view === 'after');
    const inReview = state.phase === 'review';
    const showResult = inReview && state.view !== 'before';
    resultCanvas.classList.toggle('hidden', !showResult);
    state.layers.forEach((l) => l.canvasEl.classList.toggle('hidden', showResult));
    const compareOn = inReview && state.view === 'compare';
    compareEl.classList.toggle('hidden', !compareOn);
    compareLabelBefore.classList.toggle('hidden', !compareOn);
    compareLabelAfter.classList.toggle('hidden', !compareOn);
    stack.classList.toggle('is-compare', compareOn);
    if (compareOn) {
      setComparePos(comparePos);
    } else {
      state.comparing = false;
      resultCanvas.style.clipPath = '';
    }
    updateChipbarVisibility();
  }
  toggleBeforeBtn.addEventListener('click', () => setView('before'));
  toggleCompareBtn.addEventListener('click', () => setView('compare'));
  toggleAfterBtn.addEventListener('click', () => setView('after'));

  // The result canvas sits on top of the original: clipping its left side
  // at the divider shows Before on the left, After on the right.
  function setComparePos(f) {
    comparePos = Math.min(1, Math.max(0, f));
    const pct = (comparePos * 100).toFixed(2) + '%';
    compareEl.style.left = pct;
    resultCanvas.style.clipPath = 'inset(0 0 0 ' + pct + ')';
    compareGrip.setAttribute('aria-valuenow', String(Math.round(comparePos * 100)));
  }

  function moveCompare(e) {
    const rect = baseCanvas.getBoundingClientRect();
    if (!rect.width) return;
    setComparePos((e.clientX - rect.left) / rect.width);
  }

  compareGrip.addEventListener('keydown', (e) => {
    const step = 0.03;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setComparePos(comparePos - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setComparePos(comparePos + step); }
    else if (e.key === 'Home') { e.preventDefault(); setComparePos(0); }
    else if (e.key === 'End') { e.preventDefault(); setComparePos(1); }
  });

  function ensureBusyOverlay() {
    if (busyOverlay) return;
    busyOverlay = document.createElement('div');
    busyOverlay.className = 'ms-busy-overlay hidden';
    const spin = document.createElement('div');
    spin.className = 'ms-busy-spin';
    const dots = document.createElement('div');
    dots.className = 'ms-busy-dots';
    const msg = document.createElement('div');
    msg.className = 'ms-busy-msg';
    busyOverlay.appendChild(spin);
    busyOverlay.appendChild(dots);
    busyOverlay.appendChild(msg);
    stack.appendChild(busyOverlay);
  }

  // One dot per running area, in its highlight color: pulsing while it
  // stages, a check when done, an exclamation mark if it failed.
  function renderBusyDots(participating) {
    ensureBusyOverlay();
    const host = busyOverlay.querySelector('.ms-busy-dots');
    host.textContent = '';
    participating.forEach((l) => {
      const d = document.createElement('span');
      d.className = 'ms-busy-dot' + (l.status === 'generating' ? ' ms-busy-dot--running' : '');
      d.style.background = l.status === 'failed' ? '#b91c1c' : layerColor(l);
      d.textContent = l.status === 'done' ? '✓' : l.status === 'failed' ? '!' : '';
      d.title = layerTitle(l);
      host.appendChild(d);
    });
  }

  function loadingMessages() {
    const fromLang = window.LanguageSystem && window.LanguageSystem.getText('maskingStudio.loadingMessages');
    if (Array.isArray(fromLang) && fromLang.length) return fromLang;
    return [
      'Placing your furniture…',
      'Matching light and shadows…',
      'Blending each area in…',
      'Keeping the rest of the photo untouched…',
      'Adding finishing touches…',
    ];
  }

  function startBusyMessages() {
    ensureBusyOverlay();
    busyOverlay.classList.remove('hidden');
    const msgEl = busyOverlay.querySelector('.ms-busy-msg');
    const msgs = loadingMessages();
    let i = 0;
    msgEl.textContent = msgs[0];
    if (busyMsgTimer) clearInterval(busyMsgTimer);
    busyMsgTimer = setInterval(() => {
      i = (i + 1) % msgs.length;
      msgEl.textContent = msgs[i];
    }, 2200);
  }

  function stopBusyMessages() {
    if (busyMsgTimer) { clearInterval(busyMsgTimer); busyMsgTimer = null; }
    if (busyOverlay) busyOverlay.classList.add('hidden');
  }

  function updateControls() {
    const generating = state.phase === 'generating';
    addLayerBtn.disabled = !state.base || generating || state.layers.length >= MAX_LAYERS;
    replaceBtn.disabled = generating;
    brushSlider.disabled = generating;
    brushBtn.disabled = generating;
    eraseBtn.disabled = generating;
    rectBtn.disabled = generating;
    wandBtn.disabled = generating;
    undoBtn.disabled = generating || state.phase !== 'draw' || !state.undoStack.length;
    redoBtn.disabled = generating || state.phase !== 'draw' || !state.redoStack.length;
    editHighlightsBtn.disabled = generating;
    downloadBtn.disabled = generating || !state.layers.some((l) => l.status === 'done');
    layerList.querySelectorAll('textarea, button').forEach((el) => { el.disabled = generating; });

    const painted = state.layers.filter((l) => l.painted);
    const allDetailed = painted.length > 0 && painted.every((l) => l.mode === 'remove' || l.prompt.trim() || l.furniture);
    generateBtn.disabled = !state.base || generating || !allDetailed;

    // Explain a disabled Apply Edit instead of leaving it a mystery.
    let hint = '';
    if (!generating) {
      if (!state.base) hint = tx('errors.uploadFirst', 'Please upload an image first');
      else if (!painted.length) hint = tx('maskingStudio.needHighlight', 'Paint at least one area on the photo first.');
      else if (!allDetailed) hint = tx('maskingStudio.needPromptOrFurniture', 'Each highlighted area needs a short prompt or a furniture photo.');
    }
    ctaHint.textContent = hint;
    ctaHint.classList.toggle('hidden', !hint);
  }

  return { setPhase, setView, setComparePos, moveCompare, renderBusyDots, updateControls, setZoom, resetZoom };
}
