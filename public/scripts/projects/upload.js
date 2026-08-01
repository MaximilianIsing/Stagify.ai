// The Listing Studio's photo tray: batch intake (drag-and-drop or file picker),
// client-side validation, the multipart upload with progress, and the thumbnail strip
// where the operator corrects what the auto-clustering guessed.
//
// THE TRAY IS NOT A READ-OUT OF THE CLUSTERING, IT IS AN ARGUMENT WITH IT. Room
// assignment and the hero frame arrive from the backend as a first draft; the
// photographer knows the shoot and the UI must not fight them. So every thumbnail
// carries a room control, a room-type control, and a "Make hero" action, and the hero
// change is applied as a PAIR of patches (promote this frame, demote the one it
// replaced) — `heroPatchesFor` below, which is pure and unit-tested, because a
// half-applied hero swap leaves a room with two heroes or none.
//
// A photo the upload gate rejected is shown with the HUMAN SENTENCE for its rejection
// category, not hidden and not reduced to the raw code. It is still part of the shoot; the
// operator needs to know which frame will have no render and why. The sentence comes from
// ../unstageable-message.js, the same reader both other studios use.
//
// A photo the STAGING RUN will skip is also said out loud, and quietly — an exterior the
// clusterer labelled 'Other', a frame with no room yet, one the operator excluded. Six
// perfectly good photographs that simply will not render is not an error state, but it is
// the difference between "the product handled my shoot" and "the product lost six files".
// See SKIP_NOTICES, which also names the control that undoes each one.
//
// The tray also owns the MULTI-SELECT (./bulk-bar.js): fixing a mis-clustered shoot one
// dropdown at a time was 32 PATCH-plus-full-refresh round trips, and the backend has always
// honoured `frameRole: 'excluded'` even though nothing here offered it.
//
// Assembled with createElement + textContent — no HTML-string sink, so nothing to
// escape here (see ../escape-html.js if you ever add one).

import { photoImagePath } from './api.js';
import {
  ROOM_UNASSIGNED,
  SKIP_REASONS,
  isExcluded,
  isHero,
  isUnstageable,
  photoRoomKey,
  roomLabel,
  skipReasonFor,
} from './state.js';
import { ROOM_TYPES, normalizeRoomType, roomTypeLabel } from './vocab.js';
import { NEW_ROOM_VALUE, mountBulkBar } from './bulk-bar.js';
import {
  MAX_HEIC_CONVERSIONS,
  convertHeic,
  rejectionMessage,
  validateFiles,
} from './intake.js';
import { unstageableMessage } from '../unstageable-message.js';

/**
 * @typedef {import('./state.js').PjPhoto} PjPhoto
 * @typedef {import('./render-grid.js').PjBlobRegistry} PjBlobRegistry
 */

// The intake rules (limits, HEIC conversion, the skipped-files sentence) live in
// ./intake.js and are re-exported here so existing importers keep one entry point.
export {
  ACCEPTED_TYPES,
  MAX_FILE_BYTES,
  MAX_FILE_MB,
  MAX_HEIC_CONVERSIONS,
  MAX_PHOTOS,
  convertHeic,
  dropzoneHint,
  looksHeic,
  nameList,
  rejectionMessage,
  validateFiles,
} from './intake.js';

/** Re-exported so the room-type control and the drift guard read one list. */
export { ROOM_TYPES };

/**
 * The patches that move the hero role to `photoId` within its room.
 *
 * Returned as a list because promoting one frame means demoting the previous hero, and
 * doing only half of that is how a room ends up with two heroes (or, after a failed
 * promote, none). Applying an already-hero photo returns an empty list, so a double
 * click is not two requests.
 * @param {PjPhoto[]} photos - Every photo in the listing.
 * @param {string} photoId - The frame to promote.
 * @returns {Array<{ photoId: string, fields: { frameRole: string } }>}
 */
export function heroPatchesFor(photos, photoId) {
  const target = (photos || []).find((photo) => photo.id === photoId);
  if (!target || isHero(target)) return [];
  const room = photoRoomKey(target);
  /** @type {Array<{ photoId: string, fields: { frameRole: string } }>} */
  const patches = [{ photoId, fields: { frameRole: 'hero' } }];
  for (const photo of photos) {
    if (photo.id !== photoId && photoRoomKey(photo) === room && isHero(photo)) {
      patches.push({ photoId: photo.id, fields: { frameRole: 'support' } });
    }
  }
  return patches;
}

/**
 * The tray's sentence for a skip reason, and WHICH control undoes it.
 *
 * THE FAILURE THIS PREVENTS is an operator uploading 32 photos, watching six of them never
 * render, and concluding the product lost them. Every real shoot carries exteriors — the
 * front elevation, the backyard, the garage — the clusterer labels them 'Other', and the
 * run skips them rather than spending money putting furniture on a driveway. That is the
 * right call and it was completely silent.
 *
 * NOT_A_ROOM IS A DEFAULT, NOT A VERDICT, so its copy names its own undo. The override is
 * the room-type <select> already on the card — the operator does not need a second control,
 * they need to be told that the one in front of them is the answer. `describes` points the
 * note at that control for a screen reader too, so "set a room type below" is not a purely
 * visual instruction.
 *
 * UNSTAGEABLE IS ABSENT ON PURPOSE. The card already carries the upload gate's human
 * sentence for that frame (see `thumbnail`); a second, vaguer line beside it would be a
 * competing message, not a complementary one.
 * @type {Readonly<Record<string, { text: string, describes?: string }>>}
 */
const SKIP_NOTICES = Object.freeze({
  [SKIP_REASONS.NOT_A_ROOM]: {
    text: 'Not staged — this looks like an exterior or other non-room. Set a room type below to stage it.',
    describes: 'type',
  },
  [SKIP_REASONS.NO_ROOM]: {
    text: 'Not staged — no room assigned yet. Pick a room below.',
    describes: 'room',
  },
  [SKIP_REASONS.EXCLUDED]: { text: 'Not staged — excluded from this run.' },
});

/**
 * The tray's note for a skip reason.
 * @param {string|null} reason - A `SKIP_REASONS` code, or null for a frame that stages.
 * @returns {{ text: string, describes?: string }|null} Null when the tray says nothing
 *   extra — a frame that stages, or one the rejection warning already speaks for.
 */
export function skipNotice(reason) {
  return (reason && SKIP_NOTICES[reason]) || null;
}

/**
 * A room key for a brand-new room that does not collide with an existing one.
 * @param {PjPhoto[]} photos
 * @returns {string}
 */
export function nextRoomKey(photos) {
  const used = new Set((photos || []).map(photoRoomKey));
  let index = 1;
  while (used.has(`room-${index}`)) index += 1;
  return `room-${index}`;
}

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
 * Mount the photo tray.
 *
 * @param {{
 *   dropzone: HTMLElement,
 *   fileInput: HTMLInputElement,
 *   tray: HTMLElement,
 *   status: HTMLElement,
 *   bar: HTMLElement,
 *   bulk: HTMLElement,
 *   registry: PjBlobRegistry,
 *   getProjectId: () => string,
 *   getPhotos: () => PjPhoto[],
 *   loadImage: (path: string) => Promise<string>,
 *   upload: (files: File[], onProgress: (fraction: number) => void) => Promise<void>,
 *   onPatch: (photoId: string, fields: Record<string, string|number>) => void,
 *   onBulkPatch: (patches: Array<{ photoId: string, fields: Record<string, string|number> }>) => void,
 *   onRemove: (photoId: string) => void,
 *   notify: (message: string, type?: string) => void,
 * }} deps - The dropzone and its hidden <input type=file>, the thumbnail container,
 *   a live region for counts, the upload progress bar, the multi-select action bar's
 *   container, this tray's OWN object-URL registry (do not share the grid's — see
 *   mountRenderGrid), and the callbacks the entry supplies for uploading, patching and
 *   deleting.
 *
 *   `onBulkPatch` exists separately from `onPatch` so a 30-photo reassignment is ONE
 *   refresh: every single-photo change is a PATCH plus a full `refresh()` plus a full
 *   redraw, and thirty of those in a row rebuilt the tray under the operator's cursor
 *   thirty times.
 * @returns {{ draw: (photos: PjPhoto[]) => void, destroy: () => void }}
 */
export function mountPhotoTray(deps) {
  const {
    dropzone, fileInput, tray, status, bar, bulk, registry,
    getProjectId, getPhotos, loadImage, upload, onPatch, onBulkPatch, onRemove, notify,
  } = deps;

  /** @type {IntersectionObserver|null} */
  let observer = null;
  let busy = false;

  /**
   * The multi-select. Ids rather than photo objects, because every redraw replaces the
   * objects and a selection that pointed at them would silently empty itself.
   * @type {Set<string>}
   */
  const selected = new Set();

  /** @param {Array<{ photoId: string, fields: Record<string, string|number> }>} patches */
  function applyBulk(patches) {
    selected.clear();
    if (patches.length) onBulkPatch(patches);
    else draw(getPhotos());
  }

  const bulkBar = mountBulkBar({
    host: bulk,
    onAssign: (roomKey, ids) => {
      const key = roomKey === NEW_ROOM_VALUE ? nextRoomKey(getPhotos()) : roomKey;
      applyBulk(ids.map((photoId) => ({ photoId, fields: { roomKey: key } })));
    },
    onExclude: (ids) =>
      applyBulk(ids.map((photoId) => ({ photoId, fields: { frameRole: 'excluded' } }))),
    onInclude: (ids) =>
      applyBulk(ids.map((photoId) => ({ photoId, fields: { frameRole: 'support' } }))),
    onClear: () => {
      selected.clear();
      draw(getPhotos());
    },
  });

  /** @param {number} fraction */
  function setProgress(fraction) {
    const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    bar.style.width = `${percent}%`;
    bar.parentElement?.setAttribute('aria-valuenow', String(percent));
  }

  /** @param {File[]|FileList} files */
  async function accept(files) {
    if (busy) {
      notify('An upload is already running.', 'error');
      return;
    }
    if (!getProjectId()) {
      notify('Create or open a listing first.', 'error');
      return;
    }
    // Mark busy BEFORE the HEIC pass: conversion can take seconds, and a second drop
    // landing during it would start a parallel batch.
    busy = true;
    dropzone.classList.add('is-busy');
    /** @type {{ files: File[], converted: number, skipped: number }} */
    let prepared;
    try {
      prepared = await convertHeic(Array.from(files || []));
    } finally {
      busy = false;
      dropzone.classList.remove('is-busy');
    }
    if (prepared.converted) {
      notify(`Converted ${prepared.converted} HEIC photo(s) to JPEG.`);
    }
    if (prepared.skipped) {
      notify(
        `${prepared.skipped} HEIC photo(s) were not converted — only ${MAX_HEIC_CONVERSIONS} per batch. Export the rest as JPEG.`,
        'error'
      );
    }

    const { accepted, rejected } = validateFiles(prepared.files);
    const skipped = rejectionMessage(rejected);
    if (skipped) notify(skipped, 'error');
    if (!accepted.length) return;

    busy = true;
    dropzone.classList.add('is-busy');
    setProgress(0);
    bar.parentElement?.classList.remove('hidden');
    try {
      await upload(accepted, setProgress);
    } finally {
      busy = false;
      dropzone.classList.remove('is-busy');
      setProgress(0);
      bar.parentElement?.classList.add('hidden');
    }
  }

  /** @param {HTMLImageElement} img @param {string} path */
  function fill(img, path) {
    const cached = registry.get(path);
    if (cached) {
      img.src = cached;
      return;
    }
    loadImage(path)
      .then((url) => {
        registry.set(path, url);
        img.src = url;
      })
      .catch(() => {
        // No preview available. Say so rather than leaving a broken image icon —
        // the operator still needs the row for its room and hero controls.
        img.removeAttribute('src');
        img.classList.add('pj-thumb__img--failed');
        img.alt = 'No preview available';
      });
  }

  /**
   * A room <select> listing the rooms already in the listing, plus an explicit
   * "move to a new room" escape hatch. A free-text key would let a typo silently
   * fork a room in two.
   * @param {PjPhoto} photo
   * @param {PjPhoto[]} photos
   */
  function roomControl(photo, photos) {
    const select = /** @type {HTMLSelectElement} */ (el('select', 'pj-thumb__room'));
    select.setAttribute('aria-label', 'Room for this photo');
    const keys = [...new Set(photos.map(photoRoomKey))];
    if (!keys.includes(ROOM_UNASSIGNED)) keys.push(ROOM_UNASSIGNED);
    for (const key of keys) {
      const option = /** @type {HTMLOptionElement} */ (el('option', undefined, roomLabel(key, '')));
      option.value = key;
      select.appendChild(option);
    }
    const fresh = /** @type {HTMLOptionElement} */ (el('option', undefined, 'Move to a new room…'));
    fresh.value = NEW_ROOM_VALUE;
    select.appendChild(fresh);
    select.value = photoRoomKey(photo);
    select.addEventListener('change', () => {
      const value = select.value === NEW_ROOM_VALUE ? nextRoomKey(getPhotos()) : select.value;
      onPatch(photo.id, { roomKey: value });
    });
    return select;
  }

  /**
   * The room-type override.
   *
   * EVERY OPTION'S `value` IS A `promptMatrix` KEY (see ./vocab.js). The values used to be
   * friendly lowercase strings — 'living room', 'bedroom', … — and the server looks the
   * pair up as `promptMatrix[roomType]?.[furnitureStyle]` case-sensitively, so not one of
   * the ten matched and correcting a photo's room made its render WORSE than leaving it
   * wrong. Display text is still friendly; only the value is load-bearing.
   *
   * A stored value that is a near-miss of a real key (an older row, or a hand edit) is
   * normalized onto the key it means, so the dropdown shows the right selection instead of
   * appending a duplicate. A value with no mapping at all is preserved as its own option
   * rather than silently reset — see the last branch.
   * @param {PjPhoto} photo
   */
  function typeControl(photo) {
    const select = /** @type {HTMLSelectElement} */ (el('select', 'pj-thumb__type'));
    select.setAttribute('aria-label', 'Room type for this photo');
    const stored = photo.roomType || '';
    const current = normalizeRoomType(stored) || stored;
    for (const value of ['', ...ROOM_TYPES]) {
      const option = /** @type {HTMLOptionElement} */ (
        el('option', undefined, value ? roomTypeLabel(value) : 'Room type…')
      );
      option.value = value;
      select.appendChild(option);
    }
    if (current && !ROOM_TYPES.includes(current)) {
      const option = /** @type {HTMLOptionElement} */ (el('option', undefined, current));
      option.value = current;
      select.appendChild(option);
    }
    select.value = current;
    select.addEventListener('change', () => onPatch(photo.id, { roomType: select.value }));
    return select;
  }

  /** @param {PjPhoto} photo @param {PjPhoto[]} photos @param {string} projectId */
  function thumbnail(photo, photos, projectId) {
    /** @type {string[]} */
    const classes = ['pj-thumb'];
    if (isUnstageable(photo)) classes.push('is-unstageable');
    if (isExcluded(photo)) classes.push('is-excluded');
    if (selected.has(photo.id)) classes.push('is-selected');
    const card = el('li', classes.join(' '));

    // The multi-select. A plain checkbox rather than click-the-card, so it cannot fight the
    // room/type dropdowns living in the same card.
    const pickLabel = el('label', 'pj-thumb__pick');
    const pick = /** @type {HTMLInputElement} */ (el('input', 'pj-thumb__pick-box'));
    pick.type = 'checkbox';
    pick.checked = selected.has(photo.id);
    pick.addEventListener('change', () => {
      if (pick.checked) selected.add(photo.id);
      else selected.delete(photo.id);
      // Only the bar changes; redrawing the whole tray here would drop the operator's
      // focus out of the checkbox they are tabbing through.
      bulkBar.draw(getPhotos(), selected);
      card.classList.toggle('is-selected', pick.checked);
    });
    pickLabel.appendChild(pick);
    pickLabel.appendChild(el('span', undefined, `Select photo ${photo.seq ?? ''}`.trim()));
    card.appendChild(pickLabel);

    const img = /** @type {HTMLImageElement} */ (el('img', 'pj-thumb__img'));
    img.alt = `Photo ${photo.seq ?? ''}`.trim();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.src = photoImagePath(projectId, photo.id);
    card.appendChild(img);
    if (observer) observer.observe(img);
    else fill(img, String(img.dataset.src));

    if (isHero(photo)) card.appendChild(el('span', 'pj-badge pj-badge--hero', 'Hero'));
    if (isExcluded(photo)) {
      card.appendChild(el('span', 'pj-badge pj-badge--excluded', 'Excluded'));
    }

    if (isUnstageable(photo)) {
      // The HUMAN sentence, not the raw category code. `unstageableMessage` is the shared
      // reader both other studios use: it looks `errors.unstageable.<CODE>` up in the
      // language pack — the sentences already exist in all 11 — and falls back to English.
      // This card used to print "Cannot be staged: PERSON_PORTRAIT" at an estate agent.
      const warning = el('p', 'pj-warning', unstageableMessage({ code: photo.unstageableCode }));
      warning.setAttribute('role', 'status');
      card.appendChild(warning);
    }

    const controls = el('div', 'pj-thumb__controls');
    const room = roomControl(photo, photos);
    const type = typeControl(photo);

    // WHY THIS FRAME WILL NOT RENDER, on the frame itself. `skipReasonFor` mirrors the
    // rule the stage route enqueues by, so the tray and the run agree about which photos
    // are in the shoot but out of the batch.
    //
    // Suppressed for a frame the upload gate rejected — including one that is ALSO
    // unassigned, where the server's first-match order reports NO_ROOM. That frame already
    // has the gate's sentence above; adding "no room assigned yet" beneath it would be a
    // second, weaker explanation of the same outcome.
    const notice = isUnstageable(photo) ? null : skipNotice(skipReasonFor(photo));
    if (notice) {
      const note = el('p', 'pj-skip', notice.text);
      if (notice.describes) {
        // "below" has to mean something without sight. Wire the note to the control that
        // undoes it, so the fix is announced with the control rather than only near it.
        note.id = `pj-skip-${photo.id}`;
        (notice.describes === 'room' ? room : type).setAttribute('aria-describedby', note.id);
      }
      card.appendChild(note);
    }

    controls.appendChild(room);
    controls.appendChild(type);

    const makeHero = /** @type {HTMLButtonElement} */ (
      el('button', 'pj-thumb__action', isHero(photo) ? 'Hero frame' : 'Make hero')
    );
    makeHero.type = 'button';
    makeHero.disabled = isHero(photo);
    makeHero.addEventListener('click', () => {
      for (const patch of heroPatchesFor(getPhotos(), photo.id)) onPatch(patch.photoId, patch.fields);
    });
    controls.appendChild(makeHero);

    const drop = /** @type {HTMLButtonElement} */ (el('button', 'pj-thumb__action', 'Remove'));
    drop.type = 'button';
    drop.addEventListener('click', () => onRemove(photo.id));
    controls.appendChild(drop);

    card.appendChild(controls);
    return card;
  }

  /**
   * Redraw the tray.
   * @param {PjPhoto[]} photos
   */
  function draw(photos) {
    // Same rule as the grid: disconnect before the nodes being watched are detached.
    // Object URLs are RETAINED rather than released — every room override redraws the
    // tray, and releasing them all would re-download the whole shoot on each change.
    if (observer) observer.disconnect();
    tray.textContent = '';
    observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = /** @type {HTMLImageElement} */ (entry.target);
                if (observer) observer.unobserve(img);
                fill(img, String(img.dataset.src || ''));
              }
            },
            { rootMargin: '200px 0px' }
          )
        : null;

    const projectId = getProjectId();
    // A selection cannot outlive the photos it named (a bulk exclude is followed by a
    // refresh, a delete by a shorter list), or the bar would act on ids that are gone.
    const live = new Set(photos.map((photo) => photo.id));
    for (const id of [...selected]) if (!live.has(id)) selected.delete(id);

    const unstageable = photos.filter(isUnstageable).length;
    const excluded = photos.filter(isExcluded).length;
    const unassigned = photos.filter((photo) => photoRoomKey(photo) === ROOM_UNASSIGNED).length;
    /** @type {string[]} */
    const parts = [];
    if (photos.length) {
      parts.push(`${photos.length} photo(s)`);
      if (unstageable) parts.push(`${unstageable} cannot be staged`);
      if (excluded) parts.push(`${excluded} excluded`);
      // SAY IT OUT LOUD. An unassigned photo is dropped from staging server-side
      // (`groupByRoom` skips a photo with no roomKey) and nothing on this page mentioned it,
      // so a shoot could quietly render 24 of its 32 frames.
      if (unassigned) parts.push(`${unassigned} with no room yet — those will NOT be staged`);
    }
    status.textContent = parts.length ? `${parts.join(', ')}.` : 'No photos yet.';

    for (const photo of photos) tray.appendChild(thumbnail(photo, photos, projectId));
    bulkBar.draw(photos, selected);
    registry.retain(photos.map((photo) => photoImagePath(projectId, photo.id)));
  }

  /** @param {DragEvent} event */
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  dropzone.addEventListener('dragover', (event) => {
    swallow(/** @type {DragEvent} */ (event));
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', (event) => {
    const drag = /** @type {DragEvent} */ (event);
    swallow(drag);
    dropzone.classList.remove('is-over');
    if (drag.dataTransfer && drag.dataTransfer.files) accept(drag.dataTransfer.files);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files) accept(fileInput.files);
    // Clear it, or re-picking the same batch fires no change event.
    fileInput.value = '';
  });

  return {
    draw,
    destroy() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      registry.releaseAll();
      tray.textContent = '';
    },
  };
}
