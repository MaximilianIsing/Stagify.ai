import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, lockup, labelPill, cta, disclosure, headline, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'inset-before',
  name: 'Inset before',
  layoutFamily: 'inset',
  formats: ['single', 'story', 'reel', 'carousel'],
  description: 'The staged render fills the frame and the original photo sits in the upper corner as a small labelled card. A before and after with no seam: the two photos never have to line up.',
  tone: 'confident, product forward, the render is the hero',
  bestFor: 'A before and after where the two photographs do NOT register. A seam layout needs the furniture in roughly the same footprint on both sides, so a staging that rearranges the room reads as two rooms in one frame. This says "here is the room, here is what it used to be" instead, which is also how a listing actually presents itself.',
  provenance: 'Written for 2026-09-09 after the diagonal-reveal version of that post was rejected. The period bed and the staged bed sat in different places, so every seam angle read as one room containing two beds.',
  slots: {
    'headline.lead': 'First clause, white. Under 26 characters.',
    'headline.accent': 'Second clause, brand blue. Under 26 characters.',
    afterImage: 'The staged render. Fills the frame, so this is the hero and it must be the stronger photograph.',
    beforeImage: 'The original room. Shown small, in the corner card.',
    beforeLabel: 'Card label. Defaults to BEFORE.',
    cta: 'Short action phrase for the bottom right pill.',
    disclosure: 'Virtual staging disclosure. Required when afterImage is a render.',
    insetCorner: 'Which top corner the card sits in, "left" or "right". Defaults to left, which keeps it clear of the logo lockup.',
    insetWidth: 'Card width in px at 4:5, 260 to 420. Defaults to 330.',
  },
};

const MIN_INSET = 260;
const MAX_INSET = 420;

/**
 * @param {object} data see meta.slots
 * @param {{ format: keyof typeof FRAME, brandCss: string }} ctx
 * @returns {string} a complete HTML document
 */
export function render(data, { format, brandCss }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`inset-before: unsupported format "${format}"`);
  if (!data.beforeImage || !data.afterImage) {
    throw new Error('inset-before needs both beforeImage and afterImage');
  }

  const corner = data.insetCorner ?? 'left';
  if (!['left', 'right'].includes(corner)) {
    throw new Error(`inset-before: insetCorner must be "left" or "right", got "${corner}"`);
  }

  // Clamped rather than trusted. Too small and the before is unreadable at feed size, which
  // defeats the layout; too large and it starts competing with the render it is annotating.
  const requested = data.insetWidth ?? 330;
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    throw new Error(`inset-before: insetWidth must be a number, got ${JSON.stringify(requested)}`);
  }
  const insetWidth = Math.min(MAX_INSET, Math.max(MIN_INSET, requested));

  // The card is 4:5 like the frame, so it reads as a photograph rather than a crop.
  const insetHeight = Math.round(insetWidth * 1.25);

  const tall = format !== 'single' && format !== 'carousel';

  const body = `<div class="frame${tall ? ' frame--tall' : ''} frame--inset-${corner}" style="
  --inset-w: ${insetWidth}px;
  --inset-h: ${insetHeight}px;
">
  <div class="photo photo--after" style="background-image: ${cssUrl(data.afterImage)};"></div>

  <div class="top">
    ${lockup()}
  </div>

  <figure class="inset">
    <div class="inset__photo" style="background-image: ${cssUrl(data.beforeImage)};"></div>
    <figcaption class="inset__label">${labelPill(data.beforeLabel ?? 'BEFORE', 'before')}</figcaption>
  </figure>

  <div class="scrim"></div>

  <div class="bottom">
    ${headline(data.headline)}
    <div class="footer">
      ${disclosure(data.disclosure ?? 'Virtually staged with Stagify.ai')}
      ${cta(data.cta ?? 'Try free at Stagify.ai')}
    </div>
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
