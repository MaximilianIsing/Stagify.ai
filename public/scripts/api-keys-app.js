// api-keys.html's composition root: fetches the account's API state and wires the
// islands that render it. The islands hold the logic and are unit-tested; this file is
// the wiring, and is covered by the page's e2e smoke.
//
// THE SHAPE IS MASTER / DETAIL. One column lists everything the account owns — the two
// account-level rows and every key, live or revoked — and the pane beside it shows
// whichever is selected. All the state lives in this file and the panes are pure
// functions of it, so "re-render" is always the same three lines and there is no path
// where the list and the pane disagree about what is selected.
//
// EVERY REQUEST CARRIES THE SESSION TOKEN AS A HEADER. The routes read
// `Authorization: Bearer <session>` via getAuthUserFromRequest, never a query parameter
// — a token in a URL leaks through access logs, proxy logs and Referer.

import { t } from './api-keys/i18n.js';
import { renderLedger } from './api-keys/ledger.js';
import { loadPacks, renderPacks } from './api-keys/credit-packs.js';
import { createKeyDialog } from './api-keys/create-key-dialog.js';
import { renderList, selectionFromHash, hashFor, defaultSelection } from './api-keys/inspector.js';
import { keyDetailHtml, renameFormHtml } from './api-keys/key-detail.js';
import { usageDetailHtml, billingDetailHtml } from './api-keys/account-detail.js';

const el = (id) => document.getElementById(id);

/** Everything the page draws itself from. Mutated in place; never read from the DOM. */
const state = {
  keys: [],
  credits: null,
  usage: null,
  packs: [],
  selected: null,
  filter: '',
  renaming: null,
};

/** @returns {string | null} The session token, if signed in. */
function token() {
  return window.StagifyAuth && typeof window.StagifyAuth.getToken === 'function'
    ? window.StagifyAuth.getToken()
    : null;
}

/**
 * Authenticated fetch against our own API.
 * @param {string} url - Path.
 * @param {RequestInit} [opts] - Fetch options.
 * @returns {Promise<Response>} The response.
 */
function api(url, opts = {}) {
  // Named `session`, not `t`: `t` is the translator imported at the top of this file,
  // and shadowing it here once cost a confusing minute.
  const session = token();
  return fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(session ? { Authorization: 'Bearer ' + session } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

/** Show the signed-out panel instead of an empty dashboard. */
function showSignedOut() {
  el('ak-app')?.classList.add('hidden');
  el('ak-signedout')?.classList.remove('hidden');
}

/** Show the dashboard. */
function showApp() {
  el('ak-signedout')?.classList.add('hidden');
  el('ak-app')?.classList.remove('hidden');
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * The per-key slice of the usage summary, or undefined when it never arrived.
 * @param {string} keyId - The key.
 * @returns {any} The row, or undefined.
 */
function usageForKey(keyId) {
  return (state.usage?.keys || []).find((k) => String(k.keyId) === String(keyId));
}

/**
 * Daily buckets attributed to one key.
 *
 * The usage endpoint buckets by day for the ACCOUNT and by key for the window, not
 * both — a per-key-per-day cross-tab is a bigger payload than a dashboard needs. So a
 * key's chart shows the account's shape when it is the only key with traffic, and is
 * otherwise omitted rather than mislabelled.
 * @param {string} keyId - The key.
 * @returns {any[]} Buckets, or [].
 */
function bucketsForKey(keyId) {
  const rows = state.usage?.keys || [];
  const active = rows.filter((k) => Number(k.delivered || 0) + Number(k.refunded || 0) > 0);
  const soleOwner = active.length === 1 && String(active[0].keyId) === String(keyId);
  return soleOwner ? (state.usage.buckets || []) : [];
}

/** Paint the master column from state. */
function paintList() {
  renderList(el('ak-list'), {
    keys: state.keys,
    credits: state.credits,
    usage: state.usage,
    selected: state.selected,
    filter: state.filter,
  });
}

/** Paint the detail pane from state, and re-run the islands it hosts. */
function paintDetail() {
  const host = el('ak-detail');
  if (!host) return;

  if (state.selected === 'usage') {
    host.innerHTML = usageDetailHtml(state);
    return;
  }
  if (state.selected === 'billing') {
    host.innerHTML = billingDetailHtml(state);
    // The two islands the pane only provides a home for. Re-run on every paint
    // because the pane's markup — and so both hosts — is replaced wholesale.
    renderPacks(el('ak-packs'), state.packs, {
      buyable: true,
      buyLabel: t('apiKeys.billing.buyCta', 'Buy'),
    });
    renderLedger(el('ak-ledger'), state.credits?.ledger || []);
    return;
  }

  const key = state.keys.find((k) => String(k.id) === String(state.selected));
  if (!key) {
    host.innerHTML = '<p class="ak-empty">'
      + t('apiKeys.gone', 'That key is no longer on this account.') + '</p>';
    return;
  }
  host.innerHTML = keyDetailHtml(key, {
    usage: usageForKey(key.id),
    // Whether the summary ANSWERED, which is not the same as whether this key is in it:
    // a key with no traffic has no row, and without this the pane would tell an idle
    // account its usage could not be loaded. See keyDetailHtml.
    usageLoaded: !!state.usage,
    buckets: bucketsForKey(key.id),
    windowDays: Number(state.usage?.days) || 30,
  });
  if (state.renaming === String(key.id)) startRename(key);
}

/**
 * Re-run the markup translator over whatever was just rendered.
 *
 * Almost every string on this page comes from i18n.js at render time, but a handful of
 * JS-rendered nodes carry `data-lang` instead — the pack grid's two labels (shared with
 * developers.html, which is server-rendered per language) and the suspended notice,
 * which contains a link. language-loader.js walked the document long before those nodes
 * existed, so they need a second pass.
 * @returns {void}
 */
function applyPackToMarkup() {
  const sys = /** @type {any} */ (window).LanguageSystem;
  if (sys && typeof sys.applyLanguageToElements === 'function') sys.applyLanguageToElements();
}

/** True while a repaint is in flight; see the languagechange listener. */
let repainting = false;

/** Paint both halves. */
function paint() {
  paintList();
  paintDetail();
  applyPackToMarkup();
}

/**
 * Select an item, writing the choice into the URL so the pane is linkable and the back
 * button walks the selections rather than leaving the page.
 * @param {string} id - An account item id or a key id.
 * @returns {void}
 */
function select(id) {
  if (!id || id === state.selected) return;
  state.selected = id;
  state.renaming = null;
  // replaceState, not a hash assignment: this fires from a click that already moved the
  // user's attention, and a history entry per row would make Back a lottery.
  try {
    history.replaceState(null, '', hashFor(id));
  } catch { /* file:// and some embedded webviews refuse; the selection still applies */ }
  paint();
}

/**
 * Resolve the selection from the URL, falling back to the default.
 *
 * A fallback is written BACK into the URL, so the address bar always names what is on
 * screen: copying the link mid-session hands someone the same pane, and a reload after
 * revoking a key does not silently land somewhere else. replaceState, so this never
 * adds a history entry to the visit that just started.
 */
function applyHashSelection() {
  const wanted = selectionFromHash(window.location.hash, state.keys);
  state.selected = wanted || defaultSelection(state.keys);
  if (!wanted) {
    try { history.replaceState(null, '', hashFor(state.selected)); } catch { /* see select() */ }
  }
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** Load the key list. */
async function refreshKeys() {
  try {
    const res = await api('/api/api-keys');
    if (!res.ok) return;
    const body = await res.json();
    state.keys = Array.isArray(body.keys) ? body.keys : [];
  } catch { /* a failed refresh leaves the last good list on screen */ }
}

/** Load the balance + ledger. */
async function refreshCredits() {
  try {
    const res = await api('/api/api-credits');
    if (!res.ok) return;
    state.credits = await res.json();
  } catch { /* as above */ }
}

/**
 * Load the usage summary.
 *
 * Failure is survivable and stays that way: `usage` is left null, the panes print
 * dashes and say so, and the keys and balance — which come from other endpoints — are
 * unaffected. This is the newest of the three endpoints and the only one whose absence
 * must not take the page down with it.
 */
async function refreshUsage() {
  try {
    const res = await api('/api/api-usage');
    if (!res.ok) return;
    state.usage = await res.json();
  } catch { /* the panes render an explicit "unavailable" rather than zeros */ }
}

/** Load the buyable packs. Public, so this works signed out too. */
async function refreshPacks() {
  state.packs = await loadPacks();
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Send the buyer to Stripe.
 * @param {string} packId - The pack to buy.
 * @returns {Promise<void>}
 */
async function buy(packId) {
  try {
    const res = await api('/api/api-credits/checkout', {
      method: 'POST',
      body: JSON.stringify({ packId }),
    });
    const body = await res.json();
    if (res.ok && body.url) {
      window.location.href = body.url;
      return;
    }
    // The SERVER's message when it sent one: it is the specific reason (an unknown
     // pack, billing switched off) and it already comes back localized-agnostic English.
     // Ours is the generic fallback.
    window.alert(body.error || t('apiKeys.error.checkout', 'Could not start checkout. Please try again.'));
  } catch {
    window.alert(t('apiKeys.error.billing', 'Could not reach the billing service. Please try again.'));
  }
}

/**
 * Revoke a key after confirming — this cannot be undone and will break whatever is
 * using it, which is exactly the kind of action that deserves a prompt.
 * @param {string} id - The key id.
 * @returns {Promise<void>}
 */
async function revoke(id) {
  const question = t('apiKeys.key.confirm', 'Revoke this key? Anything using it will stop working immediately.');
  if (!window.confirm(question)) return;
  try {
    await api('/api/api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch { /* the refresh below shows the real state either way */ }
  await Promise.all([refreshKeys(), refreshCredits()]);
  paint();
}

/**
 * Swap the detail pane's title for the rename form and focus it.
 * @param {any} key - The key being renamed.
 * @returns {void}
 */
function startRename(key) {
  const title = el('ak-detail-title');
  if (!title) return;
  state.renaming = String(key.id);
  title.insertAdjacentHTML('afterend', renameFormHtml(key));
  title.classList.add('hidden');
  const input = /** @type {HTMLInputElement | null} */ (el('ak-rename-input'));
  if (input) {
    input.focus();
    // Selected, not just focused: the field is pre-filled with the current name and the
    // common case is replacing it, not appending to it.
    input.select();
  }
}

/**
 * Rename a key.
 * @param {string} id - The key id.
 * @param {string} name - The new name.
 * @returns {Promise<void>}
 */
async function rename(id, name) {
  try {
    await api('/api/api-keys/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  } catch { /* the refresh shows whether it took */ }
  state.renaming = null;
  await refreshKeys();
  paint();
}

// The id of the last key minted in this page's lifetime. Held here rather than passed
// through the dialog because onCreate is already this file's own callback — the dialog
// has no reason to learn about records to hand one back.
let lastCreatedId = null;

const dialog = createKeyDialog({
  onCreate: async (name) => {
    try {
      const res = await api('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error };
      lastCreatedId = body.record?.id || null;
      return { ok: true, key: body.key };
    } catch {
      return { ok: false, error: t('apiKeys.error.server', 'Could not reach the server. Please try again.') };
    }
  },
  onClosed: async () => {
    await Promise.all([refreshKeys(), refreshCredits()]);
    // Land on the key that was just made. Creating one is the only action on this page
    // whose result is a new row, and leaving the pane on the old selection makes it
    // look like nothing happened.
    if (lastCreatedId && state.keys.some((k) => String(k.id) === String(lastCreatedId))) {
      state.selected = String(lastCreatedId);
      try { history.replaceState(null, '', hashFor(state.selected)); } catch { /* see select() */ }
    }
    lastCreatedId = null;
    paint();
  },
});

// ── Events ──────────────────────────────────────────────────────────────────

el('ak-create')?.addEventListener('click', (e) => {
  dialog.open(/** @type {HTMLElement} */ (e.currentTarget));
});

el('ak-signin')?.addEventListener('click', () => {
  // profile-menu.js owns the auth modal and exposes no global for opening it, so this
  // opens the account dropdown instead — which for a signed-out visitor is exactly the
  // Sign in / Create account pair. One click more than a direct modal, and no new
  // cross-file global to keep in sync.
  el('profile-menu-btn')?.click();
});

el('ak-search')?.addEventListener('input', (e) => {
  state.filter = /** @type {HTMLInputElement} */ (e.currentTarget).value;
  paintList();
});

// Delegated, because both halves are re-rendered wholesale and per-node listeners would
// be lost on every paint.
document.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!target || typeof target.closest !== 'function') return;

  const selectBtn = target.closest('[data-ak-select]');
  if (selectBtn) {
    select(selectBtn.getAttribute('data-ak-select') || '');
    return;
  }
  const buyBtn = target.closest('[data-buy-pack]');
  if (buyBtn) {
    void buy(buyBtn.getAttribute('data-buy-pack') || '');
    return;
  }
  const revokeBtn = target.closest('[data-revoke-key]');
  if (revokeBtn) {
    void revoke(revokeBtn.getAttribute('data-revoke-key') || '');
    return;
  }
  const renameBtn = target.closest('[data-ak-rename]');
  if (renameBtn) {
    const key = state.keys.find((k) => String(k.id) === renameBtn.getAttribute('data-ak-rename'));
    if (key) startRename(key);
    return;
  }
  if (target.closest('[data-ak-rename-cancel]')) {
    state.renaming = null;
    paintDetail();
  }
});

document.addEventListener('submit', (e) => {
  const form = /** @type {HTMLFormElement} */ (e.target);
  const id = form?.getAttribute?.('data-ak-rename-form');
  if (!id) return;
  e.preventDefault();
  const input = /** @type {HTMLInputElement | null} */ (form.querySelector('input[name=name]'));
  void rename(id, (input?.value || '').trim());
});

// The page swaps language IN PLACE — it has no localized URL (it is noindex and absent
// from LOCALIZED_PAGES), so the switcher reloads the pack underneath it rather than
// navigating, exactly as the gallery does. Everything the panes render was resolved from
// the OLD pack, so the only thing that repaints them is this.
//
// The guard is not paranoia: applyPackToMarkup() ends by firing `languagechange` itself,
// so without it a switch would repaint, re-apply, repaint, forever.
window.addEventListener('languagechange', () => {
  if (repainting) return;
  repainting = true;
  try {
    paint();
  } finally {
    repainting = false;
  }
});

// A pasted #key/… link, and the back button walking someone out of a selection.
window.addEventListener('hashchange', () => {
  const wanted = selectionFromHash(window.location.hash, state.keys);
  if (wanted && wanted !== state.selected) {
    state.selected = wanted;
    state.renaming = null;
    paint();
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────

/** Decide signed-in vs signed-out, then load everything. */
async function boot() {
  if (!token()) {
    // Nothing is fetched for a signed-out visitor, not even the public pack table: the
    // packs live inside the billing pane, which only exists once there is an account to
    // show one for. developers.html is where pricing is public.
    showSignedOut();
    return;
  }
  showApp();
  const packs = refreshPacks();

  // Keys first and alone: the selection — and therefore which pane is painted at all —
  // depends on the key list, so painting before it lands would show the fallback pane
  // and then jump.
  await refreshKeys();
  applyHashSelection();
  paint();

  await Promise.all([refreshCredits(), refreshUsage(), packs]);
  paint();
}

// No ready-signal dance: StagifyAuth.getToken() reads localStorage synchronously, so the
// signed-in/out decision is correct on the first tick. (`user` is populated later by
// /api/auth/me, but nothing here needs it — the server re-validates the token on every
// request anyway, and a token that has expired simply gets 401s that the refreshers
// swallow.)
void boot();
