// The Listing Studio's derived SENTENCES and COUNTS: the pre-flight render plan, the
// throttled screen-reader announcements, the blocked-frames line, and the picker row's
// metadata. Pure functions over ./state.js's shapes — no DOM, no network.
//
// Split from ./state.js purely for size (that file is at the 650-line ratchet). The
// division is meaningful, though: ./state.js shapes SERVER DATA into what the UI draws,
// while this file turns that shape into ENGLISH. Everything here is copy a reviewer can
// argue with, which is a good reason for it to sit in one file with its reasoning attached.

import { isProgressComplete, skipReasonFor, SKIP_REASONS } from './state.js';

/**
 * @typedef {import('./state.js').PjPhoto} PjPhoto
 * @typedef {import('./state.js').PjProject} PjProject
 * @typedef {import('./state.js').PjProgress} PjProgress
 */

/** @param {unknown} value @returns {number} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The "these frames will never render" sentence, or '' when there is nothing to say.
 *
 * `progress.blocked` is queued-minus-claimable: frames sitting in the queue that no worker
 * can ever pick up, because the room's look bible never landed. It is the honest signal the
 * page previously threw away, and silence about it is indistinguishable from a clean run —
 * which is why '' means "the server told us zero", and a progress payload with no `blocked`
 * field at all also means '' rather than a fabricated reassurance.
 * @param {PjProgress|null|undefined} progress
 * @returns {string}
 */
export function blockedSummary(progress) {
  const blocked = progress ? num(progress.blocked) : 0;
  if (blocked <= 0) return '';
  return `${blocked} frame(s) can’t be staged — regenerate that room’s look.`;
}

/**
 * Exactly how many renders a Stage press will produce.
 *
 * Mirrors `enqueueRoom` in routes/projects.js rather than approximating it: each room's
 * HERO gets exactly ONE render (it derives the look bible the rest are conditioned on) and
 * every other frame in the room gets `variationCount`.
 *
 * WHICH FRAMES COUNT IS `skipReasonFor`, NOT A LIST REPEATED HERE. This function used to
 * apply two exclusions of its own (no room, excluded) and its comment claimed those were
 * "the same two exclusions `groupByRoom` applies server-side". That stopped being true
 * twice over — `groupByRoom` also drops a frame the upload gate rejected, and one whose
 * roomType is 'Other' (an exterior, which every real shoot has several of). The dialog was
 * therefore quoting a price for renders that were never going to happen: on a 32-photo
 * shoot with six exteriors, six renders that do not exist. Deferring to the shared
 * predicate is what stops it drifting a third time — and that predicate is itself pinned
 * against the server's copy by test/frontend/projects/skip-reasons.test.js.
 *
 * Approximating this with `photos × variations` would over-count by one room's worth of
 * variations per room, which on a 9-room shoot is an 18-render lie in the confirm dialog.
 * @param {PjPhoto[]} photos
 * @param {number} variationCount - 1..3.
 * @returns {{ renders: number, rooms: number, photos: number, unassigned: number, excluded: number, skipped: number }}
 */
export function stagePlan(photos, variationCount) {
  const variations = Math.max(1, Math.min(3, num(variationCount) || 1));
  /** @type {Map<string, number>} */
  const perRoom = new Map();
  let unassigned = 0;
  let excluded = 0;
  let skipped = 0;
  let staged = 0;
  for (const photo of photos || []) {
    const reason = skipReasonFor(photo);
    if (reason) {
      // Still reported separately, because the dialog names the two an operator can act on.
      if (reason === SKIP_REASONS.EXCLUDED) excluded += 1;
      else if (reason === SKIP_REASONS.NO_ROOM) unassigned += 1;
      skipped += 1;
      continue;
    }
    const key = String(photo.roomKey).trim();
    perRoom.set(key, (perRoom.get(key) || 0) + 1);
    staged += 1;
  }
  let renders = 0;
  for (const count of perRoom.values()) renders += 1 + (count - 1) * variations;
  return { renders, rooms: perRoom.size, photos: staged, unassigned, excluded, skipped };
}

/**
 * Wall-clock band for a run of `renders` frames on the one-at-a-time queue, in minutes.
 *
 * A band, not a number, because a render is a generation plus up to two judge passes and
 * the spread is real. Deliberately wide enough to be honest and narrow enough to be a
 * decision: an agent needs to know whether this is a coffee or an afternoon.
 */
export const RENDER_SECONDS_LOW = 40;
/** Upper end of the per-render estimate. See RENDER_SECONDS_LOW. */
export const RENDER_SECONDS_HIGH = 60;

/**
 * The pre-flight sentence for the confirm dialog: how many renders, across how many rooms,
 * and roughly how long. Stage used to fire immediately with none of this, while the far
 * cheaper "remove one photo" got a confirm dialog.
 * @param {{ renders: number, rooms: number, unassigned: number }} plan - From stagePlan.
 * @returns {string}
 */
export function stagePlanSummary(plan) {
  const renders = num(plan && plan.renders);
  const rooms = num(plan && plan.rooms);
  if (renders <= 0) {
    return 'Nothing would be staged: no photo has a room assignment yet.';
  }
  const low = Math.max(1, Math.round((renders * RENDER_SECONDS_LOW) / 60));
  const high = Math.max(low, Math.round((renders * RENDER_SECONDS_HIGH) / 60));
  const time = low === high ? `about ${low} minute(s)` : `roughly ${low}–${high} minutes`;
  const parts = [
    `This will produce ${renders} render(s) across ${rooms} room(s) — ${time}.`,
    'They run one at a time; you can cancel what is still queued.',
  ];
  const unassigned = num(plan && plan.unassigned);
  if (unassigned) {
    parts.push(`${unassigned} photo(s) have no room yet and will NOT be staged.`);
  }
  return parts.join(' ');
}

/**
 * What, if anything, a screen reader should be told about a poll tick.
 *
 * Returns '' for "say nothing", which is the answer for most ticks. The visible counters
 * update regardless; this is only the announcement, and the whole point is that it fires on
 * TRANSITIONS (a run starting, a frame landing, a frame failing, frames becoming
 * unstageable, the queue draining) rather than on the timer. A poll that changed nothing is
 * silent.
 * @param {PjProgress|null|undefined} previous - The progress before this tick.
 * @param {PjProgress|null|undefined} next - The progress after it.
 * @returns {string}
 */
export function progressAnnouncement(previous, next) {
  if (!next) return '';
  const total = num(next.total);
  if (total <= 0) return '';
  const had = previous ? num(previous.total) : 0;
  if (had <= 0) return `Staging started: ${total} frame(s) queued.`;

  if (isProgressComplete(next) && !isProgressComplete(previous)) {
    const failed = num(next.failed);
    const done = num(next.ok);
    return failed
      ? `Staging finished: ${done} of ${total} frame(s) rendered, ${failed} failed.`
      : `Staging finished: all ${done} frame(s) rendered.`;
  }

  /** @type {string[]} */
  const parts = [];
  if (num(next.ok) !== num(previous.ok)) {
    parts.push(`${num(next.ok)} of ${total} frame(s) done`);
  }
  if (num(next.failed) > num(previous.failed)) {
    parts.push(`${num(next.failed)} failed`);
  }
  if (num(next.blocked) > num(previous.blocked)) {
    parts.push(`${num(next.blocked)} blocked on a missing look bible`);
  }
  return parts.length ? `${parts.join(', ')}.` : '';
}

/**
 * The picker row's supporting line: when the listing was made, and how many photos it
 * holds when the server said.
 *
 * `photoCount` is omitted rather than guessed at zero. `GET /api/projects` does not send it
 * today, and a row reading "0 photos" for a full shoot is worse than a row that does not
 * mention photos at all.
 * @param {PjProject} project
 * @returns {string}
 */
export function pickerMeta(project) {
  /** @type {string[]} */
  const parts = [];
  const created = formatDate(project && project.createdAt);
  if (created) parts.push(created);
  const count = project && project.photoCount;
  if (typeof count === 'number' && Number.isFinite(count)) parts.push(`${count} photo(s)`);
  return parts.join(' · ');
}

/**
 * A short local date for a listing timestamp. Accepts epoch ms (what SQLite stores) or an
 * ISO string, and returns '' for anything it cannot parse rather than "Invalid Date".
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(typeof value === 'number' ? value : String(value));
  const time = date.getTime();
  if (!Number.isFinite(time)) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The badge a picker row carries. Derived from the stored status, with 'draft' shown as the
 * plainer "Not staged" — the operator does not think in schema words.
 * @param {PjProject} project
 * @returns {{ text: string, tone: string }} `tone` becomes a CSS modifier suffix.
 */
export function projectBadge(project) {
  const status = project && project.status ? String(project.status) : '';
  if (status === 'staging') return { text: 'Staging', tone: 'running' };
  if (status === 'ready') return { text: 'Ready', tone: 'ready' };
  if (status === 'failed') return { text: 'Failed', tone: 'failed' };
  return { text: 'Not staged', tone: 'draft' };
}
