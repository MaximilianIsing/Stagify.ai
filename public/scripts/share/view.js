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
  for (const room of manifest.rooms ?? []) {
    for (const frame of room.frames ?? []) {
      if (!frame.url) continue;
      const img = /** @type {HTMLImageElement} */ (el('img', {
        doc,
        className: 'sh-frame__img',
        attrs: {
          // The thumbnail first when there is one: ~21 KB against ~110 KB, which on a
          // phone is the difference between the room appearing now and after a beat.
          src: frame.thumbUrl || frame.url,
          alt: room.label ? `${room.label}, virtually staged` : 'Virtually staged room',
          loading: 'lazy',
          decoding: 'async',
        },
      }));
      /** @type {any} */ (img).dataset.fullUrl = frame.url;
      /** @type {any} */ (img).dataset.renderId = frame.renderId || '';

      const button = el('button', {
        doc,
        className: 'sh-frame__button',
        attrs: { type: 'button', 'aria-label': `View ${room.label || 'room'} full size` },
        children: [img],
      });
      if (frame.width && frame.height) {
        button.style.setProperty('--sh-ar', `${frame.width} / ${frame.height}`);
      }
      button.addEventListener('click', () => onOpen(frame.url, room.label || ''));

      nodes.push(el('figure', {
        doc,
        className: 'sh-frame',
        children: [
          button,
          room.label ? el('figcaption', { doc, className: 'sh-frame__label', text: room.label }) : null,
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
