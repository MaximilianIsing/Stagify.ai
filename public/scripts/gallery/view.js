// Rendering the gallery grid and the detail panel.
//
// Built through the share page's dom.js — same rule, same reason: every string here was
// typed by a person and none of it goes in as HTML. Reusing that module rather than
// copying it is also what keeps ONE definition of the no-innerHTML property, which is
// what test/frontend/share/share-page.test.js sweeps for.

import { el, replaceChildren } from '../share/dom.js';
import { LANG_BCP47 } from '../locale-data.js';
import { t } from './i18n.js';

/** 1x1 transparent GIF, so a failed tile has a valid src and no broken-image glyph. */
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** The name to show when a render has no room type. */
const untitled = () => t('gallery.detailTitle', 'Staged room');

/** A photo's alt text. `roomType` is server data and is never translated. */
const stagedAlt = (roomType) => (roomType
  ? t('gallery.cardAlt', '{room}, staged', { room: roomType })
  : t('gallery.detailTitle', 'Staged room'));

/**
 * The BCP-47 tag for the language the page is being read in, or undefined to let the
 * browser decide.
 *
 * Not the browser's locale: this page can be switched to Spanish in place, and a Spanish
 * page printing "Jul 27, 2026" is the same half-translated result the switcher exists to
 * avoid. Falls back to the browser when the choice is unset or unrecognised.
 */
function dateLocale() {
  try {
    const chosen = window.localStorage.getItem('selectedLanguage');
    return chosen && LANG_BCP47[chosen] ? LANG_BCP47[chosen] : undefined;
  } catch {
    // Storage blocked, or no window at all (the specs) — the browser default is right.
    return undefined;
  }
}

/**
 * A short, local date. Deliberately not relative ("3 days ago"): an agent looking for the
 * render they did for a specific viewing wants the date.
 * @param {number} ms @returns {string}
 */
export function formatWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/**
 * Render the grid.
 *
 * `append` is what the pager needs: the second page has to join the first rather than
 * replace it. It defaults to false so the plain re-render — which is what a delete does —
 * stays the obvious behaviour.
 *
 * @param {{ grid: Element | null, entries: any[], doc?: Document,
 *   onOpen: (entry: any, trigger: any) => void, append?: boolean }} arg
 */
export function renderGrid({ grid, entries, doc, onOpen, append = false }) {
  const cards = entries.map((entry) => {
    const img = el('img', {
      doc,
      className: 'gal-card__img',
      attrs: {
        src: entry.urls.thumb || entry.urls.after,
        alt: stagedAlt(entry.roomType),
        loading: 'lazy',
        decoding: 'async',
      },
    });
    // A thumbnail that will not load currently paints its alt text across the tile, which
    // reads as a broken page rather than a missing image. Fall back to the full render
    // once — thumb and after are separate objects, so one can be missing while the other
    // is fine — then give up quietly and let the card carry the name.
    const fallbackSrc = entry.urls.after && entry.urls.after !== entry.urls.thumb ? entry.urls.after : '';
    let swapped = false;
    img.addEventListener('error', () => {
      if (!swapped && fallbackSrc) {
        swapped = true;
        img.setAttribute('src', fallbackSrc);
        return;
      }
      // The card's aria-label still names the room, so dropping the alt costs nothing
      // and stops the tile filling with text. The transparent pixel is what removes the
      // browser's own broken-image glyph — without a loadable src it draws one over the
      // placeholder, which is the thing this is trying to get rid of.
      img.setAttribute('alt', '');
      img.setAttribute('src', TRANSPARENT_PIXEL);
      img.className = 'gal-card__img gal-card__img--missing';
    });

    const card = el('button', {
      doc,
      className: 'gal-card',
      attrs: {
        type: 'button',
        'aria-label': t('gallery.cardOpen', 'Open {room} from {when}', {
          room: entry.roomType || t('gallery.untitledLower', 'staged room'),
          when: formatWhen(entry.createdAt),
        }),
      },
      children: [
        img,
        el('span', {
          doc,
          className: 'gal-card__body',
          children: [
            el('span', { doc, className: 'gal-card__room', text: entry.roomType || untitled() }),
            // Room on its own line, then date and status on a row beneath it. These used
            // to be three inline spans joined by " · ", which wrapped into one run-on
            // line at every card width the grid actually produces.
            el('span', {
              doc,
              className: 'gal-card__meta',
              children: [
                el('span', { doc, className: 'gal-card__when', text: formatWhen(entry.createdAt) }),
                // A visible marker, because a shared entry behaves differently: the
                // free-tier cap protects it, and turning the link off is a thing the
                // agent may need to find later.
                entry.share?.active
                  ? el('span', { doc, className: 'gal-card__shared', text: t('gallery.linkOn', 'link on') })
                  : null,
              ],
            }),
          ],
        }),
      ],
    });
    if (entry.width && entry.height) card.style.setProperty('--gal-ar', `${entry.width} / ${entry.height}`);
    // The card is handed back so the detail panel can return focus to whichever one
    // opened it, rather than dropping it on <body>.
    card.addEventListener('click', () => onOpen(entry, card));
    return card;
  });
  if (append) {
    for (const card of cards) grid?.appendChild(card);
    return;
  }
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
 * The slider is returned rather than looked up again: it is the one control in the panel
 * with no id, and handing it back keeps the caller off querySelectorAll.
 *
 * @param {{ container: Element | null, entry: any, doc?: Document }} arg
 * @returns {any} The range input, or null when there is nothing to compare.
 */
export function renderCompare({ container, entry, doc }) {
  const after = el('img', {
    doc,
    attrs: { src: entry.urls.after, alt: stagedAlt(entry.roomType) },
  });
  if (!entry.urls.before) {
    replaceChildren(container, [after]);
    return null;
  }

  const before = el('img', {
    doc,
    attrs: { src: entry.urls.before, alt: t('gallery.compare.beforeAlt', 'The room before staging') },
  });
  after.className = 'gal-compare__after';
  const range = el('input', {
    doc,
    className: 'gal-compare__range',
    attrs: {
      type: 'range',
      min: '0',
      max: '100',
      value: '50',
      'aria-label': t('gallery.compare.rangeLabel', 'Reveal the staged room'),
    },
  });
  range.addEventListener('input', () => {
    /** @type {any} */ (container).style.setProperty('--gal-split', `${/** @type {any} */ (range).value}%`);
  });
  replaceChildren(container, [before, after, range]);
  return range;
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
  // The LABELS translate; the VALUES are the agent's own words and the server's room
  // type, so they stay exactly as they were typed.
  add(t('gallery.meta.room', 'Room'), entry.roomType);
  add(t('gallery.meta.style', 'Style'), entry.furnitureStyle);
  add(t('gallery.meta.prompt', 'Extra prompt'), entry.additionalPrompt);
  add(t('gallery.meta.removed', 'Removed furniture'), entry.removeFurniture ? t('gallery.meta.yes', 'Yes') : '');
  add(t('gallery.meta.staged', 'Staged'), formatWhen(entry.createdAt));
  if (entry.references?.length) {
    add(
      t('gallery.meta.references', 'Furniture photos'),
      t('gallery.meta.referenceCount', '{count} attached', { count: entry.references.length }),
    );
  }
  replaceChildren(container, rows);
}
