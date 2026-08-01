// The Listing Studio's one confirm dialog, extracted from the entry so its keyboard and
// focus behaviour can be read (and tested) in one place.
//
// THREE THINGS IT DOES THAT THE INLINE VERSION DID NOT:
//
//  1. FOCUS GOES BACK WHERE IT CAME FROM. The old `ask()` focused the confirm button and
//     `closeConfirm()` restored focus nowhere, so every dismissal dropped focus onto
//     <body>. A keyboard operator correcting 32 photos was sent back to the top of the
//     document 32 times. The element that opened the dialog is captured on open and
//     refocused on close.
//  2. TAB IS TRAPPED. `aria-modal="true"` is a promise to assistive tech, not an
//     enforcement: without a trap, Tab walks out of the card into the page behind it, which
//     is still fully interactive.
//  3. THE PENDING ACTION IS CLEARED BY CLOSE, ALWAYS. Preserved from the original, and the
//     reason confirm-after-cancel cannot fire a stale action.
//
// Deliberately NOT a <dialog> element: the page's other modal (#pj-gate) is a div with
// role/aria-modal and the CSS gate keys off `.is-open`, and mixing the two idioms in one
// feature is how one of them ends up untested. If this page ever moves to <dialog>, both
// move together.

/**
 * @typedef {object} PjDialog
 * @property {(heading: string, body: string, confirmLabel: string, action: () => void) => void} ask
 * @property {() => void} close
 */

/**
 * Wire the confirm dialog.
 * @param {{
 *   root: HTMLElement,
 *   title: HTMLElement,
 *   body: HTMLElement,
 *   yes: HTMLButtonElement,
 *   no: HTMLButtonElement,
 * }} els - The dialog root and the four nodes inside it that carry copy or take a click.
 * @returns {PjDialog}
 */
export function mountConfirmDialog(els) {
  const { root, title, body, yes, no } = els;

  /** @type {(() => void)|null} */
  let pendingAction = null;
  /** @type {{ focus?: () => void }|null} */
  let returnFocusTo = null;

  function close() {
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    pendingAction = null;
    const target = returnFocusTo;
    returnFocusTo = null;
    // Restoring focus is best-effort: the element that opened the dialog may itself have
    // been redrawn away by the action (a thumbnail's Remove button removes the thumbnail).
    // Landing on <body> in that case is the old behaviour, not a regression — but it must
    // be the exception, not every close.
    if (target && typeof target.focus === 'function') {
      try {
        target.focus();
      } catch (e) { /* detached node — nothing to restore to */ }
    }
  }

  /**
   * @param {string} heading
   * @param {string} text
   * @param {string} confirmLabel
   * @param {() => void} action
   */
  function ask(heading, text, confirmLabel, action) {
    const active = /** @type {any} */ (document).activeElement;
    // Never "restore" onto the dialog's own buttons: a second ask() opened from inside the
    // dialog would otherwise make close() focus a hidden node.
    returnFocusTo = active && active !== yes && active !== no && active !== root ? active : null;
    title.textContent = heading;
    body.textContent = text;
    yes.textContent = confirmLabel;
    pendingAction = action;
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    yes.focus();
  }

  yes.addEventListener('click', () => {
    const action = pendingAction;
    close();
    if (action) action();
  });
  no.addEventListener('click', close);

  root.addEventListener('keydown', (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === 'Escape') {
      close();
      return;
    }
    if (key !== 'Tab') return;
    // Two focusables, so the trap is a two-element cycle rather than a queried tab order.
    // If a third control is ever added to the card, extend this list — do not fall back to
    // querySelectorAll, which would happily include a disabled or hidden node.
    const shift = !!(/** @type {KeyboardEvent} */ (event).shiftKey);
    const active = /** @type {any} */ (document).activeElement;
    event.preventDefault();
    if (shift) (active === no ? yes : no).focus();
    else (active === yes ? no : yes).focus();
  });

  return { ask, close };
}
