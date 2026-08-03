// The share page's entry point.
//
// The whole page is three states on the body attribute — loading, ready, unavailable —
// and this file is the only thing that sets it. One writer means no combination of
// failures can leave two states on screen at once.

import { parseShareToken, manifestUrl } from './token.js';
import { fetchManifest } from './api.js';
import { renderGallery, renderAgent, createLightbox, shareTitle } from './view.js';
import { createRefresher } from './refresh.js';

/**
 * Boot the page.
 * @param {{ doc?: Document, fetchImpl?: typeof fetch, pathname?: string }} [deps] - Injectable for tests.
 * @returns {Promise<'ready' | 'unavailable'>} The state it settled on.
 */
export async function start({ doc = document, fetchImpl = fetch, pathname } = {}) {
  const body = doc.body;
  /**
   * The ONE writer of the page state. The h1 is shared across states, so its text moves
   * with the state rather than being set in two places that could disagree.
   * @param {'loading' | 'ready' | 'unavailable'} state
   */
  const setState = (state) => {
    body.setAttribute('data-state', state);
    if (state === 'unavailable') {
      const headline = doc.getElementById('sh-headline');
      if (headline) headline.textContent = 'This link is no longer available';
    }
  };

  const token = parseShareToken(pathname ?? window.location.pathname);
  // A malformed token never becomes a request: the server would refuse it anyway, and
  // not asking is one less entry in someone's access log.
  if (!token) { setState('unavailable'); return 'unavailable'; }

  const url = manifestUrl(token);
  const lightbox = createLightbox({
    root: /** @type {HTMLElement} */ (doc.getElementById('sh-lightbox')),
    img: /** @type {HTMLImageElement} */ (doc.getElementById('sh-lightbox-img')),
    close: /** @type {HTMLElement} */ (doc.getElementById('sh-lightbox-close')),
    doc,
  });

  /** @type {ReturnType<typeof createRefresher> | null} */
  let refresher = null;

  /**
   * Draw a manifest. Also the re-mint path, so fresh URLs land in the same code that drew
   * the first ones — two render paths would drift, and the drifted one would be the
   * recovery nobody exercises.
   * @param {any} manifest
   */
  function draw(manifest) {
    const headline = doc.getElementById('sh-headline');
    // The same title the owner sees over this photo in their gallery. `shareTitle` owns
    // the precedence so the heading, the alt text and the lightbox cannot disagree.
    if (headline) headline.textContent = shareTitle(manifest);

    const note = doc.getElementById('sh-note');
    if (note) {
      note.textContent = manifest.note || '';
      /** @type {any} */ (note).hidden = !manifest.note;
    }

    const disclosure = doc.getElementById('sh-disclosure');
    // Always rendered when present. It ships in the manifest precisely so it cannot be
    // left out of the surface the buyer actually reads.
    if (disclosure) disclosure.textContent = manifest.disclosure || '';

    renderAgent({ container: /** @type {HTMLElement} */ (doc.getElementById('sh-agent')), agent: manifest.agent, doc });

    const images = renderGallery({
      gallery: doc.getElementById('sh-gallery'),
      manifest,
      doc,
      onOpen: (full, label) => lightbox.open(full, label),
    });
    if (refresher) refresher.attach(images);
    return images;
  }

  const first = await fetchManifest(url, fetchImpl);
  if (!first.ok) { setState('unavailable'); return 'unavailable'; }

  const images = draw(first.manifest);
  refresher = createRefresher({
    images,
    reload: async () => {
      const again = await fetchManifest(url, fetchImpl);
      if (!again.ok) return null;
      draw(again.manifest);
      return again.manifest;
    },
    // The re-fetch 404ing means the share was revoked or expired while somebody was
    // reading it — the same unavailable state as arriving on a dead link.
    onGiveUp: () => setState('unavailable'),
  });

  setState('ready');
  return 'ready';
}

// Not started under test: the spec drives `start()` with its own document and fetch.
if (typeof window !== 'undefined' && !(/** @type {any} */ (window).__SHARE_TEST__)) {
  void start();
}
