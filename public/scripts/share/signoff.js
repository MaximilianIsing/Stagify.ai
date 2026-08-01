// The reply path, assembled: one panel per room, one for the whole listing, and the single
// "Your name" field they all share.
//
// THE GET IS THE FEATURE FLAG — BUT ONLY A 404 FLIPS IT. An older server with no /feedback
// route answers 404, `fetchFeedback` reports `absent`, this function returns
// `{ enabled: false }`, and the page is exactly the read-only gallery it was before: no dead
// buttons, no form pointed at a 404, no console noise. It is also why the whole mount is
// awaited by main.js AFTER the gallery has already painted — the photographs must never wait
// on the reply channel.
//
// Any OTHER failed probe still renders. That is the correction to this file's original rule,
// which keyed on `ok` and so treated "could not answer" as "does not exist": a 429 or a 5xx
// or a phone losing signal for one request removed the seller's only way to reply, and did it
// silently. The recap of what they said earlier is lost in that case; the ability to answer
// is not, and the send reports its own errors accurately.
//
// THE NAME IS ASKED ONCE. A per-room name field would ask a seller to type their name five
// times to answer five rooms, and the field is optional anyway — so there is exactly one
// input, it lives in the whole-listing panel, and every panel reads its current value at
// SEND time rather than at build time. Nothing is ever blocked on it being filled in.
//
// THE CEILING IS A PAGE-WIDE FACT, NOT A PER-PANEL ONE. `allowance.full` means this link
// has said everything it may; a 409 arriving at any one panel therefore locks all of them
// and hides the name field, because offering the other rooms a form that is guaranteed to
// 409 is a worse answer than saying so once, calmly.

import { el, setHidden } from './dom.js';
import { fetchFeedback, sendFeedback } from './feedback-api.js';
import { LABEL_LIMIT, clampLabel, indexResponses, normalizeAllowance, rememberedLabel, slotKey } from './feedback-model.js';
import { buildSignOffPanel } from './signoff-panel.js';

/**
 * @typedef {import('./feedback-model.js').Allowance} Allowance
 * @typedef {import('./signoff-panel.js').SignOffPanel} SignOffPanel
 */

/**
 * @typedef {object} SignOffRoom
 * @property {string} key - The manifest's room key; sent verbatim as `roomKey`.
 * @property {string} label
 * @property {any} node - The room's <section>, which the panel is appended to.
 */

/**
 * @typedef {object} SignOffConfig
 * @property {string} token
 * @property {SignOffRoom[]} rooms
 * @property {any} slot - The element the whole-listing panel is mounted into.
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} SignOffMount
 * @property {boolean} enabled
 * @property {SignOffPanel[]} [panels]
 */

/** The heading over the whole-listing panel. */
const LISTING_HEADING = 'Tell the agent what you think';

/** How the whole-listing panel refers to what is being answered. */
const LISTING_LABEL = 'this listing';

/**
 * Build the shared, optional "Your name" field. It is persistent — panels re-render, this
 * does not — so whatever is half-typed in it survives every state change on the page.
 * @param {Document} doc
 * @param {string} initial
 * @returns {{ node: any, read: () => string }}
 */
function buildNameField(doc, initial) {
  const input = el(doc, 'input', {
    className: 'sh-signoff__name',
    id: 'sh-viewer-name',
    attrs: {
      type: 'text',
      maxlength: String(LABEL_LIMIT),
      autocomplete: 'name',
      placeholder: 'Optional',
    },
  });
  input.value = initial;

  const node = el(doc, 'div', {
    className: 'sh-signoff__who',
    children: [
      el(doc, 'label', {
        className: 'sh-signoff__label',
        text: 'Your name (optional)',
        attrs: { for: 'sh-viewer-name' },
      }),
      input,
      el(doc, 'p', {
        className: 'sh-signoff__hint',
        text: 'Only so the agent knows who replied. Leave it blank if you would rather not.',
      }),
    ],
  });

  return { node, read: () => clampLabel(input.value) };
}

/**
 * Fetch this link's existing answers and mount the reply UI.
 *
 * Never rejects and never throws: a failure anywhere in here must leave the gallery
 * standing, because the gallery is the part the reader came for.
 *
 * @param {Document} doc
 * @param {SignOffConfig} config
 * @returns {Promise<SignOffMount>}
 */
export async function mountSignOff(doc, config) {
  if (!config || !config.slot || !config.token) return { enabled: false };

  const state = await fetchFeedback(config.token, config.fetchImpl);
  // `!== true` rather than `!state.ok`, for the reason spelled out in signoff-panel.js:
  // under strictNullChecks:false a boolean-literal discriminant narrows on an equality
  // comparison and not on truthiness.
  const loaded = state.ok === true;
  // ABSENT, not merely failed. The probe's job is to detect whether the server HAS this
  // feature, and only a 404 answers that; a 429 or a 5xx came from the route itself, so
  // the channel exists and the seller should be offered it. Rendering with nothing loaded
  // costs them only the recap of what they said earlier — and the alternative is a page
  // with no way to reply at all, which reads as "there was never a reply feature". That
  // failure is silent in both directions: the seller does not report it, and the broker
  // simply never hears back.
  if (!loaded && state.absent) return { enabled: false };

  // Empty rather than absent: every panel below reads these, and a failed probe means we
  // do not KNOW what was said before, not that nothing was. `normalizeAllowance({})` is
  // not-full, so no panel is locked on a guess.
  const priorResponses = loaded ? state.responses : [];
  const recorded = indexResponses(priorResponses);
  let allowance = loaded ? state.allowance : normalizeAllowance({});

  const name = buildNameField(doc, rememberedLabel(priorResponses));

  /** @type {SignOffPanel[]} */
  const panels = [];

  /**
   * One panel's write path. The name is read HERE, at send time, so a viewer who fills it
   * in after answering the first room still has it attached to the second.
   * @param {{ roomKey: string|null, verdict: import('./feedback-model.js').Verdict, note: string }} payload
   */
  const send = (payload) => sendFeedback(
    config.token,
    { ...payload, viewerLabel: name.read() },
    config.fetchImpl,
  );

  /**
   * Absorb an allowance from any panel's write. Locking is one-way on purpose — a link
   * that has hit its ceiling does not un-hit it while the page is open.
   * @param {Allowance} next
   */
  const onAllowance = (next) => {
    if (next) allowance = next;
    if (!allowance.full) return;
    setHidden(name.node, true);
    for (const panel of panels) panel.setFull(true);
  };

  const listing = buildSignOffPanel(doc, {
    roomKey: null,
    slug: 'listing',
    label: LISTING_LABEL,
    heading: LISTING_HEADING,
    headingTag: 'h2',
    className: 'sh-signoff--listing',
    lead: name.node,
  }, { send, onAllowance });
  panels.push(listing);

  for (const [index, room] of config.rooms.entries()) {
    if (!room || !room.node) continue;
    const panel = buildSignOffPanel(doc, {
      roomKey: room.key,
      slug: `room-${index + 1}`,
      label: room.label,
      heading: 'Your response to this room',
      headingTag: 'h3',
      className: 'sh-signoff--room',
    }, { send, onAllowance });
    panel.setAnswer(recorded.get(slotKey(room.key)) || null);
    room.node.appendChild(panel.node);
    panels.push(panel);
  }

  listing.setAnswer(recorded.get('') || null);
  config.slot.appendChild(listing.node);

  // Applied last, so a link that arrives already at its ceiling paints the calm state on
  // top of whatever it did say, rather than under it.
  onAllowance(allowance);

  return { enabled: true, panels };
}
