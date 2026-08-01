// The broker's inbox for seller sign-off: what came back through the client share link.
//
// The seller opens the shared page and marks rooms **approved** or **needs changes** with a
// note. This panel is the other end of that — so the conversation stops living in a text
// message the agent has to scroll back through before every call.
//
// THREE THINGS SHAPE EVERY DECISION BELOW.
//
//  1. THE ROWS ARE APPEND-ONLY, SO THE LOG IS NOT THE STATE. A seller who asks for changes
//     on the kitchen and then approves it a day later produces TWO rows for that room, and
//     both are kept — the history is the audit trail, and the store never edits a row. What
//     the broker needs is the CURRENT position per room, so `latestPerRoom` reduces the log
//     before anything is drawn. Rendering the raw list would show a room as both approved
//     and rejected at once, which is the exact ambiguity this feature exists to remove.
//     `GET …/feedback` answers newest-first, so the FIRST occurrence of a room key is its
//     current state — but the reduction compares `createdAt` rather than trusting position,
//     because "the list happens to be sorted" is a property of a route that can be
//     reordered by a future `ORDER BY`, and getting this backwards inverts every verdict on
//     screen while still looking plausible.
//
//  2. `roomKey: null` IS A DIFFERENT KIND OF RESPONSE, NOT A MISSING ONE. It is feedback
//     about the WHOLE LISTING, and it is labelled distinctly (`WHOLE_LISTING_LABEL`) rather
//     than falling through to a room heading or an empty one. It is also counted separately
//     in the summary — "3 rooms approved" must not silently include a listing-level note.
//
//  3. IT REFRESHES ON A LISTING CHANGE, NEVER ON A POLL TICK. The shared store notifies on
//     every progress tick during a staging run — 20+ times a minute — and re-reading the
//     feedback on each one would be pointless traffic and a list flickering under the
//     operator's cursor. The subscription therefore compares the project id and returns
//     early when it has not changed, exactly as ./share-panel.js does with the share row.
//     Do not "simplify" that guard away.
//
// And, as with ./share-panel.js and ./render-grid.js: NO HTML-STRING SINK ANYWHERE HERE.
// The note and the viewer's name are text a stranger typed into a public page, and every
// one of them reaches the DOM through `createElement` + `textContent`. If a future change
// genuinely needs markup, import `escapeHtml` from ../escape-html.js — do not hand-roll a
// second escaper, and do not reach for innerHTML.

import { ApiError, fetchShareFeedback } from './api.js';
import { formatDate } from './summaries.js';

// The row shape comes from the SERVER's own type file rather than a local copy — same rule
// as ./api.js. A hand-written duplicate here could only ever drift out of agreement with
// the producer, which is a bug this codebase has already shipped once.
/**
 * @typedef {import('../../../lib/types/projects.js').ShareFeedback} PjShareFeedback
 * @typedef {import('./state.js').PjState} PjState
 */

/**
 * @typedef {object} PjFeedbackPanel
 * @property {() => void} destroy - Drop the store subscription.
 */

/**
 * Every element id this panel resolves. Spread into `SHARE_ELEMENT_IDS` by
 * ./share-panel.js so the drift guard in test/frontend/projects/studio.test.js — which
 * asserts every resolved id exists in projects.html — covers these too. A typo here would
 * otherwise ship as "the responses never appear", which nothing would notice.
 */
export const FEEDBACK_ELEMENT_IDS = [
  'pj-feedback',
  'pj-feedback-summary',
  'pj-feedback-empty',
  'pj-feedback-list',
  'pj-feedback-error',
];

/** The two verdicts a viewer can send (`FeedbackVerdict` in lib/types/projects.d.ts). */
export const APPROVED_VERDICT = 'approved';
/** See APPROVED_VERDICT. */
export const CHANGES_VERDICT = 'changes';

/** How a response about the listing as a whole is titled, rather than as a room. */
export const WHOLE_LISTING_LABEL = 'The whole listing';

/**
 * Who a response is from when the viewer did not type a name.
 *
 * `viewerLabel` is optional and usually empty — the shared page never asks anyone to
 * identify themselves — so this is the common case, not the edge one. It must never render
 * as "undefined", an empty gap, or an invented identity.
 */
export const ANONYMOUS_VIEWER = 'A client';

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** @param {unknown} value @returns {string} */
function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** @param {unknown} value @returns {number} */
function num(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The room a response is about, or `null` for the whole listing.
 *
 * An empty or whitespace-only key is folded into `null` too: both mean "not about one
 * room", and treating '' as a room of its own would mint a heading with no name.
 * @param {PjShareFeedback|null|undefined} entry
 * @returns {string|null}
 */
export function feedbackRoomKey(entry) {
  const key = entry && typeof entry.roomKey === 'string' ? entry.roomKey.trim() : '';
  return key || null;
}

/**
 * The CURRENT state per room: one entry each, newest response wins.
 *
 * See point 1 in the file header — the log is append-only, so this reduction is what turns
 * a history into an answer. Ties (identical `createdAt`) keep the EARLIER position, which
 * with the route's newest-first ordering is still the newer row.
 *
 * The result is sorted newest-first, so the most recent thing the client said is the first
 * thing the broker reads.
 * @param {PjShareFeedback[]|null|undefined} feedback - The raw log, as the API sent it.
 * @returns {PjShareFeedback[]}
 */
export function latestPerRoom(feedback) {
  /** @type {Map<string|null, PjShareFeedback>} */
  const current = new Map();
  for (const entry of Array.isArray(feedback) ? feedback : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = feedbackRoomKey(entry);
    const held = current.get(key);
    if (held && num(held.createdAt) >= num(entry.createdAt)) continue;
    current.set(key, entry);
  }
  return [...current.values()].sort((a, b) => num(b.createdAt) - num(a.createdAt));
}

/**
 * Display text for the room a response is about.
 *
 * Room keys are slugs the clusterer minted (`bedroom-2`, `living-room-1`), so they are
 * de-slugged for reading. A key that de-slugs to nothing is shown verbatim rather than
 * being mislabelled as listing-level feedback.
 * @param {string|null|undefined} roomKey
 * @returns {string}
 */
export function roomFeedbackLabel(roomKey) {
  const key = text(roomKey).trim();
  if (!key) return WHOLE_LISTING_LABEL;
  const spaced = key.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The verdict in words.
 *
 * The two known verdicts get their own sentence; anything else — a value from a newer
 * server than this page — reads as the neutral "Responded" rather than being rounded into
 * "Needs changes", which would put words in the client's mouth.
 * @param {string|null|undefined} verdict
 * @returns {string}
 */
export function verdictLabel(verdict) {
  if (verdict === APPROVED_VERDICT) return 'Approved';
  if (verdict === CHANGES_VERDICT) return 'Needs changes';
  return 'Responded';
}

/**
 * Who said it, never blank and never "undefined". See ANONYMOUS_VIEWER.
 * @param {string|null|undefined} viewerLabel
 * @returns {string}
 */
export function viewerName(viewerLabel) {
  return text(viewerLabel).trim() || ANONYMOUS_VIEWER;
}

/**
 * When it arrived, relative for anything recent and an absolute date beyond a week.
 *
 * A relative stamp is what makes the panel scannable ("2 hours ago" answers "do I need to
 * call them today?"), but it stops being useful past a few days, so older responses fall
 * back to `formatDate`. A timestamp in the FUTURE (a viewer's skewed clock) also falls back
 * to the date rather than rendering as "0 minute(s) ago", which would read as a bug.
 * @param {string|number|null|undefined} value
 * @param {number} [now]
 * @returns {string} '' when the timestamp cannot be read.
 */
export function feedbackWhen(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return '';
  const at = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(at)) return '';
  const ago = now - at;
  if (ago < 0) return formatDate(value);
  if (ago < MINUTE_MS) return 'just now';
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} minute(s) ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} hour(s) ago`;
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)} day(s) ago`;
  return formatDate(value);
}

/**
 * The one line a broker scans before opening anything: "3 room(s) approved · 1 change(s)
 * requested".
 *
 * Counts the CURRENT state (feed it `latestPerRoom`'s output, not the raw log) and counts
 * rooms only — a listing-level response is appended as its own clause instead, because
 * folding it into "rooms approved" would overstate how much of the shoot is signed off.
 * @param {PjShareFeedback[]|null|undefined} entries - Current state, from latestPerRoom.
 * @returns {string} '' when there is nothing to summarize.
 */
export function feedbackSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let approved = 0;
  let changes = 0;
  /** @type {PjShareFeedback|null} */
  let listing = null;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (feedbackRoomKey(entry) === null) {
      if (!listing) listing = entry;
      continue;
    }
    if (entry.verdict === APPROVED_VERDICT) approved += 1;
    else if (entry.verdict === CHANGES_VERDICT) changes += 1;
  }
  /** @type {string[]} */
  const parts = [];
  if (approved) parts.push(`${approved} room(s) approved`);
  if (changes) parts.push(`${changes} change(s) requested`);
  if (listing) {
    parts.push(
      listing.verdict === APPROVED_VERDICT
        ? 'the whole listing approved'
        : 'changes requested on the whole listing'
    );
  }
  return parts.join(' · ');
}

/**
 * Mount the client-response list.
 *
 * Takes the shared store rather than a project id, for the same reason ./share-panel.js
 * does: the responses belong to the listing that is open, and must be dropped the moment
 * the operator opens a different one. It subscribes SEPARATELY (rather than being called
 * by the share panel's own listener) so that its "a listing change, not a poll tick"
 * behaviour is a property of this module and can be argued with in its own test.
 *
 * Like the share panel, it is INERT WITHOUT ITS MARKUP — a missing `#pj-feedback` returns a
 * do-nothing handle instead of throwing, which is what keeps the share panel safe to mount
 * on a page (or a stub document) that predates this section.
 *
 * @param {{
 *   store: {
 *     get: () => PjState,
 *     subscribe: (listener: (state: PjState) => void) => (() => void),
 *   },
 * }} deps - The projects store. Nothing else: this panel only reads.
 * @returns {PjFeedbackPanel}
 */
export function mountShareFeedback(deps) {
  const { store } = deps;
  /** @param {string} id @returns {any} */
  const byId = (id) => document.getElementById(id);

  const root = byId('pj-feedback');
  if (!root) return { destroy() {} };

  const summaryLine = byId('pj-feedback-summary');
  const emptyLine = byId('pj-feedback-empty');
  const list = byId('pj-feedback-list');
  const errorLine = byId('pj-feedback-error');

  /** The listing whose responses are on screen. */
  let projectId = '';

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [content]
   * @returns {any}
   */
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function clearError() {
    errorLine.textContent = '';
    errorLine.classList.add('hidden');
  }

  /**
   * Say a read failed, in the panel and nowhere else.
   *
   * Deliberately NO toast: this read is background work the operator did not ask for
   * (it fires on opening a listing), and a toast over the share controls would blame them
   * for something they did not press. The share panel above is untouched — nothing here
   * disables a control — so minting, copying and revoking still work while this is showing.
   * @param {unknown} error
   */
  function fail(error) {
    const message =
      error instanceof ApiError
        ? error.message
        : 'Something went wrong. Please try again.';
    errorLine.textContent = `Could not load your client's responses. ${message}`;
    errorLine.classList.remove('hidden');
  }

  /**
   * One response.
   *
   * The verdict is carried as WORDS as well as a tone class, so approved and needs-changes
   * are distinguishable without colour — a broker printing this or reading it in high
   * contrast still gets the answer.
   * @param {PjShareFeedback} entry
   * @returns {any}
   */
  function entryRow(entry) {
    const roomKey = feedbackRoomKey(entry);
    const approved = entry.verdict === APPROVED_VERDICT;
    const tone = approved ? 'is-approved' : 'is-changes';
    const item = el('li', `pj-feedback__item ${tone}`);

    const head = el('div', 'pj-feedback__head');
    const roomClass = roomKey === null
      ? 'pj-feedback__room pj-feedback__room--listing'
      : 'pj-feedback__room';
    head.appendChild(el('span', roomClass, roomFeedbackLabel(roomKey)));
    head.appendChild(
      el(
        'span',
        `pj-feedback__verdict ${approved ? 'pj-feedback__verdict--approved' : 'pj-feedback__verdict--changes'}`,
        verdictLabel(entry.verdict)
      )
    );
    item.appendChild(head);

    // An empty note is omitted rather than rendered as a blank paragraph — "approved, no
    // comment" is a complete response and should not leave a gap that reads as missing text.
    const note = text(entry.note).trim();
    if (note) item.appendChild(el('p', 'pj-feedback__note', note));

    const when = feedbackWhen(entry.createdAt);
    const by = viewerName(entry.viewerLabel);
    item.appendChild(el('p', 'pj-feedback__by', when ? `${by} · ${when}` : by));
    return item;
  }

  /**
   * Redraw from the CURRENT state. An empty set is a single plain line, not an empty box
   * with a heading, a summary and a bordered list around nothing.
   * @param {PjShareFeedback[]} entries
   */
  function draw(entries) {
    // Assigning textContent detaches the previous children, the same way the grid clears.
    list.textContent = '';
    const summary = feedbackSummary(entries);
    summaryLine.textContent = summary;
    summaryLine.classList.toggle('hidden', !summary);
    emptyLine.classList.toggle('hidden', entries.length > 0);
    for (const entry of entries) list.appendChild(entryRow(entry));
  }

  /**
   * Read a listing's responses. Guarded against the operator opening another listing
   * mid-flight: a late answer for the previous one must not overwrite the current list.
   * @param {string} id
   */
  async function load(id) {
    try {
      const result = await fetchShareFeedback(id);
      if (id !== projectId) return;
      const raw = result && Array.isArray(result.feedback) ? result.feedback : [];
      draw(latestPerRoom(raw));
    } catch (error) {
      if (id === projectId) fail(error);
    }
  }

  const unsubscribe = store.subscribe((state) => {
    const id = state && state.project ? state.project.id : '';
    // ONLY a change of listing. See point 3 in the file header — the store also notifies on
    // every progress tick during a run, and re-reading here on each one would be dozens of
    // pointless requests and a list redrawing under the operator's eyes.
    if (id === projectId) return;
    projectId = id;
    clearError();
    draw([]);
    if (id) load(id);
  });

  draw([]);

  return {
    destroy() {
      unsubscribe();
    },
  };
}
