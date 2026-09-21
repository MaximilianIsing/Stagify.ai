// The two public-facing usage figures (Rooms Staged / Users Served), read from one
// place so every surface that publishes them agrees.
//
// They are published in four places now — the hero-stat spans in the served HTML, the
// homepage InteractionCounter JSON-LD, /api/stats, and llms.txt — and before this module
// the arithmetic (and the STATS_DEBUG override) lived inline in routes/public.js. Four
// copies of "contactCount + userCount" is three too many: an answer engine quoting
// llms.txt and a visitor reading the hero must not see different numbers.
//
// The legacy /api/prompt-count and /api/contact-count endpoints keep their own shapes
// (the browser and the e2e stubs depend on them) but read through here.

import { STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS } from '../config/runtime-flags.js';
import { getPromptCount, getContactCount } from './counters.js';

/**
 * @typedef {{ roomsStaged: number, usersServed: number }} PublicStats
 */

/**
 * @param {{ authStore: { getUserCount: () => number } }} deps
 * @returns {() => PublicStats} a synchronous reader — both counters are in-memory
 *   (lib/data/counters.js) and `getUserCount` is a single indexed SQLite count, so this
 *   is cheap enough to call on a page render.
 */
export function createPublicStats({ authStore }) {
  return function readPublicStats() {
    const roomsStaged =
      STATS_DEBUG && Number.isFinite(DEBUG_ROOMS) ? DEBUG_ROOMS : getPromptCount();
    const usersServed =
      STATS_DEBUG && Number.isFinite(DEBUG_USERS)
        ? DEBUG_USERS
        : getContactCount() + authStore.getUserCount();
    return { roomsStaged, usersServed };
  };
}

/**
 * What each figure actually counts, published alongside the numbers at /api/stats so a
 * consumer does not have to guess. Kept next to the arithmetic above, because that is
 * the thing these sentences describe.
 */
export const STAT_DEFINITIONS = Object.freeze({
  roomsStaged: 'Rooms staged with Stagify since launch (one per successful render).',
  usersServed: 'People served: registered accounts plus contact-form enquiries.',
});
