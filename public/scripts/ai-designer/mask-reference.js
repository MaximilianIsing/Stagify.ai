// Optional reference-photo slice of the mask editor: HEIC-aware validate +
// downscale-to-1536 + PNG-encode, preview show/hide, and the file-input/add/
// remove wiring. Extracted verbatim from mask-editor.js. Owns the reference
// data URL; the entry reads it via getDataUrl() when building the request.
//
//   createMaskReference({ lang, showToast }) -> { clear, getDataUrl, wire }
export function createMaskReference({ lang, showToast }) {
  let maskReferenceDataUrl = null;

  function clearMaskReference() {
    maskReferenceDataUrl = null;
    const refFileInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-ref-file'));
    const refPreview = document.getElementById('mask-editor-ref-preview');
    const refImg = document.getElementById('mask-editor-ref-img');
    const refAddBtn = document.getElementById('mask-editor-ref-add');
    if (refFileInput) refFileInput.value = '';
    if (refPreview) refPreview.classList.add('hidden');
    if (refImg) refImg.removeAttribute('src');
    if (refAddBtn) refAddBtn.classList.remove('hidden');
  }

  function setMaskReference(dataUrl) {
    maskReferenceDataUrl = dataUrl;
    const refPreview = document.getElementById('mask-editor-ref-preview');
    const refImg = /** @type {HTMLImageElement} */ (document.getElementById('mask-editor-ref-img'));
    const refAddBtn = document.getElementById('mask-editor-ref-add');
    if (refImg) refImg.src = dataUrl;
    if (refPreview) refPreview.classList.remove('hidden');
    if (refAddBtn) refAddBtn.classList.add('hidden');
  }

  // Validate, downscale (max 1536px), and PNG-encode a chosen reference file so
  // the payload is always small, clean, and a format the backend accepts.
  // Resolves to a data URL; rejects with 'type' | 'size' | 'read' | 'decode'.
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
        img.src = /** @type {string} */ (reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  // Attach the reference file-input / add / remove listeners.
  function wire(refFileInput, refAddBtn, refRemoveBtn) {
    if (refAddBtn && refFileInput) {
      refAddBtn.addEventListener('click', () => refFileInput.click());
      refFileInput.addEventListener('change', () => {
        const file = refFileInput.files && refFileInput.files[0];
        refFileInput.value = ''; // allow re-selecting the same file later
        if (!file) return;
        // Convert HEIC/HEIF to JPEG first so it decodes and passes validation.
        const prep = (window.StagifyHeic && window.StagifyHeic.isHeic(file))
          ? window.StagifyHeic.toDisplayableFile(file)
          : Promise.resolve(file);
        prep
          .then(prepareReferenceFile)
          .then(setMaskReference)
          .catch((err) => {
            clearMaskReference();
            const key = err && err.message === 'size' ? 'pdf.maskEditor.referenceTooLarge' : 'pdf.maskEditor.referenceInvalid';
            const fallback = err && err.message === 'size'
              ? 'That image is too large — please choose one under 25 MB.'
              : 'Please choose a valid JPG, PNG, or WebP image.';
            showToast(lang(key, fallback), 'error');
          });
      });
    }
    if (refRemoveBtn) refRemoveBtn.addEventListener('click', clearMaskReference);
  }

  return { clear: clearMaskReference, getDataUrl: () => maskReferenceDataUrl, wire };
}
