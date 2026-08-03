// The owner's gallery page.
//
// One writer of the page state (loading | ready | empty | off | error | signed-out), so no
// combination of failures can leave two on screen. The detail panel is opened from a
// card and owns the share controls for whichever entry is open.

import { listGallery, mintShare, revokeShare, deleteRender } from './gallery/api.js';
import { renderGrid, renderCompare, renderMeta } from './gallery/view.js';
import { t, plural } from './gallery/i18n.js';

/**
 * Boot the page.
 * @param {{ doc?: Document, fetchImpl?: typeof fetch }} [deps] - Injectable for tests.
 * @returns {Promise<'ready' | 'empty' | 'off' | 'error' | 'signed-out'>} The state it settled on.
 */
export async function start({ doc = document, fetchImpl = fetch } = {}) {
  /** @param {string} state */
  const setState = (state) => doc.body.setAttribute('data-state', state);
  const byId = (id) => doc.getElementById(id);

  const detail = byId('gal-detail');
  /** @type {any} */
  let current = null;
  /** The control that opened the panel, so focus can be handed back to it. */
  /** @type {any} */
  let opener = null;
  /** The compare slider for the open entry. It is the one control with no id. */
  /** @type {any} */
  let compareRange = null;

  // How much of the gallery is on screen. The route pages at 60 while the Pro cap is
  // 200, so `total` on its own is a number the grid cannot back up.
  /** @type {any[]} */
  let entries = [];
  let loaded = 0;
  let total = 0;
  /** The last failure's status, so a language switch can restate it. */
  let errorStatus = -1;

  /** @param {string} text */
  const shareStatus = (text) => {
    const node = byId('gal-share-status');
    if (node) node.textContent = text;
  };

  /**
   * The panel's focusable controls, in DOM order, skipping the hidden ones.
   *
   * Built by id rather than a query so it works against the document stand-in the specs
   * drive, which has getElementById and no querySelectorAll. The slider is the exception
   * — renderCompare hands it back for exactly this reason.
   */
  function panelControls() {
    return [
      byId('gal-detail-close'),
      compareRange,
      byId('gal-share-url'),
      byId('gal-share-create'),
      byId('gal-share-revoke'),
      byId('gal-delete'),
    ].filter((node) => node && !(/** @type {any} */ (node).hidden));
  }

  function closeDetail() {
    if (detail) /** @type {any} */ (detail).hidden = true;
    // An attribute, not a class: the CSS locks main's scroll off it, and it is the one
    // form both the browser and the test document agree on.
    doc.body.removeAttribute('data-gal-modal');
    current = null;
    compareRange = null;
    const back = opener;
    opener = null;
    // Focusing a detached node silently drops focus to <body>, which is worse than
    // leaving it where it is — a deleted render's card is gone by the time we get here.
    if (back && back.isConnected) back.focus();
  }

  /** @param {any} entry @param {any} [trigger] The card that opened it. */
  function openDetail(entry, trigger) {
    current = entry;
    opener = trigger ?? null;
    const title = byId('gal-detail-title');
    if (title) title.textContent = entry.roomType || t('gallery.detailTitle', 'Staged room');
    compareRange = renderCompare({ container: byId('gal-compare'), entry, doc });
    renderMeta({ container: byId('gal-meta'), entry, doc });
    paintShare(entry, '');
    if (detail) /** @type {any} */ (detail).hidden = false;
    doc.body.setAttribute('data-gal-modal', 'open');
    // role="dialog" only says WHAT the element is. Without this the dialog is never
    // announced and the next Tab walks the page behind the overlay.
    const first = byId('gal-detail-close');
    if (first) first.focus();
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
    if (create) {
      create.textContent = active
        ? t('gallery.share.createNew', 'Create a new link')
        : t('gallery.share.create', 'Create link');
    }
    if (revoke) revoke.hidden = !active;
    if (!url) {
      if (!active) shareStatus(t('gallery.share.none', 'No link yet.'));
      else if (!entry.share.viewCount) shareStatus(t('gallery.share.onNotOpened', 'Link is on · not opened yet'));
      else {
        shareStatus(plural('gallery.share.onOpened', entry.share.viewCount, {
          one: 'Link is on · opened {count} time',
          other: 'Link is on · opened {count} times',
        }));
      }
    }
  }

  /**
   * The count line.
   *
   * It names what is on screen as well as what exists whenever those differ, because
   * printing `total` alone above a 60-card grid is the page contradicting itself.
   */
  function paintCount() {
    const node = byId('gal-count');
    if (!node) return;
    node.textContent = loaded < total
      ? plural('gallery.showing', total, {
        one: 'Showing {loaded} of {count} staged room',
        other: 'Showing {loaded} of {count} staged rooms',
      }, { loaded })
      : plural('gallery.count', total, {
        one: '{count} staged room',
        other: '{count} staged rooms',
      });
  }

  /**
   * Explain a failure in terms of what it means for the agent's work, not the status code.
   * @param {number} status
   */
  function paintError(status) {
    errorStatus = status;
    const node = byId('gal-error-detail');
    if (!node) return;
    if (status === 0) {
      node.textContent = t('gallery.error.offline', 'We could not reach Stagify. Check your connection and try again.');
    } else if (status === 429) {
      node.textContent = t('gallery.error.rateLimited', 'Too many requests just now. Give it a moment and try again.');
    } else {
      node.textContent = t('gallery.error.generic', 'Your renders are safe — this is the list failing to load, not the images.');
    }
  }

  /** @param {{ append?: boolean }} [arg] */
  async function load({ append = false } = {}) {
    const res = await listGallery({ offset: append ? loaded : 0 }, fetchImpl);
    if (res.status === 401) { setState('signed-out'); return 'signed-out'; }
    // A failure is NOT an empty account. Every non-401 error used to land on "Nothing
    // staged yet", which tells someone looking for work they know they did that they
    // never did any.
    if (!res.ok || !res.body) { paintError(res.status); setState('error'); return 'error'; }
    if (res.body.enabled === false) { setState('off'); return 'off'; }

    const page = res.body.entries ?? [];
    if (!append && !page.length) { setState('empty'); return 'empty'; }

    errorStatus = -1;
    entries = append ? entries.concat(page) : page;
    total = Number(res.body.total) || page.length;
    loaded = append ? loaded + page.length : page.length;

    paintCount();
    renderGrid({ grid: byId('gal-grid'), entries: page, doc, onOpen: openDetail, append });
    const more = /** @type {any} */ (byId('gal-more'));
    // Guarding on the page size too: a page that comes back empty while `total` still
    // claims more would otherwise leave a button that can never finish.
    if (more) {
      more.hidden = loaded >= total || page.length === 0;
      // Labelled here rather than only in the click handler: it is the one JS-owned
      // string on the page that nothing else would ever repaint, so it sat in English
      // under a fully translated grid.
      more.textContent = t('gallery.more', 'Load more');
    }
    setState('ready');
    return 'ready';
  }

  byId('gal-detail-close')?.addEventListener('click', closeDetail);
  detail?.addEventListener('click', (event) => {
    // Backdrop only — clicking inside the panel must not dismiss it.
    if (event.target === detail) closeDetail();
  });
  doc.addEventListener('keydown', (event) => {
    const key = /** @type {any} */ (event).key;
    if (!detail || /** @type {any} */ (detail).hidden) return;
    if (key === 'Escape') { closeDetail(); return; }
    if (key !== 'Tab') return;
    // Keep Tab inside the panel. This cannot open the dialog's focus — openDetail does
    // that — it only stops the next press escaping to the page underneath.
    const list = panelControls();
    if (!list.length) return;
    const at = list.indexOf(doc.activeElement);
    const next = /** @type {any} */ (event).shiftKey
      ? list[at <= 0 ? list.length - 1 : at - 1]
      : list[at === -1 || at === list.length - 1 ? 0 : at + 1];
    /** @type {any} */ (event).preventDefault?.();
    if (next) /** @type {any} */ (next).focus();
  });

  // Returns the promise rather than discarding it, so a caller — the spec, today — can
  // wait for the retry instead of racing it.
  byId('gal-retry')?.addEventListener('click', () => load());

  byId('gal-more')?.addEventListener('click', async () => {
    const more = /** @type {any} */ (byId('gal-more'));
    if (more) { more.disabled = true; more.textContent = t('gallery.moreLoading', 'Loading…'); }
    await load({ append: true });
    if (more) { more.disabled = false; more.textContent = t('gallery.more', 'Load more'); }
  });

  byId('gal-share-create')?.addEventListener('click', async () => {
    if (!current) return;
    shareStatus(t('gallery.share.creating', 'Creating…'));
    const res = await mintShare(current.id, {}, fetchImpl);
    if (!res.ok || !res.body?.url) {
      shareStatus(t('gallery.share.createFailed', 'Could not create a link. Try again.'));
      return;
    }
    current.share = res.body.share;
    // Shown once, right here. Refreshing the page will not bring it back.
    paintShare(current, res.body.url);
    shareStatus(t('gallery.share.created', 'Link created. Copy it now — it is only shown once.'));
  });

  byId('gal-share-revoke')?.addEventListener('click', async () => {
    if (!current) return;
    const res = await revokeShare(current.id, fetchImpl);
    if (!res.ok) { shareStatus(t('gallery.share.revokeFailed', 'Could not turn the link off. Try again.')); return; }
    current.share = { active: false };
    paintShare(current, '');
    // Deliberately "within 15 minutes": image URLs are presigned, so one already handed
    // out keeps working until it expires. Saying "immediately" would be untrue — and
    // that constraint binds every translation of this key, not just the English.
    shareStatus(t('gallery.share.revoked', 'Link turned off. Visits stop within 15 minutes.'));
  });

  byId('gal-delete')?.addEventListener('click', async () => {
    if (!current) return;
    const res = await deleteRender(current.id, fetchImpl);
    if (!res.ok) { shareStatus(t('gallery.share.deleteFailed', 'Could not delete this render.')); return; }
    closeDetail();
    await load();
  });

  // Switching language on this page swaps the pack in place rather than navigating (see
  // the [data-lang-inplace] note in gallery.html), so the strings JS owns have to be
  // repainted by hand — applyLanguageToElements() only reaches [data-lang] markup.
  // Guarded because the specs run with a stand-in `window` that has no addEventListener.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('languagechange', () => {
      if (errorStatus >= 0) paintError(errorStatus);
      if (!entries.length) return;
      paintCount();
      const more = /** @type {any} */ (byId('gal-more'));
      if (more && !more.disabled) more.textContent = t('gallery.more', 'Load more');
      // Re-rendered rather than patched: the cards' alt and aria-label are built from
      // the pack too, and they are the half nobody would notice staying English.
      renderGrid({ grid: byId('gal-grid'), entries, doc, onOpen: openDetail });
      if (detail && !(/** @type {any} */ (detail).hidden) && current) openDetail(current, opener);
    });
  }

  return load();
}

// Not started under test: the spec drives `start()` with its own document and fetch.
if (typeof window !== 'undefined' && !(/** @type {any} */ (window).__GALLERY_TEST__)) {
  void start();
}
