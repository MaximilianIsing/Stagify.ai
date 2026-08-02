// Entry points into the home page's two staging screens from OUTSIDE the home
// page — i.e. from the top nav's "Staging" dropdown (scripts/staging-menu.js).
//
// Two halves, because the dropdown lives on nine pages and this file only on
// one:
//   - window hooks, so the dropdown can open a screen directly when the visitor
//     is ALREADY on the home page (no navigation, no flash);
//   - a URL fragment, for when they aren't. The dropdown's rows are plain links
//     to `index.html#stage` / `index.html#basic-mask`, so they keep working with
//     middle-click, "open in new tab" and the locale rewriter — none of which a
//     click handler would survive.
//
// The fragment is consumed and stripped on arrival: leaving it in the URL would
// reopen the screen on every refresh and on Back, which is not what a visitor
// who just closed it expects.

import { localizedTarget } from '../i18n-routing.js';

/** @type {Record<string, 'stage' | 'basic-mask'>} */
const HASH_ACTIONS = {
  '#stage': 'stage',
  '#basic-mask': 'basic-mask',
};

/**
 * Which screen a URL fragment asks for, if any. Pure, so the mapping is
 * testable without a document.
 *
 * @param {string} hash - e.g. `location.hash`
 * @returns {'stage' | 'basic-mask' | null}
 */
export function hashAction(hash) {
  return HASH_ACTIONS[String(hash || '').toLowerCase()] || null;
}

/**
 * Publish the open hooks and honour an incoming fragment.
 *
 * @param {{
 *   openStaging: () => void,
 *   openBasicMask: () => void,
 *   isPro: () => boolean,
 * }} deps - `openStaging` is the entry's own openFilePicker, which already
 *   carries the anonymous sign-in prompt; `isPro` reads live auth state.
 */
export function initStagingEntry({ openStaging, openBasicMask, isPro }) {
  window.__stagifyOpenStaging = openStaging;
  window.__stagifyOpenBasicMask = openBasicMask;

  /** @param {string} hash */
  async function consume(hash) {
    const action = hashAction(hash);
    if (!action) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (action === 'stage') {
      openStaging();
      return;
    }
    // Basic Mask is Stagify+ only. The dropdown row is locked for everyone else,
    // but this fragment is typeable and survives a middle-click, so re-check
    // here rather than trusting the row. Wait for /api/auth/me first — at
    // DOMContentLoaded the plan is not known yet, and treating "not yet loaded"
    // as "not Pro" would bounce paying users off their own home page.
    const auth = window.StagifyAuth;
    if (auth && typeof auth.getToken === 'function' && auth.getToken()) {
      try {
        await auth.fetchMe();
      } catch (e) {
        /* fall through to the plan check below, which will fail closed */
      }
    }
    if (isPro()) openBasicMask();
    else window.location.replace(localizedTarget('stagify-plus.html'));
  }

  consume(location.hash);
  window.addEventListener('hashchange', () => consume(location.hash));
}
