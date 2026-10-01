// Display helpers for the Components section of /status.
//
// Split out of status.js because status.js is a DOM-wiring IIFE with no exported
// surface, and these four functions are the only part of the section that is worth
// testing: the pack-then-English lookup order, and the state → CSS class mapping.
//
// The lookup order is the same contract as scripts/shared/unstageable-message.js: the server
// sends a stable CODE plus its canonical ENGLISH sentence, we try the language pack
// first and fall back to that English. Translating is therefore purely additive, and a
// pack that lacks a key degrades to English rather than to a blank line.
//
// Nothing here touches `window` at import time, so node can load it directly.

/**
 * English component names, used when the pack has not loaded (or lacks the key).
 * Kept here rather than in the markup because the rows are built by JS, so there is no
 * `data-lang` element for the language runtime to fill in.
 * @type {Record<string, string>}
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
/** @type {(key: string, fallback: string) => string} */
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
  /** @type {Record<string, string>} */
  const known = { operational: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };
  const key = Object.prototype.hasOwnProperty.call(known, state) ? state : 'unknown';
  return lookup('status.components.state.' + key, known[key]);
}

/**
 * The modifier class for a component pill. An unrecognized state reads as unknown.
 * @param {string} state
 */
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

/**
 * A glyph per component, as data rather than markup.
 *
 * Kept here beside the names, and as plain `[tag, attrs]` pairs rather than an SVG
 * string, for two reasons: this module stays DOM-free so node can load it, and the
 * renderer builds the nodes with createElementNS instead of assigning innerHTML — the
 * one habit on this page that keeps a future "icon from the server" idea from becoming
 * an injection seam.
 *
 * Every shape is a 24x24 stroked outline, so one CSS rule sizes and colours the lot.
 * test/frontend/status-components.test.js fails if a component id has no entry.
 * @type {Record<string, Array<[string, Record<string, string>]>>}
 */
export const COMPONENT_ICONS = {
  // globe
  app: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z' }],
  ],
  // framed picture
  staging: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['circle', { cx: '9', cy: '10', r: '1.6' }],
    ['path', { d: 'M4 17l5-4 4 3 3-2 4 3' }],
  ],
  // speech bubble
  chat: [
    ['path', { d: 'M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z' }],
  ],
  // person
  accounts: [
    ['circle', { cx: '12', cy: '8', r: '3.6' }],
    ['path', { d: 'M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1' }],
  ],
  // card
  billing: [
    ['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '2' }],
    ['path', { d: 'M2.5 10h19' }],
    ['path', { d: 'M6 15h4' }],
  ],
  // envelope
  email: [
    ['rect', { x: '2.5', y: '5', width: '19', height: '14', rx: '2' }],
    ['path', { d: 'M3 7l9 6 9-6' }],
  ],
  // stacked drives
  storage: [
    ['rect', { x: '3', y: '4', width: '18', height: '7', rx: '1.8' }],
    ['rect', { x: '3', y: '13', width: '18', height: '7', rx: '1.8' }],
    ['path', { d: 'M7 7.5h.01M7 16.5h.01' }],
  ],
  // cylinder
  database: [
    ['ellipse', { cx: '12', cy: '6', rx: '7.5', ry: '3' }],
    ['path', { d: 'M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6' }],
    ['path', { d: 'M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3' }],
  ],
};

/**
 * The shapes for one component id, or an empty list when it has none — an id this
 * bundle has never heard of renders without a glyph rather than without a tile.
 * @param {string} id
 */
export function componentIcon(id) {
  return Object.prototype.hasOwnProperty.call(COMPONENT_ICONS, id) ? COMPONENT_ICONS[id] : [];
}
