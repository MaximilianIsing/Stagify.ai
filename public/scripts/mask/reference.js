// The mask editor's optional reference photo: HEIC-aware validate, downscale to
// 1536px, PNG-encode, preview show/hide, and the picker / remove / drag-drop
// wiring. Owns the reference data URL; the editor reads it via getDataUrl() when
// building the /api/mask-edit request.
//
// Shared by both mask editors. The two copies had the same validation rules and
// the same error copy but differed in two ways, both now parameters: the elements
// (the AI Designer's slice resolved `#mask-editor-ref-*` by id; the stage editor
// held its own `#stage-mask-ref-*` refs), and drag-and-drop, which only the stage
// editor had.
//
// `dropZones` defaults to none so adopting this module changes no behaviour on
// either page. Pass zones to opt in — the AI Designer could, and today doesn't.
//
//   createMaskReference({ lang, showError, onChange }) -> { clear, getDataUrl, wire }

const MAX_DIM = 1536;
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPE = /^image\/(jpeg|jpg|png|webp)$/i;

/**
 * @param {{
 *   lang: (key: string, fallback: string) => string,
 *   showError: (message: string) => void,
 *   onChange?: () => void,
 * }} deps - i18n lookup, the error channel, and an optional notification fired
 *   whenever the thumbnail appears or disappears (the editor re-fits around it).
 */
export function createMaskReference({ lang, showError, onChange }) {
  let referenceDataUrl = null;
  /** @type {{ fileInput: any, addBtn: any, removeBtn: any, preview: any, img: any }} */
  let els = { fileInput: null, addBtn: null, removeBtn: null, preview: null, img: null };

  const notifyChange = () => { if (onChange) onChange(); };

  function clear() {
    referenceDataUrl = null;
    const { fileInput, preview, img, addBtn } = els;
    if (fileInput) fileInput.value = '';
    if (preview) preview.classList.add('hidden');
    if (img) img.removeAttribute('src');
    if (addBtn) addBtn.classList.remove('hidden');
    notifyChange();
  }

  function set(dataUrl) {
    referenceDataUrl = dataUrl;
    const { preview, img, addBtn } = els;
    if (img) img.src = dataUrl;
    if (preview) preview.classList.remove('hidden');
    if (addBtn) addBtn.classList.add('hidden');
    notifyChange();
  }

  // Validate, downscale, and PNG-encode so the payload is always small, clean,
  // and a format the backend accepts. Rejects with 'type' | 'size' | 'read' | 'decode'.
  function prepareReferenceFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !ALLOWED_TYPE.test(file.type || '')) { reject(new Error('type')); return; }
      if (file.size > MAX_BYTES) { reject(new Error('size')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode'));
        img.onload = () => {
          // min(1, …): the cap only ever shrinks, never upscales a small photo.
          const scale = Math.min(1, MAX_DIM / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round((img.width || 1) * scale));
          const h = Math.max(1, Math.round((img.height || 1) * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          try { resolve(c.toDataURL('image/png')); } catch (e) { reject(new Error('decode')); }
        };
        img.src = /** @type {string} */ (reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function errorMessage(err) {
    const tooBig = err && err.message === 'size';
    return lang(
      tooBig ? 'pdf.maskEditor.referenceTooLarge' : 'pdf.maskEditor.referenceInvalid',
      tooBig
        ? 'That image is too large. Please choose one under 25 MB.'
        : 'Please choose a valid JPG, PNG, or WebP image.',
    );
  }

  // Single entry point for both the picker and a drop, so the two behave
  // identically down to the error copy.
  function accept(file) {
    if (!file) return;
    // Convert HEIC/HEIF to JPEG first so it decodes and passes validation.
    const prep = (window.StagifyHeic && window.StagifyHeic.isHeic(file))
      ? window.StagifyHeic.toDisplayableFile(file)
      : Promise.resolve(file);
    return prep
      .then(prepareReferenceFile)
      .then(set)
      .catch((err) => { clear(); showError(errorMessage(err)); });
  }

  // Highlight the add button while a file-drag hovers any zone, and accept a drop
  // on it. `dragDepth` counts enter/leave across nested children so moving over an
  // inner element doesn't flicker the highlight off.
  function wireDropZones(zones) {
    if (!zones.length) return;
    let dragDepth = 0;
    const hasFiles = (e) =>
      !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    const unhighlight = () => { if (els.addBtn) els.addBtn.classList.remove('is-drag-over'); };
    zones.forEach((zone) => {
      zone.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        if (els.addBtn) els.addBtn.classList.add('is-drag-over');
      });
      zone.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      });
      zone.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) unhighlight();
      });
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        unhighlight();
        accept(e.dataTransfer.files && e.dataTransfer.files[0]);
      });
    });
  }

  /**
   * Bind the slice to a page's elements. `preview`/`img` are optional only so a
   * caller with a reduced DOM still works; both editors pass all five.
   * @param {{ fileInput?: any, addBtn?: any, removeBtn?: any, preview?: any, img?: any, dropZones?: any[] }} nodes
   */
  function wire(nodes) {
    els = {
      fileInput: nodes.fileInput || null,
      addBtn: nodes.addBtn || null,
      removeBtn: nodes.removeBtn || null,
      preview: nodes.preview || null,
      img: nodes.img || null,
    };
    if (els.addBtn && els.fileInput) {
      els.addBtn.addEventListener('click', () => els.fileInput.click());
      els.fileInput.addEventListener('change', () => {
        const file = els.fileInput.files && els.fileInput.files[0];
        els.fileInput.value = ''; // allow re-selecting the same file later
        accept(file);
      });
    }
    if (els.removeBtn) els.removeBtn.addEventListener('click', clear);
    wireDropZones((nodes.dropZones || []).filter(Boolean));
  }

  return { clear, getDataUrl: () => referenceDataUrl, wire };
}
