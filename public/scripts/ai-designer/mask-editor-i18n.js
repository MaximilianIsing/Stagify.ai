// Localizes the mask-editor modal chrome (title, tool/brush/prompt labels,
// placeholder, hint, buttons, reference controls). Extracted verbatim from
// mask-editor.js. Reads window.LanguageSystem + the document directly (no deps),
// so it can be imported and called from the entry unchanged.

// Function to update mask editor translations
export function updateMaskEditorTranslations() {
  if (!window.LanguageSystem || !window.LanguageSystem.isLoaded()) {
    return;
  }

  const getText = (key) => {
    return window.LanguageSystem.getText(key) || key;
  };

  // Update title
  const title = document.querySelector('.mask-editor-title');
  if (title) {
    title.textContent = getText('pdf.maskEditor.title');
  }

  // Update brush size label
  const brushLabel = document.querySelector('.mask-editor-brush-label');
  if (brushLabel) {
    brushLabel.textContent = getText('pdf.maskEditor.brushSize');
  }

  // Update tool toggle labels
  const brushToolText = document.querySelector('#mask-editor-brush-btn span');
  if (brushToolText) {
    brushToolText.textContent = getText('pdf.maskEditor.brush');
  }
  const eraseToolText = document.querySelector('#mask-editor-erase-btn span');
  if (eraseToolText) {
    eraseToolText.textContent = getText('pdf.maskEditor.erase');
  }

  // Update prompt label
  const promptLabel = document.querySelector('.mask-editor-prompt-label');
  if (promptLabel) {
    promptLabel.textContent = getText('pdf.maskEditor.promptLabel');
  }

  // Update prompt placeholder
  const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
  if (promptInput) {
    promptInput.placeholder = getText('pdf.maskEditor.promptPlaceholder');
  }

  // Placement hint under the prompt (guard against the raw key if missing)
  const promptHint = document.querySelector('.mask-editor-prompt-hint');
  if (promptHint) {
    const hintText = getText('pdf.maskEditor.promptHint');
    promptHint.textContent = (hintText && hintText !== 'pdf.maskEditor.promptHint')
      ? hintText
      : 'Be very specific about location and placement — for example: “put the sofa flush against the middle of the back wall.”';
  }

  // Update buttons
  const cancelBtn = document.getElementById('mask-editor-cancel');
  if (cancelBtn) {
    cancelBtn.textContent = getText('pdf.maskEditor.cancel');
  }

  const clearBtn = document.getElementById('mask-editor-clear');
  if (clearBtn) {
    const clearText = clearBtn.querySelector('span');
    if (clearText) clearText.textContent = getText('pdf.maskEditor.clearMask');
  }

  const submitBtn = document.getElementById('mask-editor-submit');
  if (submitBtn) {
    const submitText = submitBtn.querySelector('span');
    if (submitText) {
      submitText.textContent = getText('pdf.maskEditor.applyEdit');
    }
  }

  const refLabel = document.querySelector('.mask-editor-ref-label');
  if (refLabel) refLabel.textContent = getText('pdf.maskEditor.referenceLabel');
  const refAdd = document.getElementById('mask-editor-ref-add');
  if (refAdd) refAdd.textContent = getText('pdf.maskEditor.referenceAdd');
  const refHint = document.querySelector('.mask-editor-ref-hint');
  if (refHint) refHint.textContent = getText('pdf.maskEditor.referenceHint');
  const refImg = /** @type {HTMLImageElement} */ (document.getElementById('mask-editor-ref-img'));
  if (refImg) refImg.alt = getText('pdf.maskEditor.referenceAlt');
  const refRemove = document.getElementById('mask-editor-ref-remove');
  if (refRemove) refRemove.setAttribute('aria-label', getText('pdf.maskEditor.referenceRemove'));
}
