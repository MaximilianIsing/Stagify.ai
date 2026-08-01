// The broker's end of the client share link: mint it, copy it, configure what the
// recipient sees, and revoke it. The public page it produces lives elsewhere
// (public/listing-share.html); this file is only the controls.
//
// THE ONE THING THAT SHAPES EVERY DECISION IN HERE: THE URL IS SHOWN ONCE.
//
// The link's token is hashed at rest exactly like a password — lib/data/project-shares.js
// stores only its digest — so the plaintext address exists in exactly one place, the
// response to `POST …/share`, and for exactly as long as this module keeps it in a local
// variable. `GET …/share` can say a live link EXISTS, when it was made and how often it has
// been opened; it cannot say what the link IS.
//
// So `mintedUrl` below is deliberately module-local and deliberately NOT persisted. Do not
// write it to localStorage/sessionStorage "for convenience", do not stash it on the share
// row, and do not try to rebuild it from `share.id` — all three would defeat the hashing
// and are the exact workaround this design exists to prevent. After a reload the panel says
// so in plain words and offers a rotation, which is the supported way to get an address
// back. `shareStatusText` is where that sentence lives, and it is pure so it can be argued
// with in a test rather than only in a browser.
//
// SECOND: the panel is INERT WITHOUT ITS MARKUP. `mountSharePanel` returns a do-nothing
// handle when `#pj-share` is absent, which is what keeps it safe to wire unconditionally
// from the entry (and what keeps the existing studio suite, whose stub document predates
// these ids, passing untouched).
//
// THIRD: no HTML-string sink anywhere below — textContent and `.value` only, the same
// convention as ./picker.js and ./bulk-bar.js. The operator's own headline, note and
// contact details flow through this panel, and a value assigned to `.value` or
// `.textContent` is never parsed as markup. If a future change here genuinely needs to
// build markup, import `escapeHtml` from ../escape-html.js — do not hand-roll one.

import { ApiError, newShare, fetchShare, patchShare, revokeShare } from './api.js';
import { FEEDBACK_ELEMENT_IDS, mountShareFeedback } from './share-feedback.js';
import { formatDate } from './summaries.js';
import { showErrorToast, showToast } from '../toast.js';

/**
 * @typedef {import('../../../lib/types/projects.js').ProjectShare} PjShare
 * @typedef {import('../../../lib/types/projects.js').ShareSettings} PjShareSettings
 * @typedef {import('./state.js').PjState} PjState
 */

/**
 * @typedef {object} PjSharePanel
 * @property {() => void} destroy - Drop the store subscription.
 */

/** Milliseconds in a day, for turning an absolute expiry back into the chosen window. */
const DAY_MS = 86400000;

/**
 * Every element id this panel resolves, exported so projects.html and the page's drift
 * guard have one list to agree with rather than three hand-copied ones.
 *
 * The client-response block's ids are SPREAD IN from the module that resolves them
 * (./share-feedback.js) rather than re-typed here — a second hand-copied list is exactly
 * the drift this export exists to prevent.
 */
export const SHARE_ELEMENT_IDS = [
  'pj-share',
  'pj-share-status',
  'pj-share-meta',
  'pj-share-url-row',
  'pj-share-url',
  'pj-share-copy',
  'pj-share-create',
  'pj-share-create-label',
  'pj-share-revoke',
  'pj-share-save',
  'pj-share-error',
  'pj-share-live',
  'pj-share-before',
  'pj-share-headline',
  'pj-share-note',
  'pj-share-agent-name',
  'pj-share-agent-email',
  'pj-share-agent-phone',
  'pj-share-expiry',
  ...FEEDBACK_ELEMENT_IDS,
];

/** The expiry windows the select offers, in days. `null` is "never". */
export const EXPIRY_CHOICES = [null, 7, 30, 90];

/**
 * What a listing shares with before the operator has configured anything.
 *
 * `showBefore` defaults TRUE: the before/after pair is the argument the staging makes, and
 * a client who only sees the "after" has no way to read it as staging rather than as the
 * room. Turning it off is a deliberate choice, not a default.
 * @returns {PjShareSettings}
 */
export function defaultShareSettings() {
  return {
    showBefore: true,
    headline: '',
    note: '',
    agentName: '',
    agentEmail: '',
    agentPhone: '',
  };
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Fill in whatever the server left out, without inventing anything.
 *
 * `showBefore` is the one field where absence is NOT the same as false: an older row that
 * predates the flag should publish the pair, so only an explicit `false` turns it off.
 * @param {Partial<PjShareSettings>|null|undefined} raw
 * @returns {PjShareSettings}
 */
export function normalizeShareSettings(raw) {
  const source = raw || {};
  return {
    showBefore: source.showBefore === undefined ? true : !!source.showBefore,
    headline: text(source.headline),
    note: text(source.note),
    agentName: text(source.agentName),
    agentEmail: text(source.agentEmail),
    agentPhone: text(source.agentPhone),
  };
}

/**
 * Has this link's own clock run out? Separate from `revokedAt`, which is the owner
 * switching it off, because the two produce different sentences.
 * @param {PjShare|null|undefined} share
 * @param {number} [now]
 * @returns {boolean}
 */
export function isShareExpired(share, now = Date.now()) {
  if (!share || share.expiresAt === null || share.expiresAt === undefined) return false;
  return Number(share.expiresAt) <= now;
}

/**
 * Will this link open for someone holding it right now?
 * @param {PjShare|null|undefined} share
 * @param {number} [now]
 * @returns {boolean}
 */
export function isShareLive(share, now = Date.now()) {
  if (!share) return false;
  if (share.revokedAt) return false;
  return !isShareExpired(share, now);
}

/**
 * The panel's headline claim.
 *
 * The fourth branch is the one that matters and the one a "helpful" refactor will want to
 * remove: a live link whose address we no longer hold. Saying "your link is active" and
 * showing nothing would read as a bug; saying it and explaining WHY is the honest UI for a
 * hashed token, and pointing at rotation is the only real remedy.
 * @param {PjShare|null|undefined} share
 * @param {boolean} hasUrl - Whether the minted address is still in memory.
 * @param {number} [now]
 * @returns {string}
 */
export function shareStatusText(share, hasUrl, now = Date.now()) {
  if (!share) {
    return 'No client link yet. Create one to give your client a private page of the staged frames.';
  }
  if (share.revokedAt) {
    return 'That link was revoked and no longer opens. Create a new link to share this listing again.';
  }
  if (isShareExpired(share, now)) {
    return 'That link has expired and no longer opens. Create a new link to share this listing again.';
  }
  if (hasUrl) {
    return 'Your link is live. Copy it now — this is the only time we can show you the address.';
  }
  return 'Your link is active. For security we only show the address once, so we cannot show it to you again — create a new link if you need it.';
}

/**
 * The supporting line: when it was made, how it has been used, when it stops.
 *
 * A count of zero is stated ("Not opened yet") rather than omitted — "no views" is real
 * information to an agent deciding whether the client ever got the email.
 * @param {PjShare|null|undefined} share
 * @returns {string}
 */
export function shareMetaText(share) {
  if (!share) return '';
  /** @type {string[]} */
  const parts = [];
  const created = formatDate(share.createdAt);
  if (created) parts.push(`Created ${created}`);

  const views = Number(share.viewCount) || 0;
  const lastSeen = formatDate(share.lastViewedAt);
  if (!views) parts.push('Not opened yet');
  else parts.push(`Opened ${views} time(s)${lastSeen ? `, last on ${lastSeen}` : ''}`);

  if (share.revokedAt) {
    const revoked = formatDate(share.revokedAt);
    parts.push(revoked ? `Revoked ${revoked}` : 'Revoked');
  } else if (share.expiresAt) {
    const expires = formatDate(share.expiresAt);
    parts.push(expires ? `Expires ${expires}` : 'Expires');
  } else {
    parts.push('No expiry');
  }
  return parts.join(' · ');
}

/**
 * The expiry window the operator originally picked, as a select value.
 *
 * Derived from the share's own span (`expiresAt - createdAt`) rather than from the time
 * remaining, so re-opening the panel shows the CHOICE that was made instead of a countdown
 * that drifts to a different bucket every day. A span matching none of the offered windows
 * reads back as '' (never) — the meta line still states the real date, and the select is
 * documented in the markup as counting from the moment you save.
 * @param {PjShare|null|undefined} share
 * @returns {string} '' | '7' | '30' | '90'
 */
export function expirySelectValue(share) {
  if (!share || !share.expiresAt || !share.createdAt) return '';
  const days = Math.round((Number(share.expiresAt) - Number(share.createdAt)) / DAY_MS);
  return EXPIRY_CHOICES.includes(days) ? String(days) : '';
}

/**
 * Wire the share panel.
 *
 * Takes the shared store rather than a project id so it can react to the operator opening a
 * different listing — the minted URL belongs to the listing it was minted for and must not
 * survive that switch.
 *
 * @param {{
 *   store: {
 *     get: () => PjState,
 *     subscribe: (listener: (state: PjState) => void) => (() => void),
 *   },
 *   ask: (heading: string, body: string, confirmLabel: string, action: () => void) => void,
 * }} deps - The projects store and the page's shared confirm dialog (./dialog.js). The
 *   confirm is injected rather than imported so this panel cannot open a second dialog
 *   instance, and so `confirm()`/`alert()` never appear on this page.
 * @returns {PjSharePanel}
 */
export function mountSharePanel(deps) {
  const { store, ask } = deps;
  /** @param {string} id @returns {any} */
  const byId = (id) => document.getElementById(id);

  const root = byId('pj-share');
  // Inert without its markup — see the header. This is what lets the entry wire the panel
  // unconditionally on a page (or a test document) that has not got the section.
  if (!root) return { destroy() {} };

  const statusLine = byId('pj-share-status');
  const metaLine = byId('pj-share-meta');
  const urlRow = byId('pj-share-url-row');
  const urlField = byId('pj-share-url');
  const copyBtn = byId('pj-share-copy');
  const createBtn = byId('pj-share-create');
  const createLabel = byId('pj-share-create-label');
  const revokeBtn = byId('pj-share-revoke');
  const saveBtn = byId('pj-share-save');
  const errorLine = byId('pj-share-error');
  const liveRegion = byId('pj-share-live');
  const beforeToggle = byId('pj-share-before');
  const headlineInput = byId('pj-share-headline');
  const noteInput = byId('pj-share-note');
  const nameInput = byId('pj-share-agent-name');
  const emailInput = byId('pj-share-agent-email');
  const phoneInput = byId('pj-share-agent-phone');
  const expirySelect = byId('pj-share-expiry');

  /** The listing the panel is currently describing. */
  let projectId = '';
  /** @type {PjShare|null} */
  let share = null;
  /**
   * The plaintext address, held ONLY here and ONLY until the page reloads or the operator
   * opens another listing. See the file header before changing this.
   */
  let mintedUrl = '';
  /** True while a request is in flight, so the controls cannot be double-fired. */
  let busy = false;

  /** @param {string} message */
  function announce(message) {
    liveRegion.textContent = message;
  }

  function clearError() {
    errorLine.textContent = '';
    errorLine.classList.add('hidden');
  }

  /**
   * Surface a failure both ways: a toast (which is transient) and a notice pinned in the
   * panel (which is not). The panel stays fully usable — nothing here is disabled by a
   * failure, because the remedy is almost always "press it again".
   * @param {unknown} error
   */
  function fail(error) {
    const message =
      error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
    errorLine.textContent = message;
    errorLine.classList.remove('hidden');
    showErrorToast(message);
  }

  /** Redraw everything EXCEPT the form fields — see fillForm for why they are separate. */
  function renderStatus() {
    const live = isShareLive(share);
    statusLine.textContent = shareStatusText(share, !!mintedUrl);
    metaLine.textContent = shareMetaText(share);
    urlRow.classList.toggle('hidden', !mintedUrl);
    urlField.value = mintedUrl;
    createLabel.textContent = live ? 'Create new link' : 'Create client link';
    createBtn.disabled = busy || !projectId;
    copyBtn.disabled = busy || !mintedUrl;
    revokeBtn.disabled = busy || !live;
    saveBtn.disabled = busy || !live;
  }

  /**
   * Write server state into the form.
   *
   * Kept OUT of renderStatus on purpose: the store notifies on every poll tick during a
   * run, and a redraw that also rewrote these fields would delete whatever the operator was
   * typing mid-sentence. The form is therefore written only when the server has just told
   * us something new about it (a load, a mint, a save).
   * @param {Partial<PjShareSettings>|null|undefined} raw
   * @param {PjShare|null} [current]
   */
  function fillForm(raw, current) {
    const settings = normalizeShareSettings(raw);
    beforeToggle.checked = settings.showBefore;
    headlineInput.value = settings.headline;
    noteInput.value = settings.note;
    nameInput.value = settings.agentName;
    emailInput.value = settings.agentEmail;
    phoneInput.value = settings.agentPhone;
    expirySelect.value = expirySelectValue(current === undefined ? share : current);
  }

  /**
   * The WHOLE settings bag, every time. The server normalizes through an allowlist, so a
   * partial send is how a field quietly reverts to its default.
   * @returns {PjShareSettings}
   */
  function readForm() {
    return {
      showBefore: !!beforeToggle.checked,
      headline: text(headlineInput.value).trim(),
      note: text(noteInput.value).trim(),
      agentName: text(nameInput.value).trim(),
      agentEmail: text(emailInput.value).trim(),
      agentPhone: text(phoneInput.value).trim(),
    };
  }

  /** @returns {number|null} */
  function readExpiry() {
    const days = Number(text(expirySelect.value));
    return Number.isFinite(days) && days > 0 ? days : null;
  }

  /** @param {boolean} on */
  function setBusy(on) {
    busy = on;
    renderStatus();
  }

  /**
   * Read the listing's share state. Guarded against the operator opening another listing
   * mid-flight: a late response for the previous one must not overwrite the current panel.
   * @param {string} id
   */
  async function load(id) {
    setBusy(true);
    try {
      const result = await fetchShare(id);
      if (id !== projectId) return;
      share = (result && result.share) || null;
      fillForm(share ? share.settings : defaultShareSettings());
    } catch (error) {
      if (id === projectId) fail(error);
    } finally {
      if (id === projectId) setBusy(false);
    }
  }

  /** Mint (or rotate) the link. The only call that can ever hand back an address. */
  function mint() {
    clearError();
    setBusy(true);
    newShare(projectId, { settings: readForm(), expiresInDays: readExpiry() })
      .then((result) => {
        share = (result && result.share) || null;
        mintedUrl = result && typeof result.url === 'string' ? result.url : '';
        fillForm(share ? share.settings : readForm());
        showToast(
          result && result.replaced
            ? 'New link created — the previous one stopped working.'
            : 'Client link created.'
        );
        announce('Link created. Copy it now — the address is shown only once.');
      })
      .catch(fail)
      .finally(() => setBusy(false));
  }

  /**
   * Copy the minted address.
   *
   * `navigator.clipboard` is undefined on an insecure origin and rejects when the document
   * is not focused or permission is refused, so the fallback is not decoration: it selects
   * the readonly field so the operator's own Ctrl/Cmd+C still works. Failing silently here
   * would lose the one address they will ever be shown.
   */
  async function copyUrl() {
    if (!mintedUrl) return;
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('unavailable');
      await clipboard.writeText(mintedUrl);
      announce('Link copied to your clipboard.');
      showToast('Link copied.');
      return;
    } catch (e) { /* fall through to the manual path */ }
    try {
      urlField.focus();
      if (typeof urlField.select === 'function') urlField.select();
    } catch (e) { /* a detached or stubbed field — the message below still stands */ }
    announce('Could not copy automatically. The link is selected — press Ctrl or Cmd + C.');
    showToast('The link is selected — press Ctrl or Cmd + C to copy it.');
  }

  createBtn.addEventListener('click', () => {
    if (!projectId || busy) return;
    // Rotating is destructive to whoever already holds the old address, so it confirms —
    // the first mint, which breaks nothing, does not.
    if (isShareLive(share)) {
      ask(
        'Replace the current client link?',
        'The link you already sent stops opening immediately, and anyone holding it loses access. You will be shown the new address once.',
        'Create new link',
        mint
      );
      return;
    }
    mint();
  });

  copyBtn.addEventListener('click', () => {
    copyUrl();
  });

  revokeBtn.addEventListener('click', () => {
    if (!projectId || busy || !isShareLive(share)) return;
    ask(
      'Revoke this client link?',
      'Anyone holding the link stops being able to open the page immediately. The listing and its renders are untouched, and you can create a new link afterwards.',
      'Revoke link',
      () => {
        clearError();
        setBusy(true);
        revokeShare(projectId)
          .then(() => {
            share = null;
            mintedUrl = '';
            showToast('Client link revoked.');
            announce('Client link revoked.');
          })
          .catch(fail)
          .finally(() => setBusy(false));
      }
    );
  });

  saveBtn.addEventListener('click', () => {
    if (!projectId || busy || !isShareLive(share)) return;
    clearError();
    setBusy(true);
    patchShare(projectId, { settings: readForm(), expiresInDays: readExpiry() })
      .then((result) => {
        // Refilled from the RESPONSE, not from what was typed: the server clamps and
        // allowlists, and the operator should see what was actually stored.
        if (result && result.share) {
          share = result.share;
          fillForm(share.settings, share);
        }
        showToast('Share settings saved.');
      })
      .catch(fail)
      .finally(() => setBusy(false));
  });

  const unsubscribe = store.subscribe((state) => {
    const id = state && state.project ? state.project.id : '';
    // Only a CHANGE of listing resets the panel. The store also notifies on every progress
    // tick, and reloading the share (or clearing the form) 24 times an hour would be both
    // pointless traffic and a cursor jumping out of the note field.
    if (id === projectId) return;
    projectId = id;
    share = null;
    mintedUrl = '';
    clearError();
    fillForm(defaultShareSettings(), null);
    renderStatus();
    if (id) load(id);
  });

  // The client's responses, mounted here rather than from the entry for two reasons: the
  // markup lives inside this section (so a page without `#pj-share` has no feedback block
  // either, and both go inert together), and public/scripts/projects-app.js sits exactly on
  // the 650-line eslint ceiling.
  //
  // MOUNTED AFTER THE SUBSCRIBE ABOVE, ON PURPOSE. Listeners fire in registration order, so
  // this keeps the share row — the panel's headline claim, and the thing an operator is
  // waiting on — as the first request out on opening a listing, with the responses read
  // behind it.
  const feedback = mountShareFeedback({ store });

  fillForm(defaultShareSettings(), null);
  renderStatus();

  return {
    destroy() {
      unsubscribe();
      feedback.destroy();
    },
  };
}
