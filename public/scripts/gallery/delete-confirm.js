// The detail panel's two-step delete.
//
// WHY THIS IS TWO STEPS AND NOTHING ELSE ON THE PANEL IS
// Deleting a render is irreversible in a way nothing else here is: it tombstones the bytes
// AND revokes the link the owner has already sent to a client, so the person who loses
// something is not necessarily the person who clicked. Rename can be typed again; a
// deleted render is gone. That asymmetry is the whole reason for the extra press.
//
// It arms a row rather than calling window.confirm because the specs drive a document
// stand-in with no window dialogs, and a native prompt can be neither styled nor
// translated — the one destructive question on the page would be the one asked in the
// browser's language instead of the reader's.
//
// FOCUS LANDS ON CANCEL, NOT ON CONFIRM. A held Enter, or a second click arriving where
// the first button used to be, must not walk straight through the confirmation it just
// opened.

/**
 * Build the delete control.
 *
 * @param {{
 *   byId: (id: string) => any,
 *   t: (key: string, fallback: string, vars?: Record<string, any>) => string,
 *   deleteRender: (id: string, fetchImpl?: typeof fetch) => Promise<{ ok: boolean }>,
 *   fetchImpl?: typeof fetch,
 *   currentEntry: () => any,
 *   onDeleted: (id: string) => void,
 * }} deps - `currentEntry` is read per call, because the panel is reused for every card.
 *   `onDeleted` is handed the id that is now gone; this module does not know what a grid
 *   or a page count is.
 * @returns {{ arm: () => void, reset: () => void, isArmed: () => boolean,
 *   controls: () => any[], confirm: () => Promise<void>, bind: () => void }}
 */
export function createDeleteConfirm(deps) {
  const { byId, t, deleteRender, fetchImpl, currentEntry, onDeleted } = deps;

  /**
   * Guards re-entry while a delete is in flight.
   *
   * Module-local rather than read off the button's `disabled`, because the two answer
   * different questions: `disabled` is what the user can see, this is whether a request
   * has already gone. A double click on a slow connection must send one DELETE, not two —
   * the second would 404 against the render the first just removed and report a failure
   * for an operation that succeeded.
   */
  let busy = false;

  /** @param {string} text */
  const status = (text) => {
    const node = byId('gal-delete-status');
    if (node) node.textContent = text;
  };

  const isArmed = () => !(/** @type {any} */ (byId('gal-delete-confirm'))?.hidden ?? true);

  /** @param {boolean} on */
  function setDisabled(on) {
    for (const id of ['gal-delete-yes', 'gal-delete-cancel']) {
      const node = /** @type {any} */ (byId(id));
      if (node) node.disabled = on;
    }
  }

  /** Back to a single button. Also called when the panel opens, so an armed confirm can
   * never carry over from the previous render. */
  function reset() {
    const row = /** @type {any} */ (byId('gal-delete-confirm'));
    const trigger = /** @type {any} */ (byId('gal-delete'));
    if (row) row.hidden = true;
    if (trigger) {
      trigger.hidden = false;
      trigger.setAttribute('aria-expanded', 'false');
    }
    busy = false;
    setDisabled(false);
    status('');
  }

  /** Show the confirmation. */
  function arm() {
    if (!currentEntry()) return;
    const row = /** @type {any} */ (byId('gal-delete-confirm'));
    const trigger = /** @type {any} */ (byId('gal-delete'));
    if (row) row.hidden = false;
    if (trigger) {
      trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'true');
    }
    busy = false;
    setDisabled(false);
    status('');
    // Cancel, deliberately — see the header.
    const cancel = /** @type {any} */ (byId('gal-delete-cancel'));
    if (cancel && typeof cancel.focus === 'function') cancel.focus();
  }

  /**
   * Actually delete.
   *
   * On failure the panel stays open and re-enabled: the render is still there, and closing
   * would leave the owner with no way back to the thing they were trying to remove.
   */
  async function confirm() {
    const current = currentEntry();
    if (!current || busy) return;
    busy = true;
    setDisabled(true);
    status(t('gallery.delete.busy', 'Deleting…'));
    const id = current.id;
    const res = await deleteRender(id, fetchImpl);
    if (!res.ok) {
      busy = false;
      setDisabled(false);
      status(t('gallery.delete.failed', 'Could not delete this render.'));
      return;
    }
    onDeleted(id);
  }

  /**
   * What this widget contributes to the panel's Tab cycle.
   *
   * Nothing while closed — the trigger is `#gal-delete`, which the panel lists itself and
   * which its own `.hidden` filter removes once armed.
   */
  const controls = () => (isArmed()
    ? [byId('gal-delete-yes'), byId('gal-delete-cancel')]
    : []);

  /** Wire the three listeners. */
  function bind() {
    byId('gal-delete')?.addEventListener('click', arm);
    byId('gal-delete-cancel')?.addEventListener('click', () => {
      reset();
      const trigger = byId('gal-delete');
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    });
    // Returns the promise so a spec can await the delete rather than race it.
    byId('gal-delete-yes')?.addEventListener('click', () => confirm());
  }

  return { arm, reset, isArmed, controls, confirm, bind };
}
