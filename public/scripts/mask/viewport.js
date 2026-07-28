// Pins a mask-editor dialog to the mobile VISUAL viewport (the area not covered
// by the browser URL bar / on-screen keyboard) and cleans up on close.
//
// Shared by both mask editors. It previously existed twice: once here (as
// ai-designer/mask-viewport.js, resolving `#mask-editor-modal` by id) and once
// inline in app/stage-mask-editor.js against its own `#stage-mask-modal`. The
// logic was identical; only the element differed — so the element is now the
// parameter and the logic is written once.
//
//   createMaskViewport({ getModal }) -> { bind, unbind, sync }
//
// `getModal` is a thunk, not an element: the AI Designer builds its dialog lazily
// on first open, so there is nothing to hold a reference to at construction time.

/**
 * @param {{ getModal: () => HTMLElement | null }} deps - Resolves the dialog element.
 * @returns {{ bind: () => void, unbind: () => void, sync: () => void }}
 */
export function createMaskViewport({ getModal }) {
  // Without this, the fixed top:0 dialog sits behind the URL bar on iOS Safari
  // and its header/buttons get clipped. Desktop is left untouched.
  let syncHandler = null;

  function clearPin(modal) {
    if (!modal) return;
    modal.style.top = '';
    modal.style.left = '';
    modal.style.width = '';
    modal.style.height = '';
  }

  function sync() {
    const modal = getModal();
    if (!modal || !modal.classList.contains('active')) return;
    const vv = window.visualViewport;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    // Not just "skip" — a phone rotated into the wide layout has stale pinned
    // values that must be handed back to the stylesheet.
    if (!vv || !isMobile) { clearPin(modal); return; }
    modal.style.top = vv.offsetTop + 'px';
    modal.style.left = vv.offsetLeft + 'px';
    modal.style.width = vv.width + 'px';
    modal.style.height = vv.height + 'px';
  }

  function bind() {
    if (syncHandler || !window.visualViewport) return; // idempotent across reopens
    syncHandler = () => sync();
    window.visualViewport.addEventListener('resize', syncHandler);
    window.visualViewport.addEventListener('scroll', syncHandler);
  }

  function unbind() {
    if (syncHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncHandler);
      window.visualViewport.removeEventListener('scroll', syncHandler);
    }
    syncHandler = null;
    clearPin(getModal());
  }

  return { bind, unbind, sync };
}
