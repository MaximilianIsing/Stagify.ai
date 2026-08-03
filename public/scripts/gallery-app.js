// The owner's gallery page.
//
// One writer of the page state (loading | ready | empty | no-results | off | error |
// signed-out), so no combination of failures can leave two on screen. The detail panel is
// opened from a card and shows the share link for whichever entry is open — every entry
// has one, so the panel paints it rather than negotiating for it.
//
// SEARCH IS A STAGIFY+ FEATURE AND THE SERVER SAYS SO. The box is revealed from
// `search.enabled` in the listing, never from a plan read off window.StagifyAuth: the same
// response decides whether `q` is honoured, so the two cannot disagree. That also means the
// filtering is SQL, not a filter over the loaded page — the route pages at 60 while the Pro
// cap is 200, so a client-side search would quietly only look at the first screenful.

import { listGallery, deleteRender, renameRender } from './gallery/api.js';
import { renderGrid, renderCompare, renderMeta, entryName, defaultName } from './gallery/view.js';
import { t, plural } from './gallery/i18n.js';
import { copyText } from './clipboard.js';

/**
 * How long to wait after the last keystroke before searching.
 *
 * Sized against the limiter, not against feel: `galleryLimiter` allows 120 requests per 15
 * minutes per IP, so a request per keystroke would exhaust an agent's whole window inside
 * one query and answer 429 to their next page load. A pause this long collapses a typed
 * word into one request, and `runSearch` drops a query identical to the one already on
 * screen so backspacing to where you were costs nothing.
 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Boot the page.
 * @param {{ doc?: Document, fetchImpl?: typeof fetch, searchDelayMs?: number }} [deps] -
 *   Injectable for tests. `searchDelayMs` is the debounce; the specs drive it to 0 so a
 *   spec can await a search rather than sleep through one.
 * @returns {Promise<'ready' | 'empty' | 'no-results' | 'off' | 'error' | 'signed-out' | 'stale'>}
 *   The state it settled on.
 */
export async function start({ doc = document, fetchImpl = fetch, searchDelayMs = SEARCH_DEBOUNCE_MS } = {}) {
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
  /** The query the grid on screen was built from — '' when nothing is being searched. */
  let query = '';
  /** The pending debounce, so a second keystroke replaces the first rather than queueing. */
  /** @type {any} */
  let searchTimer = null;
  /**
   * Which search the newest request belongs to.
   *
   * Two searches can be in flight when a slow request for "bed" is overtaken by a fast one
   * for "bedroom"; without this the slow response lands last and paints results for a query
   * the box no longer holds. Compared on arrival, and a stale response is dropped.
   */
  let searchSeq = 0;

  /** @param {string} text */
  const shareStatus = (text) => {
    const node = byId('gal-share-status');
    if (node) node.textContent = text;
  };

  /** @param {string} text */
  const renameStatus = (text) => {
    const node = byId('gal-rename-status');
    if (node) node.textContent = text;
  };

  /**
   * The panel's focusable controls, in DOM order, skipping the hidden ones.
   *
   * Built by id rather than a query so it works against the document stand-in the specs
   * drive, which has getElementById and no querySelectorAll. The slider is the exception
   * — renderCompare hands it back for exactly this reason.
   *
   * The rename controls sit between the heading and the comparison in exactly one of two
   * modes, and which one is decided HERE rather than by the filter below. `hidden` on the
   * row does not set `.hidden` on the controls inside it, so filtering per node would keep
   * the input and its two buttons in the cycle while the row was closed — and this trap
   * calls focus() explicitly after preventDefault(), so Tab would land on something that
   * is not on screen instead of the browser simply skipping it.
   */
  function panelControls() {
    const renaming = !(/** @type {any} */ (byId('gal-rename-row'))?.hidden ?? true);
    return [
      byId('gal-detail-close'),
      renaming ? byId('gal-rename-input') : byId('gal-rename'),
      renaming ? byId('gal-rename-save') : null,
      renaming ? byId('gal-rename-cancel') : null,
      compareRange,
      byId('gal-share-url'),
      byId('gal-share-copy'),
      byId('gal-delete'),
    ].filter((node) => node && !(/** @type {any} */ (node).hidden));
  }

  /**
   * Put the rename control back to "not editing".
   *
   * Called on open and on cancel as well as after a save, so no combination of leaving a
   * panel mid-edit and opening another can show one render's name over another's photo.
   * @param {{ status?: string }} [arg] - Wording to leave behind; cleared by default.
   */
  function closeRename({ status = '' } = {}) {
    const row = /** @type {any} */ (byId('gal-rename-row'));
    const trigger = /** @type {any} */ (byId('gal-rename'));
    if (row) row.hidden = true;
    if (trigger) {
      trigger.hidden = false;
      trigger.setAttribute('aria-expanded', 'false');
    }
    renameStatus(status);
  }

  /**
   * Start editing the open render's name.
   *
   * The box is seeded with the owner's OWN name only — never the derived default — and
   * the default goes in as the placeholder instead. Prefilling "Modern Bedroom" would
   * make saving unchanged text convert a derived label into a stored one, and the render
   * would then keep that name after the default changed. An empty box that shows what it
   * will fall back to says "type something or leave it" without lying about state.
   */
  function openRename() {
    if (!current) return;
    const row = /** @type {any} */ (byId('gal-rename-row'));
    const trigger = /** @type {any} */ (byId('gal-rename'));
    const input = /** @type {any} */ (byId('gal-rename-input'));
    if (row) row.hidden = false;
    if (trigger) {
      trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'true');
    }
    if (input) {
      input.value = String(current.name ?? '');
      input.setAttribute('placeholder', defaultName(current));
      input.focus();
      if (typeof input.select === 'function') input.select();
    }
    renameStatus('');
  }

  /**
   * Send the typed name and repaint everything that shows it.
   *
   * The name that lands on the entry is the SERVER's, not the box's: the store trims and
   * clamps, so painting what was typed would show a name the next page load contradicts.
   */
  async function saveRename() {
    if (!current) return;
    const input = /** @type {any} */ (byId('gal-rename-input'));
    const typed = String(input?.value ?? '');
    renameStatus(t('gallery.rename.saving', 'Saving…'));
    const res = await renameRender(current.id, typed, fetchImpl);
    if (!res.ok) {
      renameStatus(t('gallery.rename.failed', 'Could not save that name. Try again.'));
      return;
    }
    current.name = String(res.body?.name ?? '');
    const title = byId('gal-detail-title');
    if (title) title.textContent = entryName(current);
    // The card behind the panel carries the name too, so it has to be rebuilt — its alt
    // text and aria-label are built from the same string.
    repaintGrid();
    closeRename({
      status: current.name
        ? t('gallery.rename.saved', 'Name saved.')
        : t('gallery.rename.cleared', 'Back to the default name.'),
    });
    const trigger = byId('gal-rename');
    if (trigger) trigger.focus();
  }

  /**
   * Rebuild the grid and keep the focus-restore target valid.
   *
   * A re-render replaces every card node, so the one held in `opener` is detached the
   * moment this runs — and closeDetail's isConnected guard would then drop focus to
   * <body>. Re-pointing at the new card for the same entry is what keeps closing the
   * panel returning focus to the tile it was opened from.
   */
  function repaintGrid() {
    const cards = renderGrid({ grid: byId('gal-grid'), entries, doc, onOpen: openDetail });
    if (!current) return;
    const at = entries.findIndex((entry) => entry.id === current.id);
    if (at >= 0 && cards[at]) opener = cards[at];
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
    if (title) title.textContent = entryName(entry);
    closeRename();
    compareRange = renderCompare({ container: byId('gal-compare'), entry, doc });
    renderMeta({ container: byId('gal-meta'), entry, doc });
    paintShare(entry);
    if (detail) /** @type {any} */ (detail).hidden = false;
    doc.body.setAttribute('data-gal-modal', 'open');
    // role="dialog" only says WHAT the element is. Without this the dialog is never
    // announced and the next Tab walks the page behind the overlay.
    const first = byId('gal-detail-close');
    if (first) first.focus();
  }

  /**
   * Show the entry's link.
   *
   * There is no state to reflect beyond the URL and whether anyone has opened it: every
   * render has a link, the listing carries it, and the only control is copy. Nothing here
   * creates or withdraws one, which is why this takes an entry and no second argument.
   * @param {any} entry
   */
  function paintShare(entry) {
    const input = /** @type {any} */ (byId('gal-share-url'));
    const copy = /** @type {any} */ (byId('gal-share-copy'));
    const link = entry?.share?.url || '';

    if (input) {
      input.value = link;
      input.hidden = !link;
    }
    if (copy) {
      copy.hidden = !link;
      copy.textContent = t('gallery.share.copy', 'Copy link');
    }

    if (!link) {
      // Not a state the owner can be in on purpose any more — the listing mints one for
      // every finished render — so it is reported as the failure it is rather than as
      // "no link yet", which would invite a wait that never ends.
      shareStatus(t('gallery.share.unavailable', 'This link could not be loaded. Reload the page and try again.'));
    } else if (!entry.share?.viewCount) {
      shareStatus(t('gallery.share.notOpened', 'Not opened yet'));
    } else {
      shareStatus(plural('gallery.share.opened', entry.share.viewCount, {
        one: 'Opened {count} time',
        other: 'Opened {count} times',
      }));
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
    // While a search is on, both numbers are about the MATCHES — the route counts the
    // filtered set — so saying "staged rooms" here would read as the size of the gallery.
    if (query) {
      node.textContent = loaded < total
        ? plural('gallery.search.showing', total, {
          one: 'Showing {loaded} of {count} match',
          other: 'Showing {loaded} of {count} matches',
        }, { loaded })
        : plural('gallery.search.results', total, {
          one: '{count} match',
          other: '{count} matches',
        });
      return;
    }
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

  /** Name the query in the no-matches panel, so it is obvious what was searched for. */
  function paintNoResults() {
    const node = byId('gal-no-results-detail');
    if (node) {
      node.textContent = t('gallery.search.none.body', 'Nothing in your gallery matches “{q}”.', { q: query });
    }
  }

  /**
   * Show the × exactly when there is text to clear.
   *
   * Driven by the BOX, never by `query`: text that has been typed but not yet searched for
   * is still text the visitor wants a way to remove, and clearing it has to hide the button
   * even when no request was ever made. Reading `query` here left the × on screen after the
   * box was emptied, because the search that would have repainted it was skipped as a no-op.
   */
  function paintClearButton() {
    const input = /** @type {any} */ (byId('gal-search-input'));
    const clear = /** @type {any} */ (byId('gal-search-clear'));
    if (clear) clear.hidden = !input?.value;
  }

  /**
   * Reflect the applied query in the box.
   *
   * The input's own value is only written when it DIFFERS — assigning to `value` moves the
   * caret to the end in every browser, so repainting on each keystroke would reverse typing
   * in the middle of a word.
   */
  function paintSearch() {
    const input = /** @type {any} */ (byId('gal-search-input'));
    if (input && input.value !== query) input.value = query;
    paintClearButton();
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

  /** @param {{ append?: boolean, seq?: number }} [arg] */
  async function load({ append = false, seq = searchSeq } = {}) {
    const res = await listGallery({ offset: append ? loaded : 0, q: query }, fetchImpl);
    // A response for a query the box no longer holds must not paint. Checked before ANY
    // state is written, so an overtaken request cannot even flip the page to 'error'.
    if (seq !== searchSeq) return 'stale';
    if (res.status === 401) { setState('signed-out'); return 'signed-out'; }
    // A failure is NOT an empty account. Every non-401 error used to land on "Nothing
    // staged yet", which tells someone looking for work they know they did that they
    // never did any.
    if (!res.ok || !res.body) { paintError(res.status); setState('error'); return 'error'; }
    if (res.body.enabled === false) { setState('off'); return 'off'; }

    // The server decides whether searching is offered — it is the same answer that decides
    // whether `q` is honoured, so the box cannot be shown for a filter that will be ignored.
    doc.body.setAttribute('data-gal-search', res.body.search?.enabled ? 'on' : 'off');
    if (!res.body.search?.enabled && query) {
      // A free account that somehow carried a query: the server returned the whole gallery,
      // so the page must stop claiming it is showing matches.
      query = '';
      paintSearch();
    }

    const page = res.body.entries ?? [];
    // "Nothing matched" is not "nothing staged". Landing a search on the empty state tells
    // an agent with two hundred rooms that they have none — and hides the box that would
    // let them clear it.
    if (!append && !page.length) {
      errorStatus = -1;
      entries = [];
      loaded = 0;
      total = 0;
      if (query) { paintNoResults(); setState('no-results'); return 'no-results'; }
      setState('empty');
      return 'empty';
    }

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
    if (key === 'Escape') {
      // Escape backs out of the innermost thing first. Closing the whole panel from an
      // open rename box would throw away what was typed AND the render they were looking
      // at, when all they asked for was to stop renaming.
      const renaming = !(/** @type {any} */ (byId('gal-rename-row'))?.hidden ?? true);
      if (renaming) {
        closeRename();
        const trigger = byId('gal-rename');
        if (trigger) trigger.focus();
        return;
      }
      closeDetail();
      return;
    }
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

  /**
   * Run a search, from the first page.
   *
   * `searchSeq` is bumped BEFORE the request so any response already in flight is stale on
   * arrival — the fix for a slow "bed" landing after a fast "bedroom" and painting results
   * for a query the box no longer holds.
   *
   * @param {string} next - The raw query. Trimmed here, so trailing spaces from typing do
   *   not count as a different search.
   * @returns {Promise<string>}
   */
  function runSearch(next) {
    const wanted = String(next ?? '').trim();
    // Backspacing to a query already on screen must not cost a request — which matters
    // against a limiter of 120 per 15 minutes.
    if (wanted === query) return Promise.resolve('unchanged');
    query = wanted;
    searchSeq += 1;
    paintSearch();
    return load({ seq: searchSeq });
  }

  /** Cancel any pending debounce — a submit or a clear must not be re-run by it after. */
  function cancelPendingSearch() {
    if (searchTimer === null) return;
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  byId('gal-search-input')?.addEventListener('input', () => {
    const input = /** @type {any} */ (byId('gal-search-input'));
    // Repainted immediately rather than waiting out the debounce.
    paintClearButton();
    cancelPendingSearch();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(input?.value ?? '');
    }, searchDelayMs);
  });

  // Enter searches now instead of waiting out the debounce. The <form> would otherwise
  // reload the page, which on this URL means losing the session-scoped state entirely.
  byId('gal-search')?.addEventListener('submit', (event) => {
    /** @type {any} */ (event).preventDefault?.();
    cancelPendingSearch();
    return runSearch(/** @type {any} */ (byId('gal-search-input'))?.value ?? '');
  });

  // Two ways back to the whole gallery: the × in the box, and the button on the panel that
  // says nothing matched. Both go through the same call, so they cannot diverge.
  for (const id of ['gal-search-clear', 'gal-search-reset']) {
    byId(id)?.addEventListener('click', () => {
      cancelPendingSearch();
      const input = /** @type {any} */ (byId('gal-search-input'));
      if (input) input.value = '';
      // Before runSearch, which skips a query identical to the one already applied — so
      // emptying a box that was typed into but never searched must not depend on it.
      paintClearButton();
      const done = runSearch('');
      // Focus follows the clear back to the box, so the next query can just be typed —
      // and because the reset button is about to be hidden with its own state.
      if (input && typeof input.focus === 'function') input.focus();
      return done;
    });
  }

  byId('gal-more')?.addEventListener('click', async () => {
    const more = /** @type {any} */ (byId('gal-more'));
    if (more) { more.disabled = true; more.textContent = t('gallery.moreLoading', 'Loading…'); }
    await load({ append: true });
    if (more) { more.disabled = false; more.textContent = t('gallery.more', 'Load more'); }
  });

  byId('gal-rename')?.addEventListener('click', openRename);
  byId('gal-rename-cancel')?.addEventListener('click', () => {
    closeRename();
    const trigger = byId('gal-rename');
    if (trigger) trigger.focus();
  });
  // Returns the promise so a caller can await the save rather than race it, exactly as
  // the retry button does.
  byId('gal-rename-save')?.addEventListener('click', () => saveRename());
  byId('gal-rename-input')?.addEventListener('keydown', (event) => {
    // Enter commits. The row is not a <form> — it sits inside no form on this page — so
    // without this the key does nothing and the box looks broken.
    if (/** @type {any} */ (event).key !== 'Enter') return;
    /** @type {any} */ (event).preventDefault?.();
    return saveRename();
  });

  byId('gal-share-copy')?.addEventListener('click', async () => {
    const input = /** @type {any} */ (byId('gal-share-url'));
    const value = input?.value || '';
    if (!value) return;
    // Reports what actually happened. The link is on screen either way now, so a false
    // "Copied" costs a paste rather than the link — but it still sends somebody off to
    // paste an empty clipboard into a message to their client.
    const ok = await copyText(value, { doc });
    shareStatus(ok
      ? t('gallery.share.copied', 'Copied — the link is on your clipboard.')
      : t('gallery.share.copyFailed', 'Could not copy automatically. Select the link above and copy it.'));
    if (!ok && typeof input.select === 'function') input.select();
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
      // Before the entries guard: the no-matches panel is a state with NO entries, and its
      // one JS-owned line would otherwise be the only English left on a translated page.
      if (query) paintNoResults();
      if (!entries.length) return;
      paintCount();
      const more = /** @type {any} */ (byId('gal-more'));
      if (more && !more.disabled) more.textContent = t('gallery.more', 'Load more');
      // Re-rendered rather than patched: the cards' alt and aria-label are built from
      // the pack too, and they are the half nobody would notice staying English. Through
      // repaintGrid, so the open panel's focus-restore target survives the rebuild —
      // this used to hand openDetail the card it had just detached.
      repaintGrid();
      if (detail && !(/** @type {any} */ (detail).hidden) && current) openDetail(current, opener);
    });
  }

  return load();
}

// Not started under test: the spec drives `start()` with its own document and fetch.
if (typeof window !== 'undefined' && !(/** @type {any} */ (window).__GALLERY_TEST__)) {
  void start();
}
