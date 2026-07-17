// Area-layer model + all layer/chip DOM rendering for the Masking Studio entry
// (scripts/masking-studio-app.js). Owns create/remove/find/active-layer, the
// palette-color/title/status binding wrappers, the big renderLayers card
// builder, the quick-switch chip bar, and the add-layer button + languagechange
// wiring. Lifted verbatim from the entry; cross-island collaborators arrive via
// `deps` (late-bound where a sibling island is created after this one).
//
// deps: { state, MAX_LAYERS, PALETTE, layerList, chipbar, stack, resultCanvas,
//         addLayerBtn, tx, showToast, updateControls, scheduleSessionSave,
//         updateStageBackdrop, compositeAll, setPhase, snapshotForUndo,
//         retryLayer, selectCandidate, wireFurnitureDrop, beginFurniturePick }
import {
  nextColorIdx,
  createLayer,
  layerColor as _layerColor,
  layerTitle as _layerTitle,
  previewText as _previewText,
  statusChip as _statusChip,
} from './layers.js';

export function createLayersUi(deps) {
  const {
    state,
    MAX_LAYERS,
    PALETTE,
    layerList,
    chipbar,
    stack,
    resultCanvas,
    addLayerBtn,
    tx,
    showToast,
    updateControls,
    scheduleSessionSave,
    updateStageBackdrop,
    compositeAll,
    setPhase,
    snapshotForUndo,
    retryLayer,
    selectCandidate,
    wireFurnitureDrop,
    beginFurniturePick,
    snapLayer,
  } = deps;

  function addLayer() {
    if (!state.base || state.layers.length >= MAX_LAYERS) return;
    const colorIdx = nextColorIdx(state.layers, PALETTE.length);
    if (colorIdx === -1) return;
    const c = document.createElement('canvas');
    c.width = state.base.w;
    c.height = state.base.h;
    c.className = 'ms-layer-canvas';
    // Insert below the result canvas so results always cover highlights.
    stack.insertBefore(c, resultCanvas);
    const layer = createLayer({ id: 'L' + (++state.layerSeq), colorIdx: colorIdx, canvasEl: c });
    state.layers.push(layer);
    state.activeId = layer.id;
    renderLayers();
    updateControls();
    scheduleSessionSave();
  }

  function removeLayer(id) {
    const idx = state.layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    const layer = state.layers[idx];
    if (layer.canvasEl) layer.canvasEl.remove();
    state.layers.splice(idx, 1);
    if (state.activeId === id) state.activeId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
    if (!state.layers.length && state.base) addLayer();
    if (state.phase === 'review') compositeAll();
    // Re-derive the whole phase UI: in refine, removing an area must
    // refresh the ghost backdrop and may retire the Looks Good button
    // (when the last staged area went away).
    setPhase(state.phase);
    scheduleSessionSave();
  }

  function getLayer(id) {
    return state.layers.find((l) => l.id === id) || null;
  }

  function activeLayer() {
    return getLayer(state.activeId);
  }

  // Thin binding wrappers over the pure area-model helpers (scripts/
  // masking-studio/layers.js): bind the live PALETTE / layers array / tx so
  // every call site below stays unchanged. Logic + tests live in the module.
  function layerColor(layer) { return _layerColor(layer, PALETTE); }
  function layerTitle(layer) { return _layerTitle(layer, state.layers, tx); }
  function statusChip(layer) { return _statusChip(layer, tx); }

  // Rebuild the layer cards. Prompt edits mutate state directly (no
  // re-render on keystroke), so rebuilding here never loses typed text.
  // Only the active card shows its full body — inactive areas collapse
  // to their header row so six areas don't make the toolbar a tower.
  function renderLayers() {
    layerList.textContent = '';
    state.layers.forEach((layer) => {
      const isActive = layer.id === state.activeId;
      const card = document.createElement('div');
      card.className = 'ms-layer' + (isActive ? ' is-active' : '');
      card.style.setProperty('--layer-color', layerColor(layer));
      card.setAttribute('role', 'listitem');

      const head = document.createElement('div');
      head.className = 'ms-layer-head';
      const dot = document.createElement('span');
      dot.className = 'ms-layer-dot';
      const name = document.createElement('span');
      name.className = 'ms-layer-name';
      name.textContent = layerTitle(layer);
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'ms-layer-rename';
      renameBtn.setAttribute('aria-label', tx('maskingStudio.renameAria', 'Rename this area'));
      renameBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.phase === 'generating') return;
        let settled = false;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ms-layer-name-input';
        input.maxLength = 24;
        input.value = layer.name || layerTitle(layer);
        head.replaceChild(input, name);
        renameBtn.classList.add('hidden');
        input.focus();
        input.select();
        input.addEventListener('click', (ev) => ev.stopPropagation());
        const commit = () => {
          if (settled) return;
          settled = true;
          layer.name = input.value.trim();
          renderLayers();
          scheduleSessionSave();
        };
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') commit();
          else if (ev.key === 'Escape') { settled = true; renderLayers(); }
        });
        input.addEventListener('blur', commit);
      });
      const previewFallback = () => _previewText(layer, tx);
      const preview = document.createElement('span');
      preview.className = 'ms-layer-preview';
      preview.textContent = previewFallback();
      preview.title = previewFallback();
      const chip = statusChip(layer);
      const status = document.createElement('span');
      status.className = 'ms-layer-status ' + chip.cls;
      status.textContent = chip.text;
      // Advertises a pending "Snap to object" suggestion even while the card is
      // collapsed, so areas whose edit spilled past the highlight stand out.
      const hasSpill = !!(layer.spill && layer.spill.count > 0 && layer.status === 'done');
      const caret = document.createElement('span');
      caret.className = 'ms-layer-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ms-layer-remove';
      removeBtn.setAttribute('aria-label', tx('maskingStudio.removeAreaAria', 'Remove this area'));
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.phase === 'generating') return;
        removeLayer(layer.id);
      });
      head.appendChild(dot);
      head.appendChild(name);
      head.appendChild(renameBtn);
      head.appendChild(preview);
      head.appendChild(status);
      if (hasSpill) {
        const flag = document.createElement('span');
        flag.className = 'ms-layer-spill-flag';
        flag.textContent = '⤢';
        flag.title = tx('maskingStudio.spillFlag', 'This edit reaches past the highlight — Snap to object available.');
        flag.setAttribute('aria-hidden', 'true');
        head.appendChild(flag);
      }
      head.appendChild(caret);
      head.appendChild(removeBtn);
      head.addEventListener('click', () => {
        if (state.phase === 'generating') return;
        state.activeId = layer.id;
        renderLayers();
      });

      if (!isActive) {
        // Collapsed: header only. Clicking the head (below) activates
        // and expands it.
        card.appendChild(head);
        layer.el = card;
        layerList.appendChild(card);
        return;
      }

      const body = document.createElement('div');
      body.className = 'ms-layer-body';

      // Stage vs. remove: declutter is a first-class mode, not a prompt trick.
      const modeRow = document.createElement('div');
      modeRow.className = 'ms-mode-row';
      modeRow.setAttribute('role', 'group');
      modeRow.setAttribute('aria-label', tx('maskingStudio.modeAria', 'What happens in this area'));
      [
        ['stage', tx('maskingStudio.modeStage', 'Add furniture')],
        ['remove', tx('maskingStudio.modeRemove', 'Remove object')],
      ].forEach(([val, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ms-mode-btn' + (layer.mode === val ? ' is-on' : '');
        b.setAttribute('aria-pressed', layer.mode === val ? 'true' : 'false');
        b.textContent = label;
        b.addEventListener('click', () => {
          if (state.phase === 'generating' || layer.mode === val) return;
          layer.mode = val;
          renderLayers();
          updateControls();
          scheduleSessionSave();
        });
        modeRow.appendChild(b);
      });
      body.appendChild(modeRow);

      const isRemove = layer.mode === 'remove';
      if (isRemove) {
        const hint = document.createElement('p');
        hint.className = 'ms-mode-hint';
        hint.textContent = tx('maskingStudio.removeHint', 'Everything highlighted is removed and the empty room is rebuilt behind it.');
        body.appendChild(hint);
      }

      const promptEl = document.createElement('textarea');
      promptEl.className = 'text-input ms-layer-prompt';
      promptEl.rows = 2;
      promptEl.maxLength = 1000;
      promptEl.placeholder = isRemove
        ? tx('maskingStudio.removePlaceholder', 'Optional: anything to keep or details to match (e.g. keep the rug)…')
        : tx('maskingStudio.promptPlaceholder', 'Describe what to add here (optional if you add a furniture photo)…');
      promptEl.value = layer.prompt;
      promptEl.addEventListener('input', () => {
        layer.prompt = promptEl.value;
        // Refresh this card's status chip in place (a full re-render here
        // would steal focus from the textarea mid-typing).
        const liveChip = statusChip(layer);
        status.className = 'ms-layer-status ' + liveChip.cls;
        status.textContent = liveChip.text;
        preview.textContent = previewFallback();
        preview.title = preview.textContent;
        updateControls();
        scheduleSessionSave();
      });
      promptEl.addEventListener('focus', () => {
        if (state.activeId !== layer.id && state.phase !== 'generating') {
          state.activeId = layer.id;
          // Highlight without a full re-render so the textarea keeps focus.
          layerList.querySelectorAll('.ms-layer').forEach((el) => el.classList.remove('is-active'));
          card.classList.add('is-active');
        }
      });
      body.appendChild(promptEl);

      // One-click prompt ideas while the prompt is empty, tucked behind a
      // little + so the card stays quiet until asked. Each value is
      // "Chip label|Full prompt sentence" in the language files.
      if (!layer.prompt.trim() && !isRemove) {
        if (!layer.presetsOpen) {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'ms-preset-toggle';
          toggle.textContent = '+';
          const ideasLabel = tx('maskingStudio.promptIdeas', 'Show prompt ideas');
          toggle.setAttribute('aria-label', ideasLabel);
          toggle.title = ideasLabel;
          toggle.setAttribute('aria-expanded', 'false');
          toggle.addEventListener('click', () => {
            if (state.phase === 'generating') return;
            layer.presetsOpen = true;
            renderLayers();
          });
          body.appendChild(toggle);
        } else {
          const PRESET_DEFAULTS = {
            presetSofa: "Sofa|Add a comfortable modern sofa that fits the room's style.",
            presetArmchair: 'Armchair|Add a cozy armchair that matches the room.',
            presetRug: 'Rug|Add a large area rug under the furniture.',
            presetPlant: 'Plant|Add a tall potted plant.',
            presetLamp: 'Floor lamp|Add a stylish floor lamp.',
            presetArt: 'Wall art|Add framed wall art that suits the room.',
          };
          const presetRow = document.createElement('div');
          presetRow.className = 'ms-preset-row';
          Object.keys(PRESET_DEFAULTS).forEach((key) => {
            const raw = tx('maskingStudio.' + key, PRESET_DEFAULTS[key]);
            const bar = raw.indexOf('|');
            const label = bar === -1 ? raw : raw.slice(0, bar);
            const sentence = bar === -1 ? raw : raw.slice(bar + 1);
            const chipBtn = document.createElement('button');
            chipBtn.type = 'button';
            chipBtn.className = 'ms-preset';
            chipBtn.textContent = label;
            chipBtn.title = sentence;
            chipBtn.addEventListener('click', () => {
              if (state.phase === 'generating') return;
              layer.prompt = sentence;
              layer.presetsOpen = false; // next time takes a + click again
              renderLayers();
              updateControls();
            });
            presetRow.appendChild(chipBtn);
          });
          // Trailing "−" tucks the chips back away.
          const closeChip = document.createElement('button');
          closeChip.type = 'button';
          closeChip.className = 'ms-preset';
          closeChip.textContent = '−';
          closeChip.setAttribute('aria-label', tx('common.close', 'Close'));
          closeChip.title = tx('common.close', 'Close');
          closeChip.addEventListener('click', () => {
            layer.presetsOpen = false;
            renderLayers();
          });
          presetRow.appendChild(closeChip);
          body.appendChild(presetRow);
        }
      }

      if (isRemove) {
        // No furniture reference in remove mode — nothing is being added.
      } else if (layer.furniture) {
        const prev = document.createElement('div');
        prev.className = 'ms-furniture-preview';
        const img = document.createElement('img');
        img.src = layer.furniture;
        img.alt = tx('pdf.maskEditor.referenceAlt', 'Reference for masked edit');
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ms-furniture-remove';
        rm.setAttribute('aria-label', tx('pdf.maskEditor.referenceRemove', 'Remove reference photo'));
        rm.innerHTML = '&times;';
        rm.addEventListener('click', () => {
          if (state.phase === 'generating') return;
          layer.furniture = null;
          layer.furnitureName = '';
          renderLayers();
          updateControls();
          scheduleSessionSave();
        });
        prev.appendChild(img);
        prev.appendChild(rm);
        body.appendChild(prev);
      } else {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'ms-furniture-add';
        add.textContent = tx('maskingStudio.addFurniture', '+ Furniture photo');
        add.addEventListener('click', () => {
          if (state.phase === 'generating') return;
          beginFurniturePick(layer.id);
        });
        wireFurnitureDrop(add, layer);
        body.appendChild(add);
      }

      // Quick way to clear one area's strokes (undoable via Ctrl+Z).
      if (layer.painted && state.phase === 'draw') {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ms-clear-btn';
        clearBtn.textContent = tx('maskingStudio.clearHighlight', 'Clear highlight');
        clearBtn.addEventListener('click', () => {
          if (state.phase !== 'draw') return;
          snapshotForUndo();
          state.redoStack = []; // committed clear forks history
          layer.canvasEl.getContext('2d').clearRect(0, 0, state.base.w, state.base.h);
          layer.painted = false;
          // All masks, not just this one: neighbors' halos are clipped
          // against this area's (now vacated) pixels.
          state.layers.forEach((l) => { l.blendMask = null; });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        });
        body.appendChild(clearBtn);
      }

      // Snap-to-object: the AI drew this area's object slightly past the
      // highlight, so offer to grow the mask to it (grow-only, undoable).
      if (hasSpill && state.phase === 'draw') {
        const snapBtn = document.createElement('button');
        snapBtn.type = 'button';
        snapBtn.className = 'ms-snap-btn';
        snapBtn.textContent = tx('maskingStudio.snapToObject', 'Snap to object');
        snapBtn.title = tx('maskingStudio.snapToObjectHint', "Grow this highlight to the edges of what the AI actually drew, so nothing gets cut off.");
        snapBtn.addEventListener('click', () => {
          if (state.phase !== 'draw') return;
          snapLayer(layer.id);
        });
        body.appendChild(snapBtn);
      }

      if (layer.status === 'failed') {
        const err = document.createElement('div');
        err.className = 'ms-layer-error';
        err.textContent = layer.errorMsg || tx('maskingStudio.statusFailed', 'Failed');
        body.appendChild(err);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ms-layer-retry';
        retry.textContent = tx('maskingStudio.retry', 'Retry');
        retry.addEventListener('click', () => retryLayer(layer.id));
        body.appendChild(retry);
      } else if (layer.status === 'done' && state.phase === 'review') {
        // Version picker: flip between every generated result of this area.
        if (layer.candidates.length > 1) {
          const row = document.createElement('div');
          row.className = 'ms-version-row';
          const prev = document.createElement('button');
          prev.type = 'button';
          prev.className = 'ms-version-btn';
          prev.textContent = '‹';
          prev.setAttribute('aria-label', tx('maskingStudio.versionPrev', 'Previous version'));
          prev.addEventListener('click', () => selectCandidate(layer, layer.candIdx - 1));
          const label = document.createElement('span');
          label.className = 'ms-version-label';
          label.textContent = tx('maskingStudio.versionLabel', 'Version {i} of {n}')
            .replace('{i}', String(layer.candIdx + 1))
            .replace('{n}', String(layer.candidates.length));
          const next = document.createElement('button');
          next.type = 'button';
          next.className = 'ms-version-btn';
          next.textContent = '›';
          next.setAttribute('aria-label', tx('maskingStudio.versionNext', 'Next version'));
          next.addEventListener('click', () => selectCandidate(layer, layer.candIdx + 1));
          row.appendChild(prev);
          row.appendChild(label);
          row.appendChild(next);
          body.appendChild(row);
        }
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ms-layer-retry';
        retry.style.borderColor = '#2563eb';
        retry.style.color = '#2563eb';
        retry.textContent = tx('maskingStudio.tryAnother', 'Try another version');
        retry.addEventListener('click', () => retryLayer(layer.id));
        body.appendChild(retry);
      }

      card.appendChild(head);
      card.appendChild(body);
      layer.el = card;
      layerList.appendChild(card);
    });
    renderChips();
  }

  // Compact quick-switch chips above the canvas mirroring the layer list,
  // so switching colors doesn't require leaving the photo.
  function renderChips() {
    chipbar.textContent = '';
    state.layers.forEach((layer) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ms-chip' + (layer.id === state.activeId ? ' is-active' : '');
      chip.style.setProperty('--layer-color', layerColor(layer));
      const dot = document.createElement('span');
      dot.className = 'ms-layer-dot';
      dot.style.background = layerColor(layer);
      const label = document.createElement('span');
      label.textContent = layerTitle(layer);
      chip.appendChild(dot);
      chip.appendChild(label);
      chip.addEventListener('click', () => {
        if (state.phase === 'generating') return;
        state.activeId = layer.id;
        renderLayers();
      });
      chipbar.appendChild(chip);
    });
    if (state.base && state.layers.length < MAX_LAYERS) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ms-chip ms-chip--add';
      add.textContent = tx('maskingStudio.addArea', '+ Add area');
      add.addEventListener('click', () => {
        if (state.phase === 'generating') return;
        addLayer();
      });
      chipbar.appendChild(add);
    }
    updateChipbarVisibility();
  }

  function updateChipbarVisibility() {
    const visible = !!state.base && state.phase !== 'empty' && !(state.phase === 'review' && state.view !== 'before');
    chipbar.classList.toggle('hidden', !visible);
  }

  addLayerBtn.addEventListener('click', () => {
    if (state.layers.length >= MAX_LAYERS) {
      const t = tx('maskingStudio.areaLimit', 'You can highlight up to {n} areas.');
      showToast(t.replace('{n}', String(MAX_LAYERS)));
      return;
    }
    addLayer();
  });

  // Re-render translated card copy when the language changes.
  window.addEventListener('languagechange', () => {
    renderLayers();
    updateControls();
  });

  return {
    addLayer,
    removeLayer,
    getLayer,
    activeLayer,
    layerColor,
    layerTitle,
    statusChip,
    renderLayers,
    renderChips,
    updateChipbarVisibility,
  };
}
