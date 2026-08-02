// The owner's gallery page.
//
// One writer of the page state (loading | ready | empty | off | signed-out), so no
// combination of failures can leave two on screen. The detail panel is opened from a
// card and owns the share controls for whichever entry is open.

import { listGallery, mintShare, revokeShare, deleteRender } from './gallery/api.js';
import { renderGrid, renderCompare, renderMeta } from './gallery/view.js';

/**
 * Boot the page.
 * @param {{ doc?: Document, fetchImpl?: typeof fetch }} [deps] - Injectable for tests.
 * @returns {Promise<'ready' | 'empty' | 'off' | 'signed-out'>} The state it settled on.
 */
export async function start({ doc = document, fetchImpl = fetch } = {}) {
  /** @param {string} state */
  const setState = (state) => doc.body.setAttribute('data-state', state);
  const byId = (id) => doc.getElementById(id);

  const detail = byId('gal-detail');
  /** @type {any} */
  let current = null;

  /** @param {string} text */
  const shareStatus = (text) => {
    const node = byId('gal-share-status');
    if (node) node.textContent = text;
  };

  function closeDetail() {
    if (detail) /** @type {any} */ (detail).hidden = true;
    current = null;
  }

  /** @param {any} entry */
  function openDetail(entry) {
    current = entry;
    const title = byId('gal-detail-title');
    if (title) title.textContent = entry.roomType || 'Staged room';
    renderCompare({ container: byId('gal-compare'), entry, doc });
    renderMeta({ container: byId('gal-meta'), entry, doc });
    paintShare(entry, '');
    if (detail) /** @type {any} */ (detail).hidden = false;
  }

  /**
   * Reflect the share state.
   *
   * The URL input is only populated from a MINT — the server hands the token back once
   * and there is no read-back, so an entry that already has a live link shows that it is
   * on without being able to show the link itself. That is the honest UI for a
   * write-only credential; offering a "copy link" button that could not work would be
   * worse than saying "create a new one".
   * @param {any} entry @param {string} url
   */
  function paintShare(entry, url) {
    const input = /** @type {any} */ (byId('gal-share-url'));
    const create = /** @type {any} */ (byId('gal-share-create'));
    const revoke = /** @type {any} */ (byId('gal-share-revoke'));
    const active = !!entry?.share?.active;

    if (input) {
      input.value = url;
      input.hidden = !url;
    }
    if (create) create.textContent = active ? 'Create a new link' : 'Create link';
    if (revoke) revoke.hidden = !active;
    if (!url) {
      shareStatus(active
        ? `Link is on${entry.share.viewCount ? ` · opened ${entry.share.viewCount} time${entry.share.viewCount === 1 ? '' : 's'}` : ' · not opened yet'}`
        : 'No link yet.');
    }
  }

  async function load() {
    const res = await listGallery({}, fetchImpl);
    if (res.status === 401) { setState('signed-out'); return 'signed-out'; }
    if (!res.ok || !res.body) { setState('empty'); return 'empty'; }
    if (res.body.enabled === false) { setState('off'); return 'off'; }
    if (!res.body.entries.length) { setState('empty'); return 'empty'; }

    const count = byId('gal-count');
    if (count) {
      count.textContent = `${res.body.total} staged room${res.body.total === 1 ? '' : 's'}`;
    }
    renderGrid({ grid: byId('gal-grid'), entries: res.body.entries, doc, onOpen: openDetail });
    setState('ready');
    return 'ready';
  }

  byId('gal-detail-close')?.addEventListener('click', closeDetail);
  detail?.addEventListener('click', (event) => {
    // Backdrop only — clicking inside the panel must not dismiss it.
    if (event.target === detail) closeDetail();
  });
  doc.addEventListener('keydown', (event) => {
    if (/** @type {any} */ (event).key === 'Escape' && detail && !(/** @type {any} */ (detail).hidden)) closeDetail();
  });

  byId('gal-share-create')?.addEventListener('click', async () => {
    if (!current) return;
    shareStatus('Creating…');
    const res = await mintShare(current.id, {}, fetchImpl);
    if (!res.ok || !res.body?.url) { shareStatus('Could not create a link. Try again.'); return; }
    current.share = res.body.share;
    // Shown once, right here. Refreshing the page will not bring it back.
    paintShare(current, res.body.url);
    shareStatus('Link created. Copy it now — it is only shown once.');
  });

  byId('gal-share-revoke')?.addEventListener('click', async () => {
    if (!current) return;
    const res = await revokeShare(current.id, fetchImpl);
    if (!res.ok) { shareStatus('Could not turn the link off. Try again.'); return; }
    current.share = { active: false };
    paintShare(current, '');
    // Deliberately "within 15 minutes": image URLs are presigned, so one already handed
    // out keeps working until it expires. Saying "immediately" would be untrue.
    shareStatus('Link turned off. Visits stop within 15 minutes.');
  });

  byId('gal-delete')?.addEventListener('click', async () => {
    if (!current) return;
    const res = await deleteRender(current.id, fetchImpl);
    if (!res.ok) { shareStatus('Could not delete this render.'); return; }
    closeDetail();
    await load();
  });

  return load();
}

// Not started under test: the spec drives `start()` with its own document and fetch.
if (typeof window !== 'undefined' && !(/** @type {any} */ (window).__GALLERY_TEST__)) {
  void start();
}
