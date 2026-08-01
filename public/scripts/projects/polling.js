// The Listing Studio's progress poller — the loop that watches a staging run drain.
//
// WHY IT IS ITS OWN MODULE
// It was inline in projects-app.js, which reached the 650-line lint cap exactly; the repo's
// rule is to split rather than raise (see eslint.config.js), and this is the most cohesive
// thing in that file — a timer, a bounded retry, one live-region announcement, and the two
// listeners that stop it. Everything else there is wiring.
//
// THREE PIECES OF HARD-WON BEHAVIOUR LIVE HERE. Each one was a real loop or a real silence:
//
//   1. `shouldWatch` keys on the PROGRESS COUNTERS, not on `project.status`. The backend
//      only moves a listing off 'staging' when the worker next ticks, so a finished run
//      still reports "staging" for a moment. Polling on the status alone restarts the
//      poller for a finished run, which completes, refreshes, restarts… and re-reads the
//      listing every 2.5s for the life of the tab.
//   2. The tick that watches the queue drain is THE AUTHORITY, and stops the poller AFTER
//      its own refresh. The refresh can re-arm the poller off a `status` the backend has
//      not caught up on yet; that final `stop()` is what closes the loop.
//   3. `MAX_EMPTY_POLLS` exists because `isProgressComplete` deliberately refuses to call an
//      empty queue complete. Without a bound, "staging was accepted but nothing ever
//      appeared" polls forever — and it is also what turns a real outage into one error
//      instead of an infinite quiet retry.
//
// The announcement is computed BEFORE the store update, because it is a DIFF against the
// previous progress and the draw that follows would otherwise have already overwritten what
// it diffs against. That is why `seed()` exists: opening a listing has to establish the
// baseline without announcing anything, or every open would read the whole queue aloud.

import { isProgressComplete } from './state.js';
import { progressAnnouncement } from './summaries.js';
import { showToast, showErrorToast } from '../toast.js';

/** @typedef {import('./state.js').PjProgress} PjProgress */
/** @typedef {import('./state.js').PjProject} PjProject */
/** @typedef {import('./state.js').PjState} PjState */

/** How often the progress endpoint is polled while a run is in flight. */
export const POLL_INTERVAL_MS = 2500;

/**
 * How many consecutive "nothing queued yet" polls to tolerate before giving up.
 *
 * `isProgressComplete` deliberately refuses to call an empty queue complete (see its
 * header), so something has to bound the case where staging was accepted but nothing
 * ever appears — otherwise the poller runs for the life of the tab.
 */
export const MAX_EMPTY_POLLS = 12;

/**
 * Whether a listing still needs watching.
 *
 * Both conditions are load-bearing, and the second is the one that is easy to drop: see
 * note 1 in the header for the tab-lifetime loop that leaving it out produces.
 * @param {PjProject|null} project - The open listing.
 * @param {PjProgress|null} progress - Its latest counters.
 * @returns {boolean} True while a run is genuinely in flight.
 */
export const shouldWatch = (project, progress) =>
  !!project && project.status === 'staging' && !isProgressComplete(progress);

/**
 * @typedef {Object} PollerDeps
 * @property {{ get: () => PjState, set: (patch: Partial<PjState>) => void }} store The studio's shared store.
 * @property {() => string} projectId The open listing's id, or '' when none is open.
 * @property {(id: string) => Promise<{ progress: PjProgress, status: string }>} fetchProgress The progress endpoint.
 * @property {(error: unknown) => void} reportError The studio's error surface.
 * @property {() => Promise<void>} refresh Re-read the open listing.
 * @property {{ textContent: string }} progressLive The polite live region announcements are written to.
 */

/**
 * Start watching progress for the open listing.
 *
 * Returns handles rather than running on construction: opening a listing decides whether to
 * watch at all (`shouldWatch`), and several controls stop it explicitly.
 * @param {PollerDeps} deps - Store, id accessor, fetcher, error surface, refresher and live region.
 * @returns {{ start: () => void, stop: () => void, seed: (progress: PjProgress|null) => void }}
 *   `seed` establishes the announcement baseline without announcing.
 */
export function mountProgressPoller(deps) {
  const { store, projectId, fetchProgress, reportError, refresh, progressLive } = deps;

  let pollTimer = 0;
  let emptyPolls = 0;
  /** The progress a previous tick reported, so announcements fire on TRANSITIONS only. */
  /** @type {PjProgress|null} */
  let announced = null;

  /** @returns {void} */
  function stop() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  /** @returns {void} */
  function schedule() {
    stop();
    pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
  }

  /** @returns {void} */
  function start() {
    emptyPolls = 0;
    schedule();
  }

  /** @param {PjProgress|null} progress - The baseline to diff future ticks against. @returns {void} */
  function seed(progress) {
    announced = progress;
  }

  /** One poll. Never throws — a rejection here would be an unhandled rejection in a timer. */
  async function tick() {
    pollTimer = 0;
    const id = projectId();
    if (!id) return;
    /** @type {{ progress: PjProgress, status: string }} */
    let result;
    try {
      result = await fetchProgress(id);
    } catch (error) {
      // A transient failure must not kill the poll — the run is still going. A real
      // outage stops it via the empty-poll bound below.
      emptyPolls += 1;
      if (emptyPolls < MAX_EMPTY_POLLS) schedule();
      else reportError(error);
      return;
    }
    const progress = result.progress || null;
    const current = store.get().project;
    // The announcement is computed BEFORE the store update — it is a diff, and the draw
    // that follows would otherwise have already overwritten what it diffs against.
    const speech = progressAnnouncement(announced, progress);
    announced = progress;
    if (speech) progressLive.textContent = speech;
    store.set({
      progress,
      project: current && result.status ? { ...current, status: result.status } : current,
    });
    if (isProgressComplete(progress)) {
      showToast('Staging finished.');
      await refresh();
      // THIS TICK is the authority: it just watched the queue drain. The refresh may
      // have re-armed the poller off a `status` the backend has not caught up on yet
      // (see shouldWatch), and that is the loop this line closes.
      stop();
      return;
    }
    const total = progress && progress.total ? progress.total : 0;
    emptyPolls = total > 0 ? 0 : emptyPolls + 1;
    if (emptyPolls >= MAX_EMPTY_POLLS) {
      showErrorToast('No staging work appeared. Reload the listing to check on it.');
      return;
    }
    schedule();
  }

  // A backgrounded tab must not keep polling: the timer keeps firing there, and the
  // operator sees nothing for it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stop();
      return;
    }
    const state = store.get();
    if (shouldWatch(state.project, state.progress)) schedule();
  });

  return { start, stop, seed };
}
