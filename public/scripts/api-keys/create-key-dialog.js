// The create-key dialog, and the one-time reveal that is the whole reason it exists.
//
// THE REVEAL IS THE POINT. POST /api/api-keys is the only response in the entire product
// that ever carries a plaintext key; the server stores a sha256 digest and cannot
// reproduce it. So this dialog has two states — the form, then the reveal — and the
// reveal says plainly that this is the only time. Closing it is deliberately an explicit
// "I've saved it" rather than a backdrop click, because a stray click that dismisses an
// unrecoverable secret is a support ticket that cannot be resolved.
//
// Focus handling follows the house rule the other JS-built dialogs use: focus moves into
// the panel on open and returns to the trigger on close. A Tab trap is NOT focus
// management — see the note in the shared dialog work — so this does the part that
// actually matters for a keyboard user.

import { t } from './i18n.js';

/**
 * Wire the dialog.
 * @param {{
 *   onCreate: (name: string) => Promise<{ ok: boolean, key?: string, error?: string }>,
 *   onClosed?: () => void,
 * }} deps - The creator (talks to the API) and an optional after-close hook so the page
 *   can refresh its list.
 * @returns {{ open: (trigger?: HTMLElement | null) => void, close: () => void }} Controls.
 */
export function createKeyDialog({ onCreate, onClosed }) {
  const el = (id) => document.getElementById(id);
  let returnFocusTo = null;
  let busy = false;

  /** Reset to the form state, so a second open never shows the last key. */
  function reset() {
    const form = el('ak-modal-form');
    const reveal = el('ak-modal-reveal');
    const err = el('ak-modal-error');
    const name = /** @type {HTMLInputElement | null} */ (el('ak-name'));
    const revealed = el('ak-reveal-key');
    if (form) form.classList.remove('hidden');
    if (reveal) reveal.classList.add('hidden');
    if (err) err.classList.add('hidden');
    if (name) name.value = '';
    // Drop the plaintext out of the DOM as well as out of sight.
    if (revealed) revealed.textContent = '';
    busy = false;
  }

  /**
   * @param {HTMLElement | null} [trigger] - What to hand focus back to on close.
   * @returns {void}
   */
  function open(trigger) {
    returnFocusTo = trigger || null;
    reset();
    const modal = el('ak-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const name = /** @type {HTMLInputElement | null} */ (el('ak-name'));
    if (name) name.focus();
  }

  /** @returns {void} */
  function close() {
    const modal = el('ak-modal');
    if (modal) modal.classList.add('hidden');
    reset();
    // Focus goes back to what opened the dialog — not to <body>, which is where a
    // hidden element's focus lands and where a keyboard user gets stranded.
    if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
    returnFocusTo = null;
    if (typeof onClosed === 'function') onClosed();
  }

  /** Submit the form half. */
  async function submit() {
    if (busy) return;
    busy = true;
    const nameInput = /** @type {HTMLInputElement | null} */ (el('ak-name'));
    const err = el('ak-modal-error');
    if (err) err.classList.add('hidden');

    const out = await onCreate(nameInput ? nameInput.value : '');
    if (!out.ok) {
      if (err) {
        err.textContent = out.error || t('apiKeys.dialog.error', 'Could not create the key. Please try again.');
        err.classList.remove('hidden');
      }
      busy = false;
      return;
    }

    const form = el('ak-modal-form');
    const reveal = el('ak-modal-reveal');
    const revealed = el('ak-reveal-key');
    // textContent, never innerHTML: the key is opaque, and there is no reason for a
    // credential to travel through an HTML parser.
    if (revealed) revealed.textContent = out.key || '';
    if (form) form.classList.add('hidden');
    if (reveal) reveal.classList.remove('hidden');
    const done = el('ak-done');
    if (done) done.focus();
    busy = false;
  }

  /** Copy the revealed key. */
  async function copy() {
    const revealed = el('ak-reveal-key');
    const btn = el('ak-copy');
    if (!revealed || !revealed.textContent) return;
    try {
      await navigator.clipboard.writeText(revealed.textContent);
      if (btn) {
        btn.textContent = t('apiKeys.dialog.copied', 'Copied');
        setTimeout(() => { btn.textContent = t('apiKeys.dialog.copy', 'Copy'); }, 1600);
      }
    } catch {
      // Clipboard access can be refused outright. The key is on screen and selectable,
      // so say what to do rather than pretending it worked.
      if (btn) btn.textContent = t('apiKeys.dialog.copyFallback', 'Select and copy');
    }
  }

  el('ak-confirm')?.addEventListener('click', () => { void submit(); });
  el('ak-copy')?.addEventListener('click', () => { void copy(); });
  el('ak-cancel')?.addEventListener('click', close);
  el('ak-done')?.addEventListener('click', close);
  el('ak-modal-close')?.addEventListener('click', close);

  // Enter submits from the name field, since it is the only input.
  el('ak-name')?.addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  });

  // Escape closes the FORM half only. Once a key is on screen it is unrecoverable, so
  // dismissing it has to be deliberate.
  document.addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key !== 'Escape') return;
    const modal = el('ak-modal');
    const reveal = el('ak-modal-reveal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (reveal && !reveal.classList.contains('hidden')) return;
    close();
  });

  return { open, close };
}
