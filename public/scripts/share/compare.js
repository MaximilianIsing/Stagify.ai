// The before/after comparison, built once for both pages.
//
// The owner's gallery has drawn this control since it shipped; the public share page now
// draws it too, whenever the owner has ticked "include the before photo" for that render.
// Rather than a second implementation over there, the mechanism lives here and each page
// supplies what differs — which is only the container and the words.
//
// THE WORDS ARE PARAMETERS, NOT LOOKUPS. The gallery translates them through its language
// pack; the share page has no pack and no `data-lang` (test/frontend/share/share-page.test.js
// forbids the attribute there), so it passes English literals. A `t()` call in this file
// would drag a dependency the share page cannot satisfy across the seam.
//
// It lives under scripts/share/ rather than scripts/gallery/ because gallery/view.js
// already imports its element builders from ./dom.js here — the dependency runs this way
// round, and pointing it back the other way would make the public page import from the
// authenticated one.
import { el, replaceChildren } from './dom.js';

/**
 * Build the comparison into a container.
 *
 * The output is exactly `[before, after, range]` and the specs pin that order: the before
 * image is in flow and sizes the box, the after is absolutely positioned and clipped, and
 * the range is a transparent full-bleed hit layer above both. The single `--compare-split`
 * variable drives the clip and the two pseudo-elements, so they cannot disagree.
 *
 * @param {{ container: any, beforeUrl?: string, afterUrl?: string, beforeAlt?: string,
 *   afterAlt?: string, beforeImg?: any, afterImg?: any, rangeLabel: string,
 *   valueText: (percent: string) => string, doc?: Document,
 *   onImage?: (img: any) => void }} arg - Pass the URLs and this builds the two images, or
 *   pass `beforeImg`/`afterImg` when the caller has already built one it needs to keep: the
 *   share page's staged image carries a srcset and a dataset the lightbox reads off it.
 *   `onImage` sees BOTH images either way — they are presigned in the same response and age
 *   out together, so a recovery watching only the staged one leaves half the control blank.
 * @returns {any} The range input — the one control here with no id, handed back so the
 *   caller never has to query for it.
 */
export function buildCompare({
  container, beforeUrl, afterUrl, beforeAlt, afterAlt, beforeImg, afterImg,
  rangeLabel, valueText, doc, onImage,
}) {
  const before = beforeImg ?? el('img', { doc, attrs: { src: beforeUrl, alt: beforeAlt ?? '' } });
  const after = afterImg ?? el('img', { doc, attrs: { src: afterUrl, alt: afterAlt ?? '' } });
  // Applied rather than assumed, so a caller's own image lands in the clipped layer without
  // having to know the class name.
  after.className = 'compare__after';
  onImage?.(before);
  onImage?.(after);

  const range = el('input', {
    doc,
    className: 'compare__range',
    attrs: {
      type: 'range',
      min: '0',
      max: '100',
      value: '50',
      'aria-label': rangeLabel,
      // A bare number is what a screen reader announces for a range without this — "50",
      // with no unit and no clue which half of the comparison it refers to.
      'aria-valuetext': valueText('50'),
    },
  });
  range.addEventListener('input', () => {
    const value = /** @type {any} */ (range).value;
    /** @type {any} */ (container).style.setProperty('--compare-split', `${value}%`);
    range.setAttribute('aria-valuetext', valueText(value));
  });

  replaceChildren(container, [before, after, range]);
  return range;
}
