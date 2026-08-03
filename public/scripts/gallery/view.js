// Rendering the gallery grid and the detail panel.
//
// Built through the share page's dom.js — same rule, same reason: every string here was
// typed by a person and none of it goes in as HTML. Reusing that module rather than
// copying it is also what keeps ONE definition of the no-innerHTML property, which is
// what test/frontend/share/share-page.test.js sweeps for.

import { el, replaceChildren } from '../share/dom.js';
import { LANG_BCP47 } from '../locale-data.js';
import { styleLabel, defaultName as baseDefaultName, entryName as baseEntryName } from '../render-name.js';
import { t } from './i18n.js';

/** 1x1 transparent GIF, so a failed tile has a valid src and no broken-image glyph. */
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** The name to show when a render has neither a name of its own nor a room type. */
const untitled = () => t('gallery.detailTitle', 'Staged room');

/**
 * The naming rule itself lives in scripts/render-name.js, because the PUBLIC share page
 * shows the same label over the same photo and two copies of "<Style> <Room type>" would
 * drift the first time either page was touched. These two wrappers exist only to bind the
 * translated fallback, which is the one part the share page cannot share (it loads no
 * language pack at all).
 *
 * ONE definition matters within this file too: the card, the dialog heading and both alt
 * texts all call `entryName`. They disagreed for a while — the card printed the room type
 * and the aria-label printed something else — and a card whose accessible name is not its
 * visible name is the kind of thing only a screen reader notices.
 */
export { styleLabel };

/**
 * What to call this render when its owner has not named it.
 * @param {any} entry @returns {string}
 */
export function defaultName(entry) {
  return baseDefaultName(entry, untitled());
}

/**
 * What this render is called: the owner's own name, or the derived default.
 * @param {any} entry @returns {string}
 */
export function entryName(entry) {
  return baseEntryName(entry, untitled());
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
    return whenFormatter().format(new Date(ms));
  } catch {
    return '';
  }
}

/** The last formatter, and the tag it was built for. @type {{ tag: string | undefined, fmt: Intl.DateTimeFormat } | null} */
let whenFmt = null;

/**
 * The date formatter for the reader's current language.
 *
 * Keyed on the resolved TAG rather than cached outright, which is what makes it survive
 * the in-place language switch: a formatter pinned at boot would print English dates under
 * a Spanish grid, and this page swaps its pack without navigating.
 *
 * Worth caching because `toLocaleString` constructs a new Intl.DateTimeFormat on every
 * call, and every card calls it TWICE — once for the visible text and once for the
 * aria-label. At a page of 60 that was ~120 formatters and 120 localStorage reads, and the
 * whole lot again on every language switch. Reading `selectedLanguage` per call is the
 * cheap half; building the formatter is not.
 *
 * @returns {Intl.DateTimeFormat}
 */
function whenFormatter() {
  const tag = dateLocale();
  if (whenFmt && whenFmt.tag === tag) return whenFmt.fmt;
  whenFmt = {
    tag,
    fmt: new Intl.DateTimeFormat(tag, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
  };
  return whenFmt.fmt;
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
 *   onOpen: (entry: any, trigger: any) => void, append?: boolean,
 *   onImage?: (img: any) => void }} arg - `onImage` sees every <img> as it is built, so
 *   the page can hand it to the expiry refresher. A callback rather than a second return
 *   value because the return type is load-bearing: it is the CARDS, index-aligned with
 *   `entries`, and the focus-restore logic depends on that.
 * @returns {any[]} The cards built by THIS call — the appended ones only, when appending.
 */
export function renderGrid({ grid, entries, doc, onOpen, append = false, onImage }) {
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
    onImage?.(img);
    // A thumbnail that will not load currently paints its alt text across the tile, which
    // reads as a broken page rather than a missing image. Fall back to the full render
    // once — thumb and after are separate objects, so one can be missing while the other
    // is fine — then give up quietly and let the card carry the name.
    //
    // This still earns its place for a genuinely missing object, but it CANNOT rescue an
    // expired URL: thumb and after are presigned in the same response, at the same instant,
    // with the same TTL, so when one has aged out so has the other. That case is the
    // refresher's (onImage above); the placeholder shows for one debounce interval and is
    // then repainted with a fresh URL.
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

  // Each card gets a role="listitem" wrapper, because #gal-grid carries role="list" and a
  // list whose children are buttons is invalid ARIA — some readers announce "list, 0
  // items", which is worse than the bare run of buttons it replaced. The wrapper becomes
  // the CSS grid item and .gal-card is already display:block/width:100%, so it fills it
  // and the layout is unchanged; NOT display:contents, which has a history of dropping
  // the very role it would be carrying.
  const items = cards.map((card) => el('div', {
    doc,
    className: 'gal-card-wrap',
    attrs: { role: 'listitem' },
    children: [card],
  }));

  if (append) {
    for (const item of items) grid?.appendChild(item);
    return cards;
  }
  replaceChildren(grid, items);
  // The CARDS, never the wrappers: the caller focuses these and compares them against the
  // node the panel was opened from.
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
 * @param {{ container: Element | null, entry: any, doc?: Document,
 *   onImage?: (img: any) => void }} arg - `onImage` sees both images, so an expired panel
 *   recovers the same way the grid does. Both, not just `after`: they are presigned in the
 *   same response and age out together.
 * @returns {any} The range input, or null when there is nothing to compare.
 */
export function renderCompare({ container, entry, doc, onImage }) {
  const after = el('img', {
    doc,
    attrs: { src: entry.urls.after, alt: stagedAlt(entry) },
  });
  onImage?.(after);
  if (!entry.urls.before) {
    replaceChildren(container, [after]);
    return null;
  }

  const before = el('img', {
    doc,
    attrs: { src: entry.urls.before, alt: t('gallery.compare.beforeAlt', 'The room before staging') },
  });
  onImage?.(before);
  after.className = 'gal-compare__after';
  // A bare number is what a screen reader announces for a range without this — "50",
  // with no unit and no clue which half of the comparison it refers to.
  const valueText = (v) => t('gallery.compare.rangeValue', '{percent}% staged', { percent: v });
  const range = el('input', {
    doc,
    className: 'gal-compare__range',
    attrs: {
      type: 'range',
      min: '0',
      max: '100',
      value: '50',
      'aria-label': t('gallery.compare.rangeLabel', 'Reveal the staged room'),
      'aria-valuetext': valueText('50'),
    },
  });
  range.addEventListener('input', () => {
    const value = /** @type {any} */ (range).value;
    /** @type {any} */ (container).style.setProperty('--gal-split', `${value}%`);
    range.setAttribute('aria-valuetext', valueText(value));
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
