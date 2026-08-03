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
import { createRenameRow } from './gallery/rename.js';
import { createDeleteConfirm } from './gallery/delete-confirm.js';
import { createSharePanel } from './gallery/share-panel.js';
import { createRefresher, REFRESH_DEBOUNCE_MS } from './share/refresh.js';
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
 * @param {{ doc?: Document, fetchImpl?: typeof fetch, searchDelayMs?: number,
 *   refreshDelayMs?: number }} [deps] - Injectable for tests. `searchDelayMs` is the search
 *   debounce and `refreshDelayMs` the expiry-recovery one; the specs drive both to 0 so a
 *   spec can await the work rather than sleep through it.
 * @returns {Promise<'ready' | 'empty' | 'no-results' | 'off' | 'error' | 'signed-out' | 'stale'>}
 *   The state it settled on.
 */
export async function start({
  doc = document, fetchImpl = fetch,
  searchDelayMs = SEARCH_DEBOUNCE_MS, refreshDelayMs = REFRESH_DEBOUNCE_MS,
} = {}) {
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

  // The share section is its own island: it paints a link the listing already handed
  // over, and nothing in it reaches back into the grid or the pager.
  const share = createSharePanel({ byId, t, plural, copyText, doc });

  // The rename row is its own island (gallery/rename.js) — a two-mode widget whose only
  // coupling to this file is which mode it is in. `currentEntry` is a getter rather than a
  // captured value because the panel is reused for every card.
  const rename = createRenameRow({
    byId,
    t,
    renameRender,
    fetchImpl,
    defaultName,
    entryName,
    currentEntry: () => current,
    onRenamed: () => repaintGrid(),
  });

  // The takedown, also its own island. `onDeleted` closes the panel BEFORE dropping the
  // entry: closeDetail nulls `current`, which is what stops repaintGrid re-pointing the
  // focus-restore target at a card for a render that no longer exists.
  const del = createDeleteConfirm({
    byId,
    t,
    deleteRender,
    fetchImpl,
    currentEntry: () => current,
    onDeleted: (id) => { closeDetail(); dropEntry(id); },
  });

  /**
   * Re-mint image URLs that have expired.
   *
   * The listing's URLs are presigned with a 15-minute TTL (GALLERY_URL_TTL_MS, echoed to
   * the page as `urlTtlMs`), and thumb/after/before are signed in the SAME response at the
   * same instant — so when one ages out they all have. The card's thumb→after fallback
   * therefore cannot rescue an expiry: it swaps to a URL that is equally dead, and every
   * tile ends up a transparent pixel. A tab left open over lunch was a page of blank rooms
   * with no way back short of a reload nobody thinks to do.
   *
   * Same mechanism the public share page has used since it shipped, and the same module.
   *
   * `urlTtlMs` is deliberately NOT used to pre-empt this on a timer: every path that would
   * notice an expiry — lazy-scrolling to a tile, waking the tab, opening the panel —
   * raises an `error` event, which is what drives this. A timer would add a second way to
   * be wrong about the clock for no benefit.
   * @type {any}
   */
  let refresher = null;
  /** @param {any} img */
  const onImage = (img) => refresher?.attach([img]);

  /**
   * The panel's focusable controls, in DOM order, skipping the hidden ones.
   *
   * Built by id rather than a query so it works against the document stand-in the specs
   * drive, which has getElementById and no querySelectorAll. The slider is the exception
   * — renderCompare hands it back for exactly this reason.
   *
   * The rename controls sit between the heading and the comparison in exactly one of two
   * modes, and which one is decided by the island rather than by the filter below.
   * `hidden` on the row does not set `.hidden` on the controls inside it, so filtering per
   * node would keep the input and its two buttons in the cycle while the row was closed —
   * and this trap calls focus() explicitly after preventDefault(), so Tab would land on
   * something that is not on screen instead of the browser simply skipping it.
   */
  function panelControls() {
    return [
      byId('gal-detail-close'),
      ...rename.controls(),
      compareRange,
      byId('gal-share-url'),
      byId('gal-share-copy'),
      byId('gal-delete'),
      ...del.controls(),
    ].filter((node) => node && !(/** @type {any} */ (node).hidden));
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
    const cards = renderGrid({ grid: byId('gal-grid'), entries, doc, onOpen: openDetail, onImage });
    if (!current) return;
    const at = entries.findIndex((entry) => entry.id === current.id);
    if (at >= 0 && cards[at]) opener = cards[at];
  }

  /**
   * Take one entry off the page without re-fetching it.
   *
   * This used to be `await load()`, which reset `entries`, `loaded` and the grid to page
   * one — so an agent who had pressed "Load more" twice lost 120 of their 180 cards, and
   * their scroll position, for deleting a single render. The row is already gone
   * server-side and the page knows exactly which one, so it can drop it locally and stay
   * where it was.
   *
   * `total` comes down with it, because the count above the grid is the account's total
   * (or the match count during a search) and re-reading it would cost the round-trip this
   * exists to avoid.
   * @param {string} id
   */
  function dropEntry(id) {
    const before = entries.length;
    entries = entries.filter((entry) => entry.id !== id);
    if (entries.length === before) return;
    loaded = entries.length;
    total = Math.max(0, total - 1);
    if (!entries.length) {
      // "Nothing matched" is not "nothing staged" — deleting the last match of a search
      // must not claim the gallery is empty.
      if (query) { paintNoResults(); setState('no-results'); return; }
      setState('empty');
      return;
    }
    paintCount();
    repaintGrid();
    const more = /** @type {any} */ (byId('gal-more'));
    if (more) more.hidden = loaded >= total;
  }

  /**
   * Take the page behind the overlay out of the accessibility tree and the tab order.
   *
   * `aria-modal` only tells a screen reader that the dialog is modal; without this its
   * virtual cursor still reads the whole grid and the nav underneath, so the panel was
   * modal to a keyboard and porous to a reader. The manual Tab trap kept KEYBOARD focus
   * in, which is exactly why nobody noticed.
   *
   * By id and via setAttribute, because the specs drive a document stand-in with
   * getElementById and no querySelectorAll. `inert` is a boolean content attribute, so
   * the empty string is the correct value.
   * @param {boolean} on
   */
  function inertBackground(on) {
    for (const id of ['gal-nav', 'gal-main']) {
      const node = byId(id);
      if (!node) continue;
      if (on) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    }
  }

  function closeDetail() {
    if (detail) /** @type {any} */ (detail).hidden = true;
    // An attribute, not a class: the CSS locks main's scroll off it, and it is the one
    // form both the browser and the test document agree on.
    doc.body.removeAttribute('data-gal-modal');
    inertBackground(false);
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
    rename.close();
    del.reset();
    compareRange = renderCompare({ container: byId('gal-compare'), entry, doc, onImage });
    renderMeta({ container: byId('gal-meta'), entry, doc });
    share.paint(entry);
    if (detail) /** @type {any} */ (detail).hidden = false;
    doc.body.setAttribute('data-gal-modal', 'open');
    inertBackground(true);
    // role="dialog" only says WHAT the element is. Without this the dialog is never
    // announced and the next Tab walks the page behind the overlay.
    const first = byId('gal-detail-close');
    if (first) first.focus();
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
    // Said out loud rather than only spun: the spinner is decoration, and between page
    // load and the first #gal-count announcement a screen reader heard nothing at all.
    // Written every time because the pack can change under an in-place language switch.
    const loadingLabel = byId('gal-loading-label');
    if (loadingLabel) loadingLabel.textContent = t('gallery.loading', 'Loading your gallery…');
    const main = byId('gal-main');
    if (main) main.setAttribute('aria-busy', 'true');
    const res = await listGallery({ offset: append ? loaded : 0, q: query }, fetchImpl);
    if (main) main.removeAttribute('aria-busy');
    // A response for a query the box no longer holds must not paint. Checked before ANY
    // state is written, so an overtaken request cannot even flip the page to 'error'.
    if (seq !== searchSeq) return 'stale';
    if (res.status === 401) { setState('signed-out'); return 'signed-out'; }
    // A failure is NOT an empty account. Every non-401 error used to land on "Nothing
    // staged yet", which tells someone looking for work they know they did that they
    // never did any.
    // setState BEFORE paintError, and the order is load-bearing: #gal-error-detail is an
    // aria-live region, and a live region whose content changes while it is still
    // display:none does not announce. Painting first was silent by construction.
    if (!res.ok || !res.body) { setState('error'); paintError(res.status); return 'error'; }
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
    renderGrid({ grid: byId('gal-grid'), entries: page, doc, onOpen: openDetail, append, onImage });
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

  /**
   * Re-fetch every page currently on screen, not just the first.
   *
   * A plain `load()` would drop pages two and three — the exact failure the pager exists to
   * prevent, and it would be worse here because the reader did not ask for anything: their
   * gallery would silently shrink while they were looking at it. So it walks forward until
   * it has back what it had.
   *
   * The seq is pinned to the CURRENT search so a re-mint mid-search cannot resurrect the
   * unfiltered grid.
   * @returns {Promise<any[] | null>} The fresh entries, or null when there is nothing to
   *   show — which is what makes the refresher count an attempt and eventually stop.
   */
  async function refetchLoaded() {
    const want = loaded;
    const seq = searchSeq;
    let state = await load({ seq });
    while (state === 'ready' && loaded < want && loaded < total) {
      state = await load({ append: true, seq });
    }
    return state === 'ready' && entries.length ? entries : null;
  }

  /**
   * Re-point the open panel's comparison at the fresh URLs.
   *
   * Deliberately NOT openDetail(): that moves focus to the close button, and a re-mint the
   * reader never asked for must not move their focus out from under them. Reassigning
   * `compareRange` keeps the Tab trap pointing at the slider actually on screen — the old
   * one is detached by now.
   */
  function repaintOpenPanel() {
    if (!current) return;
    const fresh = entries.find((entry) => entry.id === current.id);
    if (!fresh) return;
    current = fresh;
    compareRange = renderCompare({ container: byId('gal-compare'), entry: fresh, doc, onImage });
  }

  // Seeded empty: every image reaches it through `onImage` as it is built, including the
  // ones a later page appends, so there is no list to keep in sync.
  refresher = createRefresher({
    images: [],
    debounceMs: refreshDelayMs,
    reload: async () => {
      const fresh = await refetchLoaded();
      if (fresh) repaintOpenPanel();
      return fresh;
    },
  });

  byId('gal-detail-close')?.addEventListener('click', closeDetail);
  detail?.addEventListener('click', (event) => {
    // Backdrop only — clicking inside the panel must not dismiss it.
    if (event.target === detail) closeDetail();
  });
  doc.addEventListener('keydown', (event) => {
    const key = /** @type {any} */ (event).key;
    if (!detail || /** @type {any} */ (detail).hidden) return;
    if (key === 'Escape') {
      // Escape backs out of the innermost thing first, and there are two things it can be
      // inside of. Closing the whole panel from an open rename box would throw away what
      // was typed AND the render they were looking at, when all they asked for was to stop
      // renaming; backing out of "are you sure" must likewise leave the panel standing.
      if (del.isArmed()) {
        del.reset();
        const trigger = byId('gal-delete');
        if (trigger) trigger.focus();
        return;
      }
      if (rename.isOpen()) {
        rename.close();
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
  //
  // Disabled for the duration, which is doing two jobs: it stops a second press stacking
  // another listing onto a limiter that allows 120 per 15 minutes, and it is the only
  // feedback a retry gives when it fails with the same wording twice — the aria-live
  // region cannot announce text identical to what it already holds.
  byId('gal-retry')?.addEventListener('click', async () => {
    const retry = /** @type {any} */ (byId('gal-retry'));
    if (retry?.disabled) return;
    if (retry) retry.disabled = true;
    try {
      return await load();
    } finally {
      if (retry) retry.disabled = false;
    }
  });

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

  rename.bind();

  share.bind();

  del.bind();

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
