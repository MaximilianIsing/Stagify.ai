// The detail panel's rename control.
//
// Extracted from gallery-app.js when that file reached its 650-line ceiling. It is a
// self-contained two-mode widget — a trigger, or a row with a box and two buttons — and
// the only thing the page needs back from it is which of those two modes is on screen, so
// the Tab trap can include the right controls.
//
// WHY `controls()` EXISTS RATHER THAN A QUERY
// `hidden` on the row does NOT set `.hidden` on the input and buttons inside it, so the
// panel's trap cannot decide membership by filtering per node — it would keep three
// off-screen controls in the cycle, and that trap calls focus() explicitly after
// preventDefault(), so Tab would land on something invisible rather than skipping it.
// This module knows which mode it is in, so it answers the question directly.
//
// Everything is addressed BY ID, because the specs drive a document stand-in that has
// getElementById and no querySelectorAll.

/**
 * Build the rename control.
 *
 * @param {{
 *   byId: (id: string) => any,
 *   t: (key: string, fallback: string, vars?: Record<string, any>) => string,
 *   renameRender: (id: string, name: string, fetchImpl?: typeof fetch) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 *   defaultName: (entry: any) => string,
 *   entryName: (entry: any) => string,
 *   currentEntry: () => any,
 *   onRenamed: () => void,
 * }} deps - `currentEntry` is read per call rather than captured, because the panel is
 *   reused for every card. `onRenamed` rebuilds the grid; this module must not know a grid
 *   exists.
 * @returns {{ open: () => void, close: (arg?: { status?: string }) => void,
 *   isOpen: () => boolean, controls: () => any[], save: () => Promise<void>,
 *   bind: () => void }}
 */
export function createRenameRow(deps) {
  const { byId, t, renameRender, fetchImpl, defaultName, entryName, currentEntry, onRenamed } = deps;

  /** @param {string} text */
  const status = (text) => {
    const node = byId('gal-rename-status');
    if (node) node.textContent = text;
  };

  const isOpen = () => !(/** @type {any} */ (byId('gal-rename-row'))?.hidden ?? true);

  /**
   * Put the control back to "not editing".
   *
   * Called on open and on cancel as well as after a save, so no combination of leaving a
   * panel mid-edit and opening another can show one render's name over another's photo.
   * @param {{ status?: string }} [arg] - Wording to leave behind; cleared by default.
   */
  function close({ status: leave = '' } = {}) {
    const row = /** @type {any} */ (byId('gal-rename-row'));
    const trigger = /** @type {any} */ (byId('gal-rename'));
    if (row) row.hidden = true;
    if (trigger) {
      trigger.hidden = false;
      trigger.setAttribute('aria-expanded', 'false');
    }
    status(leave);
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
  function open() {
    const current = currentEntry();
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
    status('');
  }

  /**
   * Send the typed name and repaint everything that shows it.
   *
   * The name that lands on the entry is the SERVER's, not the box's: the store trims and
   * clamps, so painting what was typed would show a name the next page load contradicts.
   */
  async function save() {
    const current = currentEntry();
    if (!current) return;
    const input = /** @type {any} */ (byId('gal-rename-input'));
    const typed = String(input?.value ?? '');
    status(t('gallery.rename.saving', 'Saving…'));
    const res = await renameRender(current.id, typed, fetchImpl);
    if (!res.ok) {
      status(t('gallery.rename.failed', 'Could not save that name. Try again.'));
      return;
    }
    current.name = String(res.body?.name ?? '');
    const title = byId('gal-detail-title');
    if (title) title.textContent = entryName(current);
    // The card behind the panel carries the name too, so it has to be rebuilt — its alt
    // text and aria-label are built from the same string.
    onRenamed();
    close({
      status: current.name
        ? t('gallery.rename.saved', 'Name saved.')
        : t('gallery.rename.cleared', 'Back to the default name.'),
    });
    const trigger = byId('gal-rename');
    if (trigger) trigger.focus();
  }

  /**
   * The controls this widget contributes to the panel's Tab cycle, in DOM order.
   *
   * Two modes, never a mix. The caller filters out anything `hidden` afterwards, which is
   * what removes the trigger while the row is open.
   */
  const controls = () => (isOpen()
    ? [byId('gal-rename-input'), byId('gal-rename-save'), byId('gal-rename-cancel')]
    : [byId('gal-rename')]);

  /** Wire the four listeners. Separate from construction so the caller controls ordering. */
  function bind() {
    byId('gal-rename')?.addEventListener('click', open);
    byId('gal-rename-cancel')?.addEventListener('click', () => {
      close();
      const trigger = byId('gal-rename');
      if (trigger) trigger.focus();
    });
    // Returns the promise so a caller can await the save rather than race it, exactly as
    // the retry button does.
    byId('gal-rename-save')?.addEventListener('click', () => save());
    byId('gal-rename-input')?.addEventListener('keydown', (event) => {
      // Enter commits. The row is not a <form> — it sits inside no form on this page — so
      // without this the key does nothing and the box looks broken.
      if (/** @type {any} */ (event).key !== 'Enter') return;
      /** @type {any} */ (event).preventDefault?.();
      return save();
    });
  }

  return { open, close, isOpen, controls, save, bind };
}
