// The photo tray's multi-select action bar: assign a whole selection to one room, exclude
// it from staging, or put it back.
//
// WHY IT EXISTS. Fixing a 32-photo shoot's clustering used to be 32 separate dropdown
// changes, and each one was a PATCH followed by a full `refresh()` and a full redraw — so
// the tray the operator was working in was rebuilt under their cursor between every change.
// There was also no exclude control at all, even though the backend has honoured
// `frameRole: 'excluded'` since the route was written (`groupByRoom` in routes/projects.js
// skips those frames), which meant the only way to keep a frame out of a run was to delete
// the photo.
//
// THE BAR IS EMPTY-BY-DEFAULT AND SAYS SO. It appears only when something is selected, and
// its label always names the count — a bulk action taken against a selection the operator
// has forgotten about is the failure mode here, and the count is the guard against it.
//
// createElement + textContent only; no HTML-string sink, nothing to escape.

import { ROOM_UNASSIGNED, photoRoomKey, roomLabel } from './state.js';

/**
 * @typedef {import('./state.js').PjPhoto} PjPhoto
 */

/** Sentinel option value for "put these in a brand-new room". */
export const NEW_ROOM_VALUE = '__new';

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The room options a bulk assign offers: every room already in the shoot, the unassigned
 * bucket, and a new room. Exported because it is the same list the per-photo control shows
 * and the two must not drift.
 * @param {PjPhoto[]} photos
 * @returns {string[]} Room keys, with NEW_ROOM_VALUE last.
 */
export function roomOptionKeys(photos) {
  const keys = [...new Set((photos || []).map(photoRoomKey))];
  if (!keys.includes(ROOM_UNASSIGNED)) keys.push(ROOM_UNASSIGNED);
  keys.push(NEW_ROOM_VALUE);
  return keys;
}

/**
 * Mount the bulk bar.
 *
 * @param {{
 *   host: HTMLElement,
 *   onAssign: (roomKey: string, ids: string[]) => void,
 *   onExclude: (ids: string[]) => void,
 *   onInclude: (ids: string[]) => void,
 *   onClear: () => void,
 * }} deps - The container the bar is drawn into, and the four actions. Each action
 *   receives the CURRENT selection as an array, so a handler can batch its PATCHes and
 *   refresh once rather than once per photo.
 * @returns {{ draw: (photos: PjPhoto[], selected: Set<string>) => void }}
 */
export function mountBulkBar(deps) {
  const { host, onAssign, onExclude, onInclude, onClear } = deps;

  /**
   * @param {PjPhoto[]} photos
   * @param {Set<string>} selected
   */
  function draw(photos, selected) {
    host.textContent = '';
    const ids = [...selected];
    host.classList.toggle('hidden', ids.length === 0);
    if (!ids.length) return;

    host.appendChild(el('p', 'pj-bulk__count', `${ids.length} photo(s) selected`));

    const assign = el('div', 'pj-bulk__group');
    const select = /** @type {HTMLSelectElement} */ (el('select', 'pj-bulk__room'));
    select.setAttribute('aria-label', 'Room to assign the selected photos to');
    for (const key of roomOptionKeys(photos)) {
      const option = /** @type {HTMLOptionElement} */ (
        el('option', undefined, key === NEW_ROOM_VALUE ? 'A new room…' : roomLabel(key, ''))
      );
      option.value = key;
      select.appendChild(option);
    }
    const apply = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-secondary pj-bulk__btn', 'Assign selected to…')
    );
    apply.type = 'button';
    apply.addEventListener('click', () => onAssign(select.value, ids));
    assign.appendChild(select);
    assign.appendChild(apply);
    host.appendChild(assign);

    const exclude = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-ghost pj-bulk__btn', 'Exclude selected')
    );
    exclude.type = 'button';
    exclude.title = 'Keep these photos in the shoot but never stage them.';
    exclude.addEventListener('click', () => onExclude(ids));
    host.appendChild(exclude);

    const include = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-ghost pj-bulk__btn', 'Include selected')
    );
    include.type = 'button';
    include.title = 'Undo an exclusion — stage these photos again.';
    include.addEventListener('click', () => onInclude(ids));
    host.appendChild(include);

    const clear = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-ghost pj-bulk__btn', 'Clear selection')
    );
    clear.type = 'button';
    clear.addEventListener('click', onClear);
    host.appendChild(clear);
  }

  return { draw };
}
