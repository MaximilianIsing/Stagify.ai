// The Listing Studio's shared store, plus the pure selectors that shape server data
// into what the UI draws. No DOM here at all, which is why the interesting decisions
// in this feature live in this file: grouping, hero ordering, "is the queue drained",
// and "was consistency actually enforced for this room" are all unit-tested without a
// browser (test/frontend/projects-app.test.js).
//
// The typedefs below are the contract the whole feature types against — the same
// `.d.ts`-style idiom as masking-studio/types.d.ts, kept in this .js file because the
// selectors here are its only producer. Fields the server may omit are optional; the
// enum-ish ones (`status`, `frameRole`) stay `string` rather than unions, because they
// arrive from JSON at a dozen sites and a union would fight every construction without
// catching a real bug (same reasoning as lib/types/*.d.ts).

// The one room type that means "not an interior". Imported rather than restated: it is
// also the backend's own label for an exterior, and `skipReasonFor` below compares
// against it exactly the way routes/projects-shared.js does.
import { OTHER_ROOM_TYPE } from './vocab.js';

/**
 * @typedef {object} PjProject
 * @property {string} id
 * @property {string} title
 * @property {string} address
 * @property {string} [status] - 'draft' | 'staging' | 'ready' | …
 * @property {string|number} [createdAt] - Epoch ms from SQLite, or an ISO string.
 * @property {string|number} [updatedAt]
 * @property {number} [photoCount] - Only present when the server sends it; see
 *   `pickerMeta`, which renders the row without it rather than lying about zero.
 */

/**
 * @typedef {object} PjPhoto
 * @property {string} id
 * @property {string} [projectId]
 * @property {string} [storageKey]
 * @property {number} [seq]
 * @property {string} [roomKey] - Auto-clustered, operator-overridable.
 * @property {string} [roomType]
 * @property {string} [frameRole] - 'hero' marks the room's lead frame, 'excluded' keeps
 *   the frame in the shoot but never stages it.
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean|number|null} [stageable] - TRI-STATE. `null`/absent is "not checked
 *   yet"; false/0 is "the gate rejected it"; true/1 passed. It is typed as both a boolean
 *   and a number because the two producers disagree and both are real: the API serializes
 *   `row.stageable === 1` (so the wire carries `false`), while fixtures and older rows
 *   carry the raw 0/1. `isUnstageable` is the only thing that should read it.
 * @property {string|null} [unstageableCode] - Rejection category when not stageable.
 */

/**
 * @typedef {object} PjRender
 * @property {string} id
 * @property {string} photoId
 * @property {string} [bibleId]
 * @property {number} [variation]
 * @property {string} status - queued | running | ok | failed | superseded
 * @property {string} [storageKey]
 * @property {number|null} [qualityScore] - 0..100 (the judges emit `SCORE: <0-100>`).
 * @property {number|null} [consistencyScore] - 0..100, or null for NOT CHECKED — which
 *   the grid must not render the same way it renders a hero frame's "no score of its own".
 * @property {string|null} [errorCode] - 'BIBLE_MISSING' when no worker could ever claim
 *   this row because its room's look bible never landed.
 * @property {{ mismatchedSlots?: string[] }|null} [extra] - Persisted judge detail. The
 *   slot names that drifted from the bible are the ACTUAL explanation for a low
 *   consistency score, so the grid says which pieces they were.
 */

// The bible document shape is NOT re-declared here. It is the server's `DesignBible`,
// and this file used to carry a hand-written copy that had drifted: it typed `palette`
// and `lighting` as `string` where the server sends `Record<string, string>`. Because the
// checker was validating that copy rather than reality, `checkJs` happily approved
// rendering them straight into the DOM — which put a literal "[object Object]" in the
// look-bible panel, in the one place the whole feature shows off what it derived.
//
// Aliasing the canonical type instead makes that class of bug a compile error. The
// frontend cannot import the server's runtime code (it is not served to the browser),
// but a JSDoc *type* import resolves fine under tsconfig.frontend.json, so there is no
// reason for a second copy of the shape to exist.
/** @typedef {import('../../../lib/types/projects.js').BiblePiece} PjBiblePiece */
/** @typedef {import('../../../lib/types/projects.js').DesignBible} PjBibleDoc */

/**
 * @typedef {object} PjBible
 * @property {string} id
 * @property {string} roomKey
 * @property {number} [version]
 * @property {string} [roomType]
 * @property {string} [furnitureStyle]
 * @property {PjBibleDoc} [doc]
 */

/**
 * @typedef {object} PjProgress
 * @property {number} [queued]
 * @property {number} [running]
 * @property {number} [ok]
 * @property {number} [failed]
 * @property {number} [superseded]
 * @property {number} [total]
 * @property {number} [blocked] - The subset of `queued` that NO worker can ever claim
 *   (queued minus claimable). Authoritative and per-listing, unlike the process-global
 *   `blockedByMissingBible` counter it replaced — which no frontend file ever read, so
 *   "never checked" and "checked and clean" were indistinguishable on this page.
 */

/**
 * @typedef {object} PjProjectDetail
 * @property {PjProject} [project]
 * @property {PjPhoto[]} [photos]
 * @property {PjRender[]} [renders]
 * @property {PjBible[]} [bibles]
 * @property {PjProgress} [progress]
 */

/**
 * One photo and the renders derived from it, ordered for display.
 * @typedef {object} PjFrame
 * @property {PjPhoto} photo
 * @property {PjRender[]} renders
 * @property {boolean} isHero
 */

/**
 * One room's worth of the results grid.
 * @typedef {object} PjRoomGroup
 * @property {string} roomKey
 * @property {string} roomType
 * @property {PjBible|null} bible
 * @property {boolean} bibleMissing - True only when renders that actually COMPLETED exist
 *   without a bible. See needsConsistencyWarning.
 * @property {PjFrame[]} frames - Hero first.
 * @property {number} renderCount - Every render, any status.
 * @property {number} okRenderCount - Renders with `status === 'ok'`; the only ones that
 *   prove consistency was or was not enforced.
 * @property {number} blockedCount - Renders stuck with `errorCode === 'BIBLE_MISSING'`,
 *   i.e. frames this room can never produce until its look is regenerated.
 */

/**
 * @typedef {object} PjState
 * @property {PjProject[]} projects
 * @property {PjProject|null} project
 * @property {PjPhoto[]} photos
 * @property {PjRender[]} renders
 * @property {PjBible[]} bibles
 * @property {PjProgress|null} progress
 * @property {boolean} loading
 */

/** Room key used for photos the clustering could not place. */
export const ROOM_UNASSIGNED = '__unassigned';

/** Label for {@link ROOM_UNASSIGNED}. */
export const ROOM_UNASSIGNED_LABEL = 'Unassigned';

/** The `frameRole` that marks a room's lead photo. */
export const HERO_ROLE = 'hero';

/** The `frameRole` that keeps a frame in the shoot but never stages it. */
export const EXCLUDED_ROLE = 'excluded';

/** The `errorCode` a render carries when its room's look bible never landed. */
export const BIBLE_MISSING_CODE = 'BIBLE_MISSING';

/**
 * Display rank for a render's status. LOWER SORTS FIRST.
 *
 * This is the primary key of sortRenders, and it exists because the card shows
 * `renders[0]` — so with variation alone deciding the order, a run where v1 failed and v2
 * came out beautifully rendered the broken "Image unavailable" box, put `Status: failed`
 * under it, and hid the good frame behind a pill the operator had no reason to press.
 * @type {Record<string, number>}
 */
const STATUS_RANK = { ok: 0, running: 1, queued: 2, failed: 3, superseded: 4 };

/** @param {string|undefined} status @returns {number} */
function statusRank(status) {
  const rank = STATUS_RANK[String(status)];
  // An unknown status sorts with the live ones rather than last: it is more likely a new
  // in-flight state than a dead row, and burying it would hide the frame entirely.
  return rank === undefined ? 1 : rank;
}

/** A fresh, empty store state. */
const EMPTY = Object.freeze({
  projects: [],
  project: null,
  photos: [],
  renders: [],
  bibles: [],
  progress: null,
  loading: false,
});

/** @param {unknown} value @returns {number} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The Listing Studio's store: one state object, shallow patches, and subscribers
 * notified after every patch.
 *
 * Deliberately tiny — a `subscribe`/`set` pair rather than a reducer — because the
 * page has exactly one writer per concern and the islands only ever need "redraw
 * from the latest state". Listeners are copied before dispatch so a subscriber that
 * unsubscribes during notification cannot skip its neighbour.
 *
 * @param {Partial<PjState>} [initial]
 * @returns {{
 *   get: () => PjState,
 *   set: (patch: Partial<PjState>) => void,
 *   subscribe: (listener: (state: PjState) => void) => () => void,
 *   reset: () => void,
 * }}
 */
export function makeProjectsStore(initial) {
  /** @type {PjState} */
  let state = { ...EMPTY, ...(initial || {}) };
  /** @type {Set<(state: PjState) => void>} */
  const listeners = new Set();

  const notify = () => {
    for (const listener of [...listeners]) listener(state);
  };

  return {
    get() {
      return state;
    },
    set(patch) {
      state = { ...state, ...patch };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      state = { ...EMPTY, projects: state.projects };
      notify();
    },
  };
}

/**
 * A photo's room, with unplaced photos collected under one synthetic key rather
 * than silently vanishing from the grid.
 * @param {PjPhoto} photo
 * @returns {string}
 */
export function photoRoomKey(photo) {
  const key = photo && typeof photo.roomKey === 'string' ? photo.roomKey.trim() : '';
  return key || ROOM_UNASSIGNED;
}

/** @param {PjPhoto} photo @returns {boolean} */
export function isHero(photo) {
  return !!photo && photo.frameRole === HERO_ROLE;
}

/**
 * Did the upload gate reject this photo?
 *
 * `stageable` is TRI-STATE and arrives in two encodings. The API's `rowToPhoto` serializes
 * `row.stageable === 1`, so the wire carries `false` — while this predicate used to test
 * `=== 0`, which is never true of a boolean. The whole unstageable surface (the amber
 * card, the reason, the "N cannot be staged" count) was therefore dead in production and
 * only ever visible to the fixtures that still used 0/1.
 *
 * `null`/absent stays FALSE on purpose: that is "the pre-check has not run yet", which is
 * not the same claim as "we checked and this cannot be staged".
 * @param {PjPhoto} photo
 * @returns {boolean}
 */
export function isUnstageable(photo) {
  if (!photo) return false;
  const value = photo.stageable;
  if (value === null || value === undefined) return false;
  return value === false || value === 0;
}

/** @param {PjPhoto} photo @returns {boolean} */
export function isExcluded(photo) {
  return !!photo && photo.frameRole === EXCLUDED_ROLE;
}

/**
 * Why a frame will not be staged. The SERVER's codes, restated — `SKIP_REASONS` in
 * routes/projects-shared.js is the original and a route module cannot be imported into a
 * browser bundle. test/frontend/projects/skip-reasons.test.js reads that file and fails if
 * these two lists ever disagree, so this is a mirror rather than a second opinion.
 * @type {Readonly<Record<string, string>>}
 */
export const SKIP_REASONS = Object.freeze({
  NO_ROOM: 'NO_ROOM',
  EXCLUDED: 'EXCLUDED',
  UNSTAGEABLE: 'UNSTAGEABLE',
  NOT_A_ROOM: 'NOT_A_ROOM',
});

/**
 * Why this frame will be skipped by the next staging run, or null when it will be staged.
 *
 * DERIVED FROM THE PHOTO ROW, never sent by the API. The rule is a pure function of four
 * fields the store already holds, so deriving it keeps the tray's verdict and the tray's
 * controls reading the same object: after a room-type PATCH the entry refreshes and
 * redraws, and the badge recomputes with the row it is drawn from. A parallel map threaded
 * through the store could disagree with the rows beside it — which is the one failure this
 * badge exists to prevent, arriving from the other direction. (The server briefly did send
 * one; nothing read it, so it was removed rather than left as surface that looks load-
 * bearing. `skipReasonFor` in routes/projects-shared.js remains the server's own copy, and
 * the two are pinned against each other by test/frontend/projects/skip-reasons.test.js.)
 *
 * The ORDER is part of the contract, not an implementation detail: a frame with no room
 * that is also excluded reports NO_ROOM, exactly as the server does, so the two answers
 * are comparable frame-by-frame.
 *
 * `isUnstageable` rather than `stageable === false` on purpose — it is the tri-state
 * reader, and it also understands the legacy 0/1 encoding the wire no longer uses.
 * @param {PjPhoto} photo - A photo row as the API serialized it.
 * @returns {string|null} A {@link SKIP_REASONS} code, or null when the frame stages.
 */
export function skipReasonFor(photo) {
  if (!photo) return SKIP_REASONS.NO_ROOM;
  if (!photo.roomKey) return SKIP_REASONS.NO_ROOM;
  if (isExcluded(photo)) return SKIP_REASONS.EXCLUDED;
  if (isUnstageable(photo)) return SKIP_REASONS.UNSTAGEABLE;
  if (String(photo.roomType || '') === OTHER_ROOM_TYPE) return SKIP_REASONS.NOT_A_ROOM;
  return null;
}

/**
 * A room label for display. Falls back through roomType, then the raw key, so a
 * room never renders as an empty heading.
 * @param {string} roomKey
 * @param {string} [roomType]
 * @returns {string}
 */
export function roomLabel(roomKey, roomType) {
  if (roomKey === ROOM_UNASSIGNED) return ROOM_UNASSIGNED_LABEL;
  const type = typeof roomType === 'string' ? roomType.trim() : '';
  if (type) return type;
  return roomKey || ROOM_UNASSIGNED_LABEL;
}

/**
 * Hero first, then by `seq`, then by id.
 *
 * The hero rule is a sort key rather than a filter-and-prepend because a room can
 * legitimately have NO hero (nothing has been marked yet) and — while an override is
 * in flight, or if the backend ever disagrees with itself — more than one. Both cases
 * must produce a stable order instead of dropping or duplicating a frame.
 * @param {PjPhoto[]} photos
 * @returns {PjPhoto[]} A new array; the input is not mutated.
 */
export function sortRoomPhotos(photos) {
  return [...(photos || [])].sort((a, b) => {
    if (isHero(a) !== isHero(b)) return isHero(a) ? -1 : 1;
    const bySeq = num(a.seq) - num(b.seq);
    if (bySeq !== 0) return bySeq;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Renders for display: BEST STATUS FIRST, then variation order, then id.
 *
 * The status rank is the primary key and that is the point. The frame card shows
 * `renders[0]` and offers the rest as pills, so whatever lands first is what the operator
 * is told the frame looks like. Ordering by variation alone meant a run whose v1 failed and
 * whose v2 was perfect showed the failure — and after a regenerate, which one showed was
 * decided by a random hex id. `ok` before `failed` before `superseded` (see STATUS_RANK)
 * makes the card show the best thing the room actually produced.
 *
 * Variation order is kept as the secondary key so two good renders still read v1, v2.
 * @param {PjRender[]} renders
 * @returns {PjRender[]}
 */
export function sortRenders(renders) {
  return [...(renders || [])].sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    const byVariation = num(a.variation) - num(b.variation);
    if (byVariation !== 0) return byVariation;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Whether a room's renders went out WITHOUT a look bible conditioning them.
 *
 * This is the honest-banner decision. The backend reports a missing bible rather than
 * silently rendering unconditioned frames, and the UI must not paper over it — but the
 * warning only means something once frames exist. A room that simply has not been
 * staged yet has no bible and no renders, and warning there would train the operator
 * to ignore the banner.
 *
 * IT COUNTS COMPLETED RENDERS, NOT QUEUED ONES. `renderCount` includes `queued` and
 * `running`, so gating on it made every room in the listing show the loud red "Consistency
 * was not enforced for this room." the instant Stage was pressed — for a run that had
 * produced nothing at all and whose bibles were still being derived. That is the exact
 * training-to-ignore outcome the paragraph above warns about, delivered by the banner
 * itself. A room warns only once it has an `ok` render with no bible behind it, which is
 * the genuinely dishonest state: finished frames nothing conditioned.
 * @param {{ bible: PjBible|null, okRenderCount?: number }} group
 * @returns {boolean}
 */
export function needsConsistencyWarning(group) {
  return !!group && !group.bible && num(group.okRenderCount) > 0;
}

/**
 * Shape photos + renders + bibles into the results grid: one entry per room, hero
 * frame first, each frame carrying its own renders.
 *
 * Rooms are ordered by their lowest photo `seq` so the grid follows the shoot order
 * rather than object-key order, with the unassigned bucket pinned last — it is a
 * to-do list, not a room.
 * @param {PjPhoto[]} photos
 * @param {PjRender[]} renders
 * @param {PjBible[]} [bibles]
 * @returns {PjRoomGroup[]}
 */
export function groupByRoom(photos, renders, bibles) {
  /** @type {Map<string, PjRender[]>} */
  const byPhoto = new Map();
  for (const render of renders || []) {
    const list = byPhoto.get(render.photoId);
    if (list) list.push(render);
    else byPhoto.set(render.photoId, [render]);
  }

  /** @type {Map<string, PjBible>} */
  const bibleByRoom = new Map();
  for (const bible of bibles || []) {
    const current = bibleByRoom.get(bible.roomKey);
    // Highest version wins, so a regenerated look replaces the one it superseded.
    if (!current || num(bible.version) >= num(current.version)) bibleByRoom.set(bible.roomKey, bible);
  }

  /** @type {Map<string, PjPhoto[]>} */
  const roomPhotos = new Map();
  for (const photo of photos || []) {
    const key = photoRoomKey(photo);
    const list = roomPhotos.get(key);
    if (list) list.push(photo);
    else roomPhotos.set(key, [photo]);
  }

  /** @type {PjRoomGroup[]} */
  const groups = [];
  for (const [roomKey, group] of roomPhotos) {
    const ordered = sortRoomPhotos(group);
    /** @type {PjFrame[]} */
    const frames = ordered.map((photo, index) => ({
      photo,
      renders: sortRenders(byPhoto.get(photo.id) || []),
      // The lead frame is the first after sorting — which is the marked hero when
      // there is one, and the earliest frame when there is not.
      isHero: index === 0,
    }));
    const allRenders = frames.flatMap((frame) => frame.renders);
    const renderCount = allRenders.length;
    const okRenderCount = allRenders.filter((render) => render.status === 'ok').length;
    const blockedCount = allRenders.filter(
      (render) => render.errorCode === BIBLE_MISSING_CODE
    ).length;
    const bible = bibleByRoom.get(roomKey) || null;
    const typed = ordered.find((photo) => !!photo.roomType);
    const roomType = (typed && typed.roomType) || '';
    groups.push({
      roomKey,
      roomType,
      bible,
      bibleMissing: needsConsistencyWarning({ bible, okRenderCount }),
      frames,
      renderCount,
      okRenderCount,
      blockedCount,
    });
  }

  const orderOf = (group) =>
    group.roomKey === ROOM_UNASSIGNED
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...group.frames.map((frame) => num(frame.photo.seq)));

  return groups.sort((a, b) => {
    const byOrder = orderOf(a) - orderOf(b);
    if (byOrder !== 0) return byOrder;
    return a.roomKey.localeCompare(b.roomKey);
  });
}

/**
 * Rooms whose renders were produced without a bible — the set the banner covers.
 * @param {PjRoomGroup[]} groups
 * @returns {string[]}
 */
export function roomsMissingBible(groups) {
  return (groups || []).filter((group) => group.bibleMissing).map((group) => group.roomKey);
}

/**
 * Whether the staging queue has drained.
 *
 * Both halves matter. `queued + running === 0` alone is TRUE for a project that has
 * not started yet, which would stop the poller on its very first tick — before the
 * backend has enqueued anything — and leave the operator staring at an idle page. So
 * completion also requires the queue to be known non-empty (`total > 0`). The caller
 * bounds the not-yet-started case with an attempt limit rather than polling forever.
 * @param {PjProgress|null|undefined} progress
 * @returns {boolean}
 */
export function isProgressComplete(progress) {
  if (!progress) return false;
  const pending = num(progress.queued) + num(progress.running);
  return pending === 0 && num(progress.total) > 0;
}

/**
 * How far through the queue we are, 0..100. Superseded frames count as settled —
 * they are finished work, just no longer current.
 * @param {PjProgress|null|undefined} progress
 * @returns {number}
 */
export function progressPercent(progress) {
  if (!progress) return 0;
  const total = num(progress.total);
  if (total <= 0) return 0;
  const settled = num(progress.ok) + num(progress.failed) + num(progress.superseded);
  return Math.max(0, Math.min(100, Math.round((settled / total) * 100)));
}

/**
 * A one-line summary of the counters, for the visible progress line.
 *
 * NOT a live region any more. It is rewritten on every 2.5s poll tick, and with
 * `aria-live="polite"` on it a screen-reader user heard the full counts read out
 * continuously for the whole run — 45 minutes to two hours of it. The throttled
 * announcements come from `progressAnnouncement` instead, into a separate region.
 * @param {PjProgress|null|undefined} progress
 * @returns {string}
 */
export function progressSummary(progress) {
  if (!progress) return 'No staging run yet.';
  return [
    `${num(progress.ok)} done`,
    `${num(progress.running)} running`,
    `${num(progress.queued)} queued`,
    `${num(progress.failed)} failed`,
  ].join(' · ');
}
