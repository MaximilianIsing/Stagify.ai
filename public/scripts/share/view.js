// Rendering the share page: the frames, the agent card, and the lightbox.
//
// Everything is built through dom.js, so nothing here assigns innerHTML. The manifest is
// typed by an account holder and read by a stranger; textContent makes injection
// unreachable rather than escaped.
//
// `doc` is threaded through every builder rather than read off the global. main.js takes
// a document, so these have to as well — a module that accepts one and then calls
// `globalThis.document` is only pretending to be injectable, and the seam stops working
// the moment the two differ.

import { el, replaceChildren, contactHref } from './dom.js';
import { styleLabel, entryName } from '../render-name.js';

/**
 * What this page calls the photo — the heading, the alt text and the lightbox label, from
 * one function so they cannot disagree.
 *
 * It is THE SAME LABEL the owner sees over the same photo in their own gallery, derived by
 * the same module: the name they gave it, or "<Style> <Room type>". An agent's own headline
 * on the share settings still wins, because that is a caption written for this page
 * specifically — but nothing sets one today, so in practice this is the gallery's title.
 *
 * @param {any} manifest @returns {string}
 */
export function shareTitle(manifest) {
  const headline = typeof manifest?.headline === 'string' ? manifest.headline.trim() : '';
  // The manifest carries `name` / `furnitureStyle` / `roomType` at the top level precisely
  // so this can be handed straight over.
  return headline || entryName(manifest, 'Staged room');
}

/**
 * The date a render was staged, in the reader's own locale.
 *
 * Date only — the gallery shows the time too, because an agent is picking one render out
 * of six from the same Tuesday afternoon, and nobody opening a share link has that
 * problem. Undefined locale on purpose: this page is not localized and has no language
 * pack, so the browser's own locale is the best answer available.
 *
 * @param {number} ms @returns {string} '' when there is no usable timestamp.
 */
export function formatStagedAt(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * The rows under the photo: what it was made from and when.
 *
 * A share page that says only "Staged room" leaves the recipient asking the questions it
 * exists to answer. Empty fields are skipped rather than printed with a blank value —
 * "Style: —" is noise, and a render staged before the column existed has no date.
 *
 * @param {{ manifest: any, doc?: Document }} arg @returns {Element | null}
 */
function renderFacts({ manifest, doc }) {
  const rows = [];
  const add = (label, value) => {
    if (!value) return;
    rows.push(el('dt', { doc, className: 'sh-facts__label', text: label }));
    rows.push(el('dd', { doc, className: 'sh-facts__value', text: value }));
  };
  // Style, then room, then date. `styleLabel` rather than the raw slug, so this says
  // "Modern" under a heading that says "Modern Bedroom" — and it is the gallery's own
  // function, not a second copy of the capitalisation rule.
  add('Style', styleLabel(manifest.furnitureStyle));
  add('Room', typeof manifest.roomType === 'string' ? manifest.roomType.trim() : '');
  add('Staged', formatStagedAt(manifest.stagedAt));
  if (!rows.length) return null;
  return el('dl', { doc, className: 'sh-facts', children: rows });
}

/**
 * Render the frames.
 *
 * The image box is sized from the manifest's width/height BEFORE the bytes arrive, so the
 * page does not reflow when they land — a jump while somebody is looking at it reads as a
 * broken page, and on a phone it moves the thing they were about to tap.
 *
 * @param {{ gallery: Element | null, manifest: any, doc?: Document,
 *   onOpen: (url: string, label: string) => void }} arg
 * @returns {HTMLImageElement[]} The <img> elements, in order, so the refresher can
 *   re-point them at fresh URLs when the presigned ones expire.
 */
export function renderGallery({ gallery, manifest, onOpen, doc }) {
  /** @type {HTMLImageElement[]} */
  const frames = [];
  const nodes = [];
  const label = shareTitle(manifest);
  for (const room of manifest.rooms ?? []) {
    for (const frame of room.frames ?? []) {
      if (!frame.url) continue;
      // THE FULL RENDER, not the thumbnail. The thumb is capped at 480px on its long edge
      // (ENCODES in lib/staging/render-persistence.js) and this box is up to 852px wide on
      // a desktop and the whole width of a phone at 2-3x — so showing it stretched every
      // pixel of that is why the photo looked soft here and sharp the moment the lightbox
      // opened the same URL this now uses.
      //
      // The thumb is still OFFERED, through srcset, so a small low-density screen can take
      // the 21 KB version instead of the 110 KB one. That choice belongs to the browser,
      // which knows the viewport and the pixel ratio; hard-coding it here is what got this
      // wrong. `sizes` mirrors the layout in share.css — 852px inside the 900px column,
      // full width below that breakpoint — because a wrong `sizes` makes the choice wrong
      // in exactly the way this is fixing.
      const attrs = {
        src: frame.url,
        alt: label ? `${label}, virtually staged` : 'Virtually staged room',
        loading: 'lazy',
        decoding: 'async',
      };
      if (frame.thumbUrl && frame.width) {
        attrs.srcset = `${frame.thumbUrl} 480w, ${frame.url} ${frame.width}w`;
        attrs.sizes = '(min-width: 720px) 852px, 100vw';
      }
      const img = /** @type {HTMLImageElement} */ (el('img', { doc, className: 'sh-frame__img', attrs }));
      /** @type {any} */ (img).dataset.fullUrl = frame.url;
      /** @type {any} */ (img).dataset.renderId = frame.renderId || '';

      const button = el('button', {
        doc,
        className: 'sh-frame__button',
        attrs: { type: 'button', 'aria-label': `View ${label || 'room'} full size` },
        children: [img],
      });
      if (frame.width && frame.height) {
        button.style.setProperty('--sh-ar', `${frame.width} / ${frame.height}`);
      }
      button.addEventListener('click', () => onOpen(frame.url, label));

      nodes.push(el('figure', {
        doc,
        className: 'sh-frame',
        children: [
          button,
          // The caption used to repeat the room type, which the heading above already
          // says. It carries the settings behind the photo instead.
          renderFacts({ manifest, doc }),
        ],
      }));
      frames.push(img);
    }
  }
  replaceChildren(gallery, nodes);
  return frames;
}

/**
 * Render the agent card, or leave it hidden.
 *
 * Contact details become LINKS only when they validate (see contactHref). An email that
 * does not look like an email is still shown — as text — because an agent who mistyped it
 * should see their mistake rather than have their card silently lose a line.
 *
 * @param {{ container: HTMLElement | null, agent: any, doc?: Document }} arg
 */
export function renderAgent({ container, agent, doc }) {
  if (!container) return;
  const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
  const email = typeof agent?.email === 'string' ? agent.email.trim() : '';
  const phone = typeof agent?.phone === 'string' ? agent.phone.trim() : '';
  if (!name && !email && !phone) {
    container.hidden = true;
    return;
  }

  const link = (scheme, value) => {
    const href = contactHref(scheme, value);
    return el('li', {
      doc,
      children: [href
        ? el('a', { doc, className: 'sh-agent__link', text: value, attrs: { href, rel: 'noopener' } })
        : el('span', { doc, className: 'sh-agent__link', text: value })],
    });
  };

  replaceChildren(container, [
    name ? el('p', { doc, className: 'sh-agent__name', text: name }) : null,
    el('ul', {
      doc,
      className: 'sh-agent__links',
      children: [email ? link('mailto', email) : null, phone ? link('tel', phone) : null],
    }),
  ]);
  container.hidden = false;
}

/**
 * Wire the lightbox.
 *
 * Escape closes, the backdrop closes, and focus returns to whatever opened it — a dialog
 * that strands keyboard focus is worse than no dialog.
 *
 * @param {{ root: any, img: any, close: any, doc?: any }} els
 * @returns {{ open: (url: string, label: string) => void, close: () => void }}
 */
export function createLightbox({ root, img, close, doc }) {
  const ownerDoc = doc ?? (typeof document === 'undefined' ? null : document);
  /** @type {any} */
  let opener = null;

  function hide() {
    if (!root) return;
    root.hidden = true;
    if (img) img.removeAttribute('src');
    if (opener && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  function show(url, label) {
    if (!root || !img) return;
    opener = ownerDoc?.activeElement ?? null;
    img.src = url;
    img.alt = label ? `${label}, virtually staged` : 'Virtually staged room';
    root.hidden = false;
    if (close && typeof close.focus === 'function') close.focus();
  }

  close?.addEventListener('click', hide);
  root?.addEventListener('click', (event) => {
    // Only the backdrop — clicking the image itself must not dismiss it, which is the
    // most common accidental close on a touchscreen.
    if (event.target === root) hide();
  });
  ownerDoc?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root && !root.hidden) hide();
  });

  return { open: show, close: hide };
}
