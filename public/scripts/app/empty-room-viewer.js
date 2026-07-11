import { roomDownloadSlug } from './helpers.js';

/**
 * The empty-room viewer modal (intermediate result of two-stage furniture
 * removal). Wires its own open/close/download listeners. Extracted from app.js;
 * DOM refs and the current empty-room URL (as a getter) are injected.
 *
 * @param {any} deps
 */
export function createEmptyRoomViewer(deps) {
  const {
    emptyRoomModal, emptyRoomImage, emptyRoomClose, emptyRoomDownload, emptyRoomBtn,
    roomSelect, getLastEmptyRoomUrl,
  } = deps;

  function openEmptyRoomModal() {
    if (!emptyRoomModal || !getLastEmptyRoomUrl()) return;
    if (emptyRoomImage) emptyRoomImage.src = getLastEmptyRoomUrl();
    emptyRoomModal.classList.add('active');
    emptyRoomModal.setAttribute('aria-hidden', 'false');
  }
  function closeEmptyRoomModal() {
    if (!emptyRoomModal) return;
    emptyRoomModal.classList.remove('active');
    emptyRoomModal.setAttribute('aria-hidden', 'true');
  }
  if (emptyRoomBtn) emptyRoomBtn.addEventListener('click', openEmptyRoomModal);
  if (emptyRoomClose) emptyRoomClose.addEventListener('click', closeEmptyRoomModal);
  if (emptyRoomModal) emptyRoomModal.addEventListener('click', (e) => {
    if (e.target === emptyRoomModal) closeEmptyRoomModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && emptyRoomModal && emptyRoomModal.classList.contains('active')) {
      closeEmptyRoomModal();
    }
  });
  if (emptyRoomDownload) emptyRoomDownload.addEventListener('click', () => {
    if (!getLastEmptyRoomUrl()) return;
    const link = document.createElement('a');
    const roomSlug = roomDownloadSlug(roomSelect?.value);
    link.download = `stagify-${roomSlug}-empty-${Date.now()}.jpg`;
    link.href = getLastEmptyRoomUrl();
    link.click();
  });
}
