// Entry point for the public share page (public/listing-share.html, served at /s/<token>).
//
// Loaded as `<script type="module" src="/scripts/share/main.js">`. That is not a style
// preference: the site's CSP forbids inline <script> and inline `on*` handlers outright,
// and an inline module script does not error — it silently does nothing, which has cost
// this repo a debugging session before. So every handler on this page is attached with
// addEventListener, from an external module, and there is not one `onclick` in the markup.
//
// THE SHAPE OF THE PAGE IS FIXED, ITS CONTENT IS NOT. The HTML ships an empty shell: a
// hero with the (single) <h1>, and a body container. This module fills them and moves
// `#sh-root`'s `data-state` between `loading`, `ready`, `empty` and `unavailable`, which is
// what share.css keys its visibility off. Keeping the states on one attribute means there
// is no combination of classes that can leave two states painted at once — a real hazard
// when the failure state and the success state share a page.
//
// `REQUIRED_IDS` is exported so the spec can assert the markup and this module still agree.
// The shell is the only coupling between the two files, and it is the kind that breaks
// silently: a renamed id makes the page render nothing at all, with no error anywhere.

import { parseShareToken } from './token.js';
import { fetchListing } from './api.js';
import { hasAgent } from './model.js';
import { clear, el, setHidden } from './dom.js';
import { createLightbox } from './lightbox.js';
import { buildGallery } from './gallery.js';
import { mountSignOff } from './signoff.js';
import {
  buildAgentCard,
  buildDisclosure,
  buildEmptyState,
  buildNote,
  buildSummary,
  buildUnavailableState,
} from './sections.js';

/** The ids public/listing-share.html must provide. Asserted by the spec against the file. */
export const REQUIRED_IDS = ['sh-root', 'sh-title', 'sh-address', 'sh-headline', 'sh-body'];

/** Shown as the <h1> when there is no listing to name. */
const GONE_HEADING = 'This link is no longer available';

/**
 * @typedef {object} ShareEnv
 * @property {Document} doc
 * @property {string} pathname - Usually `location.pathname`.
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} ShareRefs
 * @property {any} root
 * @property {any} title
 * @property {any} address
 * @property {any} headline
 * @property {any} body
 */

/**
 * Resolve the shell. Returns null if any part is missing, which the caller treats as "this
 * is not the share page" rather than trying to render into half a document.
 * @param {Document} doc
 * @returns {ShareRefs|null}
 */
function refs(doc) {
  const found = REQUIRED_IDS.map((id) => doc.getElementById(id));
  if (found.some((node) => !node)) return null;
  const [root, title, address, headline, body] = found;
  return { root, title, address, headline, body };
}

/**
 * @param {ShareRefs} nodes
 * @param {string} state - loading | ready | empty | unavailable
 */
function setState(nodes, state) {
  nodes.root.setAttribute('data-state', state);
  // The shell ships `aria-busy="true"` so the placeholder is not announced as content.
  // Clearing it is what tells a screen reader the live region has settled.
  nodes.body.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
}

/**
 * Put a line in, or take the element out of the document entirely. An empty <p> that is
 * merely invisible still occupies a slot in the accessibility tree and in the layout's
 * vertical rhythm.
 * @param {any} node
 * @param {string} value
 */
function line(node, value) {
  node.textContent = value;
  setHidden(node, !value);
}

/**
 * Render the "nothing to see" page. Used for a missing token AND for every server refusal,
 * with no attempt to distinguish them — see the header of api.js.
 * @param {ShareRefs} nodes
 * @param {Document} doc
 */
function renderUnavailable(nodes, doc) {
  line(nodes.title, GONE_HEADING);
  line(nodes.address, '');
  line(nodes.headline, '');
  clear(nodes.body);
  nodes.body.appendChild(buildUnavailableState(doc));
  setState(nodes, 'unavailable');
}

/**
 * Render a live listing.
 *
 * Returns the state AND the pieces the reply path needs, rather than mounting it here: the
 * sign-off UI depends on a network call, and the photographs must not wait on it. The slot
 * is an empty div parked between the gallery and the agent card so that panels arriving a
 * moment later land in the right place instead of after the contact details. When the
 * feedback endpoints are absent the slot simply stays empty, which costs a reader nothing.
 *
 * @param {ShareRefs} nodes
 * @param {Document} doc
 * @param {import('./model.js').ShareListing} listing
 * @param {string} token
 * @returns {{ state: string, rooms: import('./signoff.js').SignOffRoom[], slot: any }}
 */
function renderListing(nodes, doc, listing, token) {
  line(nodes.title, listing.title || 'Listing gallery');
  line(nodes.address, listing.address);
  line(nodes.headline, listing.headline);
  if (listing.title) doc.title = `${listing.title} | Stagify.ai`;

  clear(nodes.body);

  // The broker's own note stays on an empty page — it is their message to their client, and
  // it reads perfectly well before the photographs land.
  const note = buildNote(doc, listing.note);
  if (note) nodes.body.appendChild(note);

  if (!listing.rooms.length) {
    nodes.body.appendChild(buildEmptyState(doc));
    if (hasAgent(listing.agent)) nodes.body.appendChild(buildAgentCard(doc, listing.agent));
    setState(nodes, 'empty');
    // No sign-off on an empty share: there is nothing on the page to have an opinion about,
    // and a form asking for one would read as a bug.
    return { state: 'empty', rooms: [], slot: null };
  }

  // THE DISCLOSURE GOES BELOW THE EMPTY BRANCH, for the same reason the sign-off form does.
  // It is a statement ABOUT THE PHOTOGRAPHS ON THIS PAGE — "Photos on this page have been
  // virtually staged" — and a broker who shares a link before staging finishes was showing
  // it to a seller on a page with no photographs at all. A legal notice that appears when
  // there is nothing to disclose reads as boilerplate, which is the opposite of what this
  // sentence is for. Found by walking that sequence, which is an ordinary thing to do.
  nodes.body.appendChild(buildDisclosure(doc, listing.disclosure));
  nodes.body.appendChild(buildSummary(doc, listing.rooms.length, listing.frameCount));

  const lightbox = createLightbox(doc, { label: `${listing.title || 'Listing'} — photo viewer` });
  const gallery = buildGallery(doc, listing, token, (index, trigger) => lightbox.open(index, trigger));
  lightbox.setSlides(gallery.slides);

  nodes.body.appendChild(gallery.node);
  const slot = el(doc, 'div', { className: 'sh-signoff-slot' });
  nodes.body.appendChild(slot);
  if (hasAgent(listing.agent)) nodes.body.appendChild(buildAgentCard(doc, listing.agent));
  // The viewer is a sibling of the page content, not a descendant of it: it marks
  // `#sh-root` aria-hidden while open, and a dialog nested inside the thing it hides is a
  // dialog no screen reader will read.
  if (doc.body) doc.body.appendChild(lightbox.node);

  setState(nodes, 'ready');
  return { state: 'ready', rooms: gallery.rooms, slot };
}

/**
 * Fetch the manifest and paint the page. Never rejects: a share link that throws is a share
 * link that shows a spinner forever to someone with no way to report it.
 *
 * @param {ShareEnv} env
 * @returns {Promise<string>} `no-shell`, `unavailable`, `empty` or `ready`.
 */
export async function boot(env) {
  const doc = env.doc;
  const nodes = refs(doc);
  if (!nodes) return 'no-shell';

  setState(nodes, 'loading');
  const token = parseShareToken(env.pathname);
  if (!token) {
    renderUnavailable(nodes, doc);
    return 'unavailable';
  }

  let result;
  try {
    result = await fetchListing(token, env.fetchImpl);
  } catch {
    result = { ok: /** @type {false} */ (false) };
  }

  if (!result.ok) {
    renderUnavailable(nodes, doc);
    return 'unavailable';
  }

  const painted = renderListing(nodes, doc, result.listing, token);
  if (painted.slot) {
    // Awaited so the spec can assert against a settled page, but deliberately AFTER the
    // gallery has been painted and `data-state` set — the photographs never wait on the
    // reply channel. The try/catch is the last line of the same promise: whatever goes
    // wrong in the sign-off code, the reader keeps the gallery they came for.
    try {
      await mountSignOff(doc, {
        token,
        rooms: painted.rooms,
        slot: painted.slot,
        fetchImpl: env.fetchImpl,
      });
    } catch {
      // Intentionally silent: there is no console on this page anybody will read, and a
      // missing reply form is not worth a broken render.
    }
  }
  return painted.state;
}

// Auto-boot in the browser only. Under `node --test` there is no global `document` at
// import time, so the spec imports this module cleanly and calls `boot` with its own
// document — which is what makes the wiring, and not merely the helpers, testable.
if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  const start = () => {
    void boot({ doc: document, pathname: location.pathname });
  };
  // A module script is deferred, so this normally runs with the shell already parsed. The
  // readyState guard costs nothing and covers the case where it does not.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
