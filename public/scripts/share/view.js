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
import { buildCompare } from './compare.js';
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
 * The strip under the photo: what it was made from and when, on ONE line.
 *
 * A share page that says only "Staged room" leaves the recipient asking the questions it
 * exists to answer. Empty fields are skipped rather than printed with a blank value —
 * "Style: —" is noise, and a render staged before the column existed has no date.
 *
 * THE VALUES CARRY THEMSELVES, with no "STYLE" / "ROOM" / "STAGED" labels in front of
 * them. This was a labelled two-column list, and then a labelled row; both wrapped at
 * 360px — the low end of the phones this page is actually read on — and a wrapped row is
 * the stack it was supposed to replace. "Midcentury · Living room · Aug 1, 2026" fits with
 * room to spare, and a style name, a room name and a date need no column headings on a
 * page whose entire subject is one staged photograph.
 *
 * The separator is drawn by CSS rather than pushed into the text, so it is never read
 * aloud, never selected with a copy, and an omitted field takes its own dot with it.
 *
 * @param {{ manifest: any, doc?: Document }} arg @returns {Element | null}
 */
function renderFacts({ manifest, doc }) {
  const items = [];
  const add = (value) => {
    if (!value) return;
    items.push(el('span', { doc, className: 'sh-facts__item', text: value }));
  };
  // Style, then room, then date. `styleLabel` rather than the raw slug, so this says
  // "Midcentury" under a heading that says "Midcentury Living room" — and it is the
  // gallery's own function, not a second copy of the capitalisation rule.
  add(styleLabel(manifest.furnitureStyle));
  add(typeof manifest.roomType === 'string' ? manifest.roomType.trim() : '');
  add(formatStagedAt(manifest.stagedAt));
  if (!items.length) return null;
  return el('p', { doc, className: 'sh-facts', children: items });
}

/**
 * Render the frames.
 *
 * The image box is sized from the manifest's width/height BEFORE the bytes arrive, so the
 * page does not reflow when they land — a jump while somebody is looking at it reads as a
 * broken page, and on a phone it moves the thing they were about to tap.
 *
 * TWO SHAPES, decided by `frame.beforeUrl`. Without one — the default for every link, and
 * the only shape this page had until the setting existed — the staged photo IS the button,
 * exactly as before. With one, the box becomes the drag comparison (../share/compare.js,
 * the same builder the owner's own gallery uses) and the lightbox moves to a button of its
 * own beneath it, because a <button> may not contain the range input and the full-size view
 * is still the staged photo alone.
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

      /** @param {any} node */
      const pinRatio = (node) => {
        if (frame.width && frame.height) node.style.setProperty('--sh-ar', `${frame.width} / ${frame.height}`);
      };

      /** The image box, and whatever opens the full-size view. */
      const parts = [];
      if (frame.beforeUrl) {
        const before = /** @type {HTMLImageElement} */ (el('img', {
          doc,
          attrs: {
            src: frame.beforeUrl,
            // Named against the same label as the staged one, so a screen reader hears
            // which half of the pair it is on rather than two identical descriptions.
            alt: label ? `${label}, before staging` : 'The room before staging',
            loading: 'lazy',
            decoding: 'async',
          },
        }));
        const box = el('div', { doc, className: 'compare sh-frame__compare' });
        pinRatio(box);
        // The staged <img> built above is handed in rather than rebuilt: it carries the
        // srcset, the fullUrl and the renderId the lightbox and the refresher read off it.
        buildCompare({
          container: box,
          doc,
          beforeImg: before,
          afterImg: img,
          rangeLabel: 'Reveal the staged room',
          valueText: (percent) => `${percent}% staged`,
        });
        const full = el('button', {
          doc,
          className: 'sh-frame__full',
          attrs: { type: 'button' },
          text: 'View the staged photo full size',
        });
        full.addEventListener('click', () => onOpen(frame.url, label));
        parts.push(box, full);
        // Both images, so an expired presigned URL re-mints the whole comparison. They are
        // signed in the same manifest and age out together.
        frames.push(before);
      } else {
        const button = el('button', {
          doc,
          className: 'sh-frame__button',
          attrs: { type: 'button', 'aria-label': `View ${label || 'room'} full size` },
          children: [img],
        });
        pinRatio(button);
        button.addEventListener('click', () => onOpen(frame.url, label));
        parts.push(button);
      }

      nodes.push(el('figure', {
        doc,
        className: 'sh-frame',
        children: [
          ...parts,
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
