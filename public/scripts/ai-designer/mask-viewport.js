// Pins the mask-editor modal to the mobile VISUAL viewport (the area not covered
// by the browser URL bar / on-screen keyboard) and cleans up on close. Extracted
// verbatim from mask-editor.js. No deps — uses window.visualViewport /
// window.matchMedia / document directly.
//
//   createMaskViewport() -> { bind, unbind, sync }

export function createMaskViewport() {
  // Keep the mask editor pinned to the VISUAL viewport (the area not covered
  // by the mobile browser's URL bar / toolbar, and above the on-screen
  // keyboard). Without this, the fixed top:0 modal sits behind the URL bar on
  // iOS Safari and its header/buttons get clipped. Desktop is left untouched.
  let maskViewportSyncHandler = null;

  function syncMaskEditorToViewport() {
    const modal = document.getElementById('mask-editor-modal');
    if (!modal || !modal.classList.contains('active')) return;
    const vv = window.visualViewport;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!vv || !isMobile) {
      modal.style.top = '';
      modal.style.left = '';
      modal.style.width = '';
      modal.style.height = '';
      return;
    }
    modal.style.top = vv.offsetTop + 'px';
    modal.style.left = vv.offsetLeft + 'px';
    modal.style.width = vv.width + 'px';
    modal.style.height = vv.height + 'px';
  }

  function bindMaskViewportSync() {
    if (maskViewportSyncHandler || !window.visualViewport) return;
    maskViewportSyncHandler = () => syncMaskEditorToViewport();
    window.visualViewport.addEventListener('resize', maskViewportSyncHandler);
    window.visualViewport.addEventListener('scroll', maskViewportSyncHandler);
  }

  function unbindMaskViewportSync() {
    if (maskViewportSyncHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', maskViewportSyncHandler);
      window.visualViewport.removeEventListener('scroll', maskViewportSyncHandler);
    }
    maskViewportSyncHandler = null;
    const modal = document.getElementById('mask-editor-modal');
    if (modal) {
      modal.style.top = '';
      modal.style.left = '';
      modal.style.width = '';
      modal.style.height = '';
    }
  }

  return { bind: bindMaskViewportSync, unbind: unbindMaskViewportSync, sync: syncMaskEditorToViewport };
}
