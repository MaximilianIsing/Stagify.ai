// GET /api/stats — the canonical, self-describing pair of public usage figures.
//
// WHY IT IS NOT JUST ANOTHER LINE IN routes/public.js. /api/prompt-count and
// /api/contact-count already exist, but neither says what it counts, and between them a
// caller has to know to add `contactCount` to `userCount` to get the figure the homepage
// shows. This is the endpoint llms.txt points an answer engine at, so it is the one whose
// numbers get quoted back to people, and it has to be unambiguous on its own.
//
// Lives here rather than inline because routes/public.js is at its max-lines ceiling.

import { STAT_DEFINITIONS } from '../data/public-stats.js';

/**
 * The reader routes/public.js falls back to when server.js has not injected the shared
 * one (the route tests mount it that way). Same arithmetic and same overrides as
 * createPublicStats, but over the router's injected deps rather than module imports —
 * test/routes/public-stats-route.test.js asserts the two agree.
 *
 * @param {{ authStore: { getUserCount: () => number }, STATS_DEBUG: boolean,
 *   DEBUG_ROOMS: number, DEBUG_USERS: number,
 *   getPromptCount: () => number, getContactCount: () => number }} deps
 * @returns {() => import('../data/public-stats.js').PublicStats}
 */
export function statsFromDeps(deps) {
  const { authStore, STATS_DEBUG, DEBUG_ROOMS, DEBUG_USERS, getPromptCount, getContactCount } = deps;
  return () => ({
    roomsStaged: STATS_DEBUG && Number.isFinite(DEBUG_ROOMS) ? DEBUG_ROOMS : getPromptCount(),
    usersServed:
      STATS_DEBUG && Number.isFinite(DEBUG_USERS)
        ? DEBUG_USERS
        : getContactCount() + authStore.getUserCount(),
  });
}

/**
 * @param {() => import('../data/public-stats.js').PublicStats} readPublicStats
 * @returns {import('express').RequestHandler}
 */
export function createStatsHandler(readPublicStats) {
  return function stats(req, res) {
    const { roomsStaged, usersServed } = readPublicStats();
    // Live figures: a cached one is worse than none, because it would be quoted as current.
    res.set('Cache-Control', 'no-store');
    res.json({
      roomsStaged,
      usersServed,
      definitions: STAT_DEFINITIONS,
      source: 'https://stagify.ai/llms.txt',
      generatedAt: new Date().toISOString(),
    });
  };
}
