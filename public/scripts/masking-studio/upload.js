// Room-photo intake and per-area furniture-reference intake for the Masking
// Studio entry (scripts/masking-studio-app.js): HEIC coercion, type/size
// validation, decode + stageable-room pre-check, furniture prepare/downscale,
// and all the drop / paste / dropzone / replace wiring. Lifted verbatim from the
// entry. The pendingFurnitureLayerId cursor is encapsulated here (via
// beginFurniturePick) so it never becomes a cross-module shared var.
//
// deps: { state, dropzone, fileInput, furnitureInput, stack, replaceBtn, showToast,
//         tx, loadImage, setBaseImage, requestDiscard, activeLayer, getLayer,
//         renderLayers, updateControls, layerTitle, scheduleSessionSave }
export function createUpload(deps) {
  const {
    state,
    dropzone,
    fileInput,
    furnitureInput,
    stack,
    replaceBtn,
    showToast,
    tx,
    loadImage,
    setBaseImage,
    clearBaseImage,
    requestDiscard,
    activeLayer,
    getLayer,
    renderLayers,
    updateControls,
    layerTitle,
    scheduleSessionSave,
  } = deps;

  let pendingFurnitureLayerId = null;

  const ROOM_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

  const DEFAULT_UNSTAGEABLE_MESSAGE =
    "This doesn't look like a room, space, or piece of furniture. Please upload a photo of an interior room, exterior space, or furniture you'd like to stage.";

  // Cheap server-side pre-check: is this actually a stageable room/property
  // photo (not a selfie, a product shot, a document…)? Downscales the
  // already-decoded image to a small JPEG first (keeps the POST tiny), then
  // asks the server. Always resolves to { valid, reason }; fails OPEN so our
  // own hiccup never blocks a legitimate upload.
  async function validateStageableRoom(img) {
    try {
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const payload = c.toDataURL('image/jpeg', 0.9);
      const tok = window.StagifyAuth && window.StagifyAuth.getToken();
      const resp = await fetch('/api/validate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
        },
        body: JSON.stringify({ image: payload, authToken: tok || undefined }),
      });
      if (!resp.ok) return { valid: true, reason: '' };
      const r = await resp.json().catch(() => null);
      if (!r || typeof r.valid !== 'boolean') return { valid: true, reason: '' };
      return r;
    } catch (e) {
      return { valid: true, reason: '' };
    }
  }

  async function handleRoomFile(file) {
    if (!file) return;
    try {
      if (window.StagifyHeic && window.StagifyHeic.isHeic(file)) {
        file = await window.StagifyHeic.toDisplayableFile(file);
      }
    } catch (e) {
      showToast(tx('errors.heicConvert', "We couldn't read that HEIC photo. Please try a JPG or PNG."), 'error');
      return;
    }
    if (ROOM_TYPES.indexOf((file.type || '').toLowerCase()) === -1) {
      showToast(tx('errors.fileType', 'Please upload a JPG, PNG, or WebP image.'), 'error');
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      showToast(tx('errors.fileTooLarge', 'That image is too large — please choose one under 100 MB.'), 'error');
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('read'));
      r.onload = () => resolve(r.result);
      r.readAsDataURL(file);
    }).catch(() => null);
    if (!dataUrl) {
      showToast(tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
      return;
    }
    let img;
    try {
      img = await loadImage(dataUrl);
    } catch (e) {
      showToast(tx('errors.fileType', 'Please upload a JPG, PNG, or WebP image.'), 'error');
      return;
    }
    // Show the photo in the studio immediately, then run the stageability
    // pre-check in the background so the vision round-trip never blocks the
    // upload. A non-room (a selfie, a product shot, a document…) is pulled
    // back out (clearBaseImage) when the verdict lands, with a friendly reason
    // instead of wasting a masking generation. Capturing state.base guards the
    // race where a quick re-upload replaces this photo before its verdict
    // arrives — a stale rejection must not tear down the newer photo.
    setBaseImage(img);
    const token = state.base;
    validateStageableRoom(img).then((stageable) => {
      if (!stageable || stageable.valid !== false) return;
      if (state.base !== token) return;
      clearBaseImage();
      showToast(stageable.reason || DEFAULT_UNSTAGEABLE_MESSAGE, 'error');
    });
  }

  // ---------------------------------------------------------------------
  // Furniture reference photos (per area)
  // ---------------------------------------------------------------------
  // Validate, downscale (max 1536px) and PNG-encode — identical rules to
  // the single-mask editor so the backend sees the same payloads.
  function prepareReferenceFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(jpeg|jpg|png|webp)$/i.test(file.type || '')) { reject(new Error('type')); return; }
      if (file.size > 25 * 1024 * 1024) { reject(new Error('size')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode'));
        img.onload = () => {
          const maxDim = 1536;
          const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round((img.width || 1) * scale));
          const h = Math.max(1, Math.round((img.height || 1) * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          try { resolve(c.toDataURL('image/png')); } catch (e) { reject(new Error('decode')); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function refErrorMessage(err) {
    return err && err.message === 'size'
      ? tx('pdf.maskEditor.referenceTooLarge', 'That image is too large — please choose one under 25 MB.')
      : tx('pdf.maskEditor.referenceInvalid', 'Please choose a valid JPG, PNG, or WebP image.');
  }

  function acceptFurnitureFile(layer, file, announce) {
    if (!layer || !file) return;
    const fileName = file.name || '';
    const prep = (window.StagifyHeic && window.StagifyHeic.isHeic(file))
      ? window.StagifyHeic.toDisplayableFile(file)
      : Promise.resolve(file);
    prep
      .then(prepareReferenceFile)
      .then((dataUrl) => {
        layer.furniture = dataUrl;
        layer.furnitureName = fileName;
        renderLayers();
        updateControls();
        scheduleSessionSave();
        if (announce && getLayer(layer.id)) {
          const t = tx('maskingStudio.furniturePasted', 'Furniture photo added to {area}');
          showToast(t.replace('{area}', layerTitle(layer)), 'success');
        }
      })
      .catch((err) => showToast(refErrorMessage(err), 'error'));
  }

  function wireFurnitureDrop(zone, layer) {
    const hasFiles = (e) =>
      !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    zone.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); zone.classList.add('is-drag-over'); } });
    zone.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-drag-over'));
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove('is-drag-over');
      acceptFurnitureFile(layer, e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  // Arm the shared furniture file picker for a specific area, then open it.
  // Keeps the pendingFurnitureLayerId cursor private to this island.
  function beginFurniturePick(layerId) {
    pendingFurnitureLayerId = layerId;
    furnitureInput.click();
  }

  furnitureInput.addEventListener('change', () => {
    const file = furnitureInput.files && furnitureInput.files[0];
    furnitureInput.value = '';
    acceptFurnitureFile(getLayer(pendingFurnitureLayerId), file);
    pendingFurnitureLayerId = null;
  });

  // Paste an image from the clipboard: before a photo is loaded it becomes
  // the room photo; afterwards it becomes the active area's furniture.
  document.addEventListener('paste', (e) => {
    if (state.phase === 'generating') return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    const files = (e.clipboardData && e.clipboardData.files) || [];
    const file = Array.prototype.find.call(files, (f) => /^image\//i.test(f.type || ''));
    if (!file) return;
    e.preventDefault();
    if (!state.base) {
      handleRoomFile(file);
      return;
    }
    if (state.phase === 'draw') acceptFurnitureFile(activeLayer(), file, true);
  });

  // Upload wiring (dropzone click/keyboard/drop + toolbar replace)
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  replaceBtn.addEventListener('click', () => {
    if (state.phase === 'generating') return;
    requestDiscard(() => fileInput.click());
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    handleRoomFile(file);
  });
  (function wireRoomDrop() {
    const hasFiles = (e) =>
      !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    [dropzone, stack].forEach((zone) => {
      zone.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (zone === dropzone) dropzone.classList.add('is-drag-over');
      });
      zone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag-over'));
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dropzone.classList.remove('is-drag-over');
        if (state.phase === 'generating') return;
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        // Dropping on the photo itself is easy to do by accident when
        // aiming for the furniture button, so also guard unstaged work.
        requestDiscard(() => handleRoomFile(file), zone === stack);
      });
    });
  })();

  return { handleRoomFile, acceptFurnitureFile, wireFurnitureDrop, beginFurniturePick };
}
