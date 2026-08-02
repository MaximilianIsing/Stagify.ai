// Rendering the gallery grid and the detail panel.
//
// Built through the share page's dom.js — same rule, same reason: every string here was
// typed by a person and none of it goes in as HTML. Reusing that module rather than
// copying it is also what keeps ONE definition of the no-innerHTML property, which is
// what test/frontend/share/share-page.test.js sweeps for.

import { el, replaceChildren } from '../share/dom.js';

/**
 * A short, local date. Deliberately not relative ("3 days ago"): an agent looking for the
 * render they did for a specific viewing wants the date.
 * @param {number} ms @returns {string}
 */
export function formatWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Render the grid.
 * @param {{ grid: Element | null, entries: any[], doc?: Document,
 *   onOpen: (entry: any) => void }} arg
 */
export function renderGrid({ grid, entries, doc, onOpen }) {
  const cards = entries.map((entry) => {
    const img = el('img', {
      doc,
      className: 'gal-card__img',
      attrs: {
        src: entry.urls.thumb || entry.urls.after,
        alt: entry.roomType ? `${entry.roomType}, staged` : 'Staged room',
        loading: 'lazy',
        decoding: 'async',
      },
    });
    const card = el('button', {
      doc,
      className: 'gal-card',
      attrs: { type: 'button', 'aria-label': `Open ${entry.roomType || 'staged room'} from ${formatWhen(entry.createdAt)}` },
      children: [
        img,
        el('span', {
          doc,
          className: 'gal-card__body',
          children: [
            el('span', { doc, className: 'gal-card__room', text: entry.roomType || 'Staged room' }),
            el('span', { doc, className: 'gal-card__when', text: ` · ${formatWhen(entry.createdAt)}` }),
            // A visible marker, because a shared entry behaves differently: the free-tier
            // cap protects it, and turning the link off is a thing the agent may need to
            // find later.
            entry.share?.active ? el('span', { doc, className: 'gal-card__shared', text: ' · link on' }) : null,
          ],
        }),
      ],
    });
    if (entry.width && entry.height) card.style.setProperty('--gal-ar', `${entry.width} / ${entry.height}`);
    card.addEventListener('click', () => onOpen(entry));
    return card;
  });
  replaceChildren(grid, cards);
}

/**
 * Render the before/after comparison.
 *
 * A slider rather than a toggle: the value of a before/after is seeing the SAME framing
 * change, and a toggle makes the eye re-find the room each time. When there is no before
 * — the source failed to encode — it degrades to the staged image on its own, with no
 * control to drag.
 *
 * @param {{ container: Element | null, entry: any, doc?: Document }} arg
 */
export function renderCompare({ container, entry, doc }) {
  const after = el('img', {
    doc,
    attrs: { src: entry.urls.after, alt: entry.roomType ? `${entry.roomType}, staged` : 'Staged room' },
  });
  if (!entry.urls.before) {
    replaceChildren(container, [after]);
    return;
  }

  const before = el('img', {
    doc,
    attrs: { src: entry.urls.before, alt: 'The room before staging' },
  });
  after.className = 'gal-compare__after';
  const range = el('input', {
    doc,
    className: 'gal-compare__range',
    attrs: { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Reveal the staged room' },
  });
  range.addEventListener('input', () => {
    /** @type {any} */ (container).style.setProperty('--gal-split', `${/** @type {any} */ (range).value}%`);
  });
  replaceChildren(container, [before, after, range]);
}

/**
 * Render what was asked for. This is the reason a gallery beats a downloads folder.
 * @param {{ container: Element | null, entry: any, doc?: Document }} arg
 */
export function renderMeta({ container, entry, doc }) {
  const rows = [];
  const add = (label, value) => {
    if (!value) return;
    rows.push(el('dt', { doc, text: label }));
    rows.push(el('dd', { doc, text: value }));
  };
  add('Room', entry.roomType);
  add('Style', entry.furnitureStyle);
  add('Extra prompt', entry.additionalPrompt);
  add('Removed furniture', entry.removeFurniture ? 'Yes' : '');
  add('Staged', formatWhen(entry.createdAt));
  if (entry.references?.length) add('Furniture photos', `${entry.references.length} attached`);
  replaceChildren(container, rows);
}
