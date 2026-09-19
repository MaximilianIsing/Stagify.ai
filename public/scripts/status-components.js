// Display helpers for the Components section of /status.
//
// Split out of status.js because status.js is a DOM-wiring IIFE with no exported
// surface, and these four functions are the only part of the section that is worth
// testing: the pack-then-English lookup order, and the state → CSS class mapping.
//
// The lookup order is the same contract as scripts/unstageable-message.js: the server
// sends a stable CODE plus its canonical ENGLISH sentence, we try the language pack
// first and fall back to that English. Translating is therefore purely additive, and a
// pack that lacks a key degrades to English rather than to a blank line.
//
// Nothing here touches `window` at import time, so node can load it directly.

/**
 * English component names, used when the pack has not loaded (or lacks the key).
 * Kept here rather than in the markup because the rows are built by JS, so there is no
 * `data-lang` element for the language runtime to fill in.
 */
export const FALLBACK_NAMES = {
  app: 'Website & API',
  staging: 'Virtual staging',
  chat: 'AI designer',
  accounts: 'Accounts & sign-in',
  billing: 'Payments',
  email: 'Email',
  storage: 'Image storage',
  database: 'Database',
};

/** Identity fallback, so every helper works with no language runtime at all. */
const identity = (key, fallback) => fallback;

/**
 * The display name for a component id.
 * @param {string} id - A component id from /api/status.
 * @param {(key: string, fallback: string) => string} [t] - The language lookup.
 */
export function componentLabel(id, t) {
  const lookup = typeof t === 'function' ? t : identity;
  // An id we have no name for still renders as something readable rather than blank:
  // an older bundle talking to a newer server is the case that produces one.
  return lookup('status.components.name.' + id, FALLBACK_NAMES[id] || id);
}

/**
 * The sentence under a component's name.
 * @param {{ reasonCode?: string, reason?: string }} component
 * @param {(key: string, fallback: string) => string} [t]
 */
export function componentReason(component, t) {
  const english = (component && component.reason) || '';
  const code = component && component.reasonCode;
  const lookup = typeof t === 'function' ? t : identity;
  if (!code) return english;
  return lookup('status.components.reason.' + code, english);
}

/**
 * The localized label for a state pill.
 * @param {string} state @param {(key: string, fallback: string) => string} [t]
 */
export function stateLabel(state, t) {
  const lookup = typeof t === 'function' ? t : identity;
  const known = { operational: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };
  const key = Object.prototype.hasOwnProperty.call(known, state) ? state : 'unknown';
  return lookup('status.components.state.' + key, known[key]);
}

/** The modifier class for a component pill. An unrecognized state reads as unknown. */
export function stateClass(state) {
  return 'is-' + (['operational', 'degraded', 'down'].indexOf(state) === -1 ? 'unknown' : state);
}

/**
 * The banner's modifier class.
 *
 * `overall` is the component-aware verdict and is preferred; `currentState` is the
 * heartbeat's own and is the fallback, so a cached older bundle against a newer server
 * (and a newer bundle against an older one) both still paint the banner correctly.
 *
 * @param {{ overall?: string, currentState?: string } | null | undefined} data
 */
export function bannerClass(data) {
  const overall = data && data.overall;
  if (overall === 'operational') return 'is-up';
  if (overall === 'degraded') return 'is-degraded';
  if (overall === 'down') return 'is-down';
  return data && data.currentState === 'up' ? 'is-up' : 'is-down';
}

/**
 * The banner headline for a payload, by the same preference order as bannerClass.
 * @param {{ overall?: string, currentState?: string } | null | undefined} data
 * @param {(key: string, fallback: string) => string} [t]
 */
export function bannerText(data, t) {
  const lookup = typeof t === 'function' ? t : identity;
  const cls = bannerClass(data);
  if (cls === 'is-up') return lookup('status.operational', 'All systems operational');
  if (cls === 'is-degraded') return lookup('status.degraded', 'Some systems are degraded');
  return lookup('status.disruption', 'Service disruption detected');
}
