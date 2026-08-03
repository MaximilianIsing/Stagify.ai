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

/** The name to show when a render has neither a name of its own nor a room type. */
const untitled = () => t('gallery.detailTitle', 'Staged room');

/**
 * A furniture style as a person would write it.
 *
 * The stored value is a slug (`luxury`, `midcentury`), because that is what the studio's
 * <select> submits and what promptMatrix.js keys off. Printing it raw is how the detail
 * panel came to say "Style: modern" under a heading that says "Modern Bedroom".
 *
 * Capitalised rather than looked up in the pack, and that is the deliberate half: this
 * string is joined to `roomType`, which is server data and never translated. "Lujo
 * Bedroom" is a worse answer than "Luxury Bedroom" — half a name in each language reads
 * like a bug, where one consistent language reads like a default the owner can replace.
 * Renaming is the feature that makes that acceptable.
 *
 * @param {string} [style] @returns {string}
 */
export function styleLabel(style) {
  const slug = String(style ?? '').trim();
  if (!slug) return '';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * What to call this render when its owner has not named it.
 *
 * `<Style> <Room type>` — "Luxury Bedroom" — because those are the two things the owner
 * chose, and together they are the shortest phrase that distinguishes two renders of the
 * same room. Degrades a term at a time: no style leaves the room type alone, neither
 * leaves the generic heading.
 *
 * Derived on read rather than stored at insert, so it is not frozen: restyling the
 * default later re-labels every unnamed render instead of only the new ones.
 *
 * @param {any} entry @returns {string}
 */
export function defaultName(entry) {
  const style = styleLabel(entry?.furnitureStyle);
  const room = String(entry?.roomType ?? '').trim();
  if (style && room) return `${style} ${room}`;
  return room || untitled();
}

/**
 * What this render is called: the owner's own name, or the derived default.
 *
 * ONE definition, used by the card, the dialog heading and both alt texts. They disagreed
 * for a while — the card printed the room type and the aria-label printed something else
 * — and a card whose accessible name is not its visible name is the kind of thing only a
 * screen reader notices.
 *
 * @param {any} entry @returns {string}
 */
export function entryName(entry) {
  const own = String(entry?.name ?? '').trim();
  return own || defaultName(entry);
}

/** A photo's alt text. Built from the same name the card shows. */
const stagedAlt = (entry) => t('gallery.cardAlt', '{room}, staged', { room: entryName(entry) });

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
 * A short, local date AND time. Deliberately not relative ("3 days ago"): an agent looking
 * for the render they did for a specific viewing wants the timestamp.
 *
 * The time is here because the date alone cannot separate the six renders of one listing
 * that all happened on a Tuesday afternoon, which is what a session with this product
 * actually looks like — variations, retries, a second style. `toLocaleString`, not
 * `toLocaleDateString`, so each language gets its own order and its own 12/24-hour clock
 * from the tag `dateLocale()` resolved.
 *
 * Seconds are omitted on purpose: they make the string longer than the card can hold and
 * answer a question nobody asks.
 *
 * @param {number} ms @returns {string}
 */
export function formatWhen(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleString(dateLocale(), {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
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
 * Returns the cards it built, index-aligned with `entries`. The caller needs them because
 * a re-render DETACHES every existing card: the detail panel holds the one that opened it
 * so it can hand focus back, and a detached node fails closeDetail's isConnected guard and
 * silently drops focus to <body>. Handing the new nodes back is what lets a repaint
 * re-point at the same entry's card instead.
 *
 * @param {{ grid: Element | null, entries: any[], doc?: Document,
 *   onOpen: (entry: any, trigger: any) => void, append?: boolean }} arg
 * @returns {any[]} The cards built by THIS call — the appended ones only, when appending.
 */
export function renderGrid({ grid, entries, doc, onOpen, append = false }) {
  const cards = entries.map((entry) => {
    const img = el('img', {
      doc,
      className: 'gal-card__img',
      attrs: {
        src: entry.urls.thumb || entry.urls.after,
        alt: stagedAlt(entry),
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
          room: entryName(entry),
          when: formatWhen(entry.createdAt),
        }),
      },
      children: [
        img,
        el('span', {
          doc,
          className: 'gal-card__body',
          children: [
            el('span', { doc, className: 'gal-card__room', text: entryName(entry) }),
            // The name on its own line, then the date beneath it. These used to be three
            // inline spans joined by " · ", which wrapped into one run-on line at every
            // card width the grid actually produces — and the third was a "link on" pill,
            // which meant something while a link was a thing you switched on for chosen
            // rooms. Every entry has one now, so a badge on every tile said only that the
            // gallery had tiles.
            el('span', {
              doc,
              className: 'gal-card__meta',
              children: [
                el('span', { doc, className: 'gal-card__when', text: formatWhen(entry.createdAt) }),
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
    return cards;
  }
  replaceChildren(grid, cards);
  return cards;
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
    attrs: { src: entry.urls.after, alt: stagedAlt(entry) },
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
  // type, so they stay exactly as they were typed. The style is the one exception, and
  // only cosmetically: it is stored as the <select>'s slug, so it is capitalised through
  // the same helper the heading uses rather than printed as "modern" beneath a panel
  // titled "Modern Bedroom".
  add(t('gallery.meta.room', 'Room'), entry.roomType);
  add(t('gallery.meta.style', 'Style'), styleLabel(entry.furnitureStyle));
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
