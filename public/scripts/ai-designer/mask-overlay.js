// The mask-editor processing overlay: injects the .smask-* CSS once (also the
// .smask-help refine '?' icon styles) and shows a spinner + rotating status
// messages while the AI runs. Extracted verbatim from mask-editor.js.
//
//   createMaskOverlay({ lang }) -> { start, stop, ensure }
export function createMaskOverlay({ lang }) {
  let maskLoadMsgTimer = null;
  let maskLoadingOverlay = null;
  const MASK_LOAD_MESSAGES = [
    'Applying your edit…',
    'Reworking the masked area…',
    'Blending in the new details…',
    'Refining textures and lighting…',
    'Adding finishing touches…',
  ];

  function maskEnsureOverlay() {
    const container = document.querySelector('.mask-editor-canvas-container');
    if (maskLoadingOverlay || !container) return;
    if (!document.getElementById('smask-refine-styles')) {
      const st = document.createElement('style');
      st.id = 'smask-refine-styles';
      st.textContent = '.smask-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(255,255,255,.4);z-index:6;border-radius:inherit;}.smask-overlay__spin{width:46px;height:46px;border-radius:50%;border:4px solid rgba(37,99,235,.25);border-top-color:#2563eb;animation:smask-spin .9s linear infinite;}.smask-overlay__msg{font-weight:600;color:#1f2937;font-size:14px;text-align:center;max-width:80%;padding:0 12px;}.smask-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid #94a3b8;color:#64748b;font-size:11px;font-weight:700;cursor:help;margin-left:6px;margin-right:auto;line-height:1;user-select:none;flex:0 0 auto;}.smask-help.hidden{display:none;}.smask-help__tip{position:absolute;top:140%;left:0;width:min(290px,72vw);background:#1f2937;color:#fff;font-size:12px;font-weight:400;line-height:1.45;padding:10px 12px;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);opacity:0;visibility:hidden;transition:opacity .15s ease;z-index:30;text-align:left;pointer-events:none;white-space:normal;}.smask-help:hover .smask-help__tip,.smask-help:focus .smask-help__tip,.smask-help:focus-within .smask-help__tip{opacity:1;visibility:visible;}@keyframes smask-spin{to{transform:rotate(360deg);}}';
      document.head.appendChild(st);
    }
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    maskLoadingOverlay = document.createElement('div');
    maskLoadingOverlay.className = 'smask-overlay hidden';
    const spin = document.createElement('div'); spin.className = 'smask-overlay__spin';
    const msg = document.createElement('div'); msg.className = 'smask-overlay__msg';
    maskLoadingOverlay.appendChild(spin); maskLoadingOverlay.appendChild(msg);
    container.appendChild(maskLoadingOverlay);
  }

  function maskStartOverlay() {
    maskEnsureOverlay();
    const container = document.querySelector('.mask-editor-canvas-container');
    if (container) container.classList.add('processing');
    if (!maskLoadingOverlay) return;
    maskLoadingOverlay.classList.remove('hidden');
    const msgEl = maskLoadingOverlay.querySelector('.smask-overlay__msg');
    let i = 0;
    if (msgEl) msgEl.textContent = lang('pdf.maskEditor.loadApplying', MASK_LOAD_MESSAGES[0]);
    if (maskLoadMsgTimer) clearInterval(maskLoadMsgTimer);
    maskLoadMsgTimer = setInterval(() => { i = (i + 1) % MASK_LOAD_MESSAGES.length; if (msgEl) msgEl.textContent = MASK_LOAD_MESSAGES[i]; }, 2000);
  }

  function maskStopOverlay() {
    if (maskLoadMsgTimer) { clearInterval(maskLoadMsgTimer); maskLoadMsgTimer = null; }
    const container = document.querySelector('.mask-editor-canvas-container');
    if (container) container.classList.remove('processing');
    if (maskLoadingOverlay) maskLoadingOverlay.classList.add('hidden');
  }

  return { start: maskStartOverlay, stop: maskStopOverlay, ensure: maskEnsureOverlay };
}
