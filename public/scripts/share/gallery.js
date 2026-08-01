// Rooms as sections, frames inside them, in manifest order.
//
// ORDER IS THE PRODUCT. The Listing Studio's operator has already decided which room comes
// first and which photograph leads it; a broker sending this to a seller is sending a
// sequence, not a set. So nothing here sorts, groups or re-ranks — the rooms are appended
// in the order they arrived and so are their frames, and the lightbox's flat slide list is
// built from the same single pass, which is what keeps "photo 7 of 24" agreeing with what
// the reader just tapped.
//
// TAP TARGETS AND THE DRAG PROBLEM. On a phone the natural gesture on a photo is a tap to
// enlarge — but on a before/after frame the natural gesture is also a drag, and the two
// arrive as the same pointer sequence. The frame therefore opens the viewer on click UNLESS
// the comparison reports that the divider actually moved (`consumeDrag`). That leaves the
// keyboard with no way in, since a <div> is not focusable, so every frame ALSO carries a
// real <button> — which is the control the assistive-technology path uses and the one that
// carries the accessible name.

import { el } from './dom.js';
import { createCompare } from './compare.js';
import { renderUrl, photoUrl } from './token.js';

/**
 * @typedef {import('./model.js').ShareListing} ShareListing
 * @typedef {import('./model.js').ShareRoom} ShareRoom
 * @typedef {import('./model.js').ShareFrame} ShareFrame
 * @typedef {import('./lightbox.js').LightboxSlide} LightboxSlide
 */

/**
 * Build one frame.
 * @param {Document} doc
 * @param {ShareFrame} frame
 * @param {string} token
 * @param {string} roomLabel
 * @param {number} position - 1-based position within the room, for the accessible name.
 * @param {number} slideIndex - Index into the flat slide list.
 * @param {(index: number, trigger: any) => void} onOpen
 * @returns {any}
 */
function buildFrame(doc, frame, token, roomLabel, position, slideIndex, onOpen) {
  const stagedAlt = `${roomLabel}, photo ${position} — virtually staged`;
  const comparison = createCompare(doc, {
    stagedSrc: renderUrl(token, frame.renderId),
    originalSrc: frame.photoId ? photoUrl(token, frame.photoId) : null,
    width: frame.width,
    height: frame.height,
    stagedAlt,
    originalAlt: `${roomLabel}, photo ${position} — the original, unstaged room`,
  });

  // The zoom button is built first because it is also the element focus is RESTORED to
  // when the viewer closes — including when the viewer was opened by tapping the photo.
  // Sending focus to the photo would send it to a <div>, i.e. nowhere.
  const zoom = el(doc, 'button', {
    className: 'sh-frame__zoom',
    attrs: {
      type: 'button',
      'aria-label': `View ${roomLabel.toLowerCase()}, photo ${position}, full screen`,
    },
    children: [el(doc, 'span', { className: 'sh-frame__zoom-glyph', text: '⤢', attrs: { 'aria-hidden': 'true' } })],
    on: {
      click: (event) => {
        // Without this the click also reaches `media` below and the viewer opens twice —
        // the second open would overwrite the stored trigger and lose the restore target.
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        onOpen(slideIndex, zoom);
      },
    },
  });

  const media = el(doc, 'div', {
    className: 'sh-frame__media',
    children: [comparison.node],
    on: {
      click: (event) => {
        // A gesture that moved the divider was a drag, not a tap. Consuming the flag here
        // (rather than reading it) means the next genuine tap is unaffected.
        if (comparison.consumeDrag()) return;
        onOpen(slideIndex, zoom);
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      },
    },
  });

  return el(doc, 'figure', {
    className: comparison.interactive ? 'sh-frame sh-frame--compare' : 'sh-frame',
    children: [media, zoom],
  });
}

/**
 * Build the whole gallery.
 *
 * @param {Document} doc
 * @param {ShareListing} listing
 * @param {string} token
 * @param {(index: number, trigger: any) => void} onOpen - Called with the flat slide index
 *   and the element that should receive focus back when the viewer closes.
 * @returns {{ node: any, slides: LightboxSlide[], rooms: import('./signoff.js').SignOffRoom[] }}
 *   `rooms` hands each room's <section> back to the caller so the sign-off panel can be
 *   appended INSIDE it. Returning the node rather than taking a builder keeps this module
 *   unaware that the reply path exists — a listing with no feedback endpoint renders from
 *   exactly the same code.
 */
export function buildGallery(doc, listing, token, onOpen) {
  /** @type {LightboxSlide[]} */
  const slides = [];
  const sections = [];
  /** @type {import('./signoff.js').SignOffRoom[]} */
  const rooms = [];

  listing.rooms.forEach((room, roomIndex) => {
    const headingId = `sh-room-${roomIndex + 1}`;
    const frames = room.frames.map((frame, frameIndex) => {
      const slideIndex = slides.length;
      slides.push({
        src: renderUrl(token, frame.renderId),
        alt: `${room.label}, photo ${frameIndex + 1} — virtually staged`,
        caption: room.label,
        width: frame.width,
        height: frame.height,
      });
      return buildFrame(doc, frame, token, room.label, frameIndex + 1, slideIndex, onOpen);
    });

    const section = el(doc, 'section', {
      className: 'sh-room',
      attrs: { 'aria-labelledby': headingId },
      children: [
        el(doc, 'div', {
          className: 'sh-room__head',
          children: [
            el(doc, 'h2', { className: 'sh-room__label', id: headingId, text: room.label }),
            el(doc, 'span', {
              className: 'sh-room__count',
              text: `${room.frames.length}`,
              attrs: { 'aria-hidden': 'true' },
            }),
          ],
        }),
        el(doc, 'div', { className: 'sh-room__frames', children: frames }),
      ],
    });

    sections.push(section);
    rooms.push({ key: room.key, label: room.label, node: section });
  });

  return {
    node: el(doc, 'div', { className: 'sh-gallery', children: sections }),
    slides,
    rooms,
  };
}
