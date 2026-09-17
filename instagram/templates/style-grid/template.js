import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, photoCard, fieldHeader, fieldFooter, escapeHtml, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'style-grid',
  name: 'Style grid',
  layoutFamily: 'grid',
  formats: ['single', 'carousel'],
  slides: [2, 6],
  description: 'One empty source photo up top, then the same room rendered in several styles below in an asymmetric grid, each with a style pill and a one line caption.',
  tone: 'demonstrative, let the images argue',
  bestFor: 'Style preset breadth, and the strongest proof the account has: one photo genuinely becoming many rooms.',
  provenance: 'Lifted from the real post instagram/history/backfill/07-26.png.',
  slots: {
    'headline.lead': 'White clause. Under 34 characters.',
    'headline.accent': 'Pale blue clause. Under 34 characters.',
    subhead: 'One sentence. Under 100 characters.',
    sourceImage: 'The empty room every variant was made from.',
    sourceLabel: 'Pill on the source photo. Defaults to EMPTY ROOM.',
    sourceCaption: 'Optional line under the source pill, matching the one line note each variant carries. Without it the source card is the only one in the grid with a bare pill, which reads as a missing caption rather than a deliberate one.',
    sourceInline: 'Optional. True folds the source into the grid as the first card so every card is cut to the same shape, instead of giving it a wide hero band. Use it when the point is that the panels are one room; leave it off when the source should dominate.',
    variants: 'Three to five { image, pill, caption }. The pill is the style name, the caption is who it sells to.',
    cta: 'Footer pill text.',
  },
};

const MIN_VARIANTS = 3;

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`style-grid: unsupported format "${format}"`);

  const variants = data.variants ?? [];
  if (variants.length < MIN_VARIANTS) {
    throw new Error(
      `style-grid needs at least ${MIN_VARIANTS} variants to make its point; got ${variants.length}. `
      + 'With fewer, use diagonal-reveal or editorial-card instead.',
    );
  }
  if (!data.sourceImage) throw new Error('style-grid needs a sourceImage, the empty room');

  const carousel = format === 'carousel';
  // Carousel mode walks the variants two at a time so each slide is legible on a phone,
  // where a five-up grid is a row of thumbnails nobody can read.
  const perSlide = carousel ? 2 : variants.length;
  const shown = carousel
    ? variants.slice(slideIndex * perSlide, slideIndex * perSlide + perSlide)
    : variants;

  // `sourceInline` folds the source photo into the grid as the first card instead of
  // giving it a wide hero band of its own.
  //
  // The default hero is a full-width landscape strip while the variants are narrow and
  // tall, so the before and the afters are cropped to different shapes out of the same
  // portrait photographs. On a post whose whole claim is "this is one room, only the
  // furniture changed", four different crops make the reader do the comparison across
  // three aspect ratios, and the before ends up showing none of the ceiling and floor
  // that the afters are dominated by. Inline, every card is cut to one shape, so the
  // eye can actually hold them against each other. Off by default: the hero band is
  // right whenever the source deserves to dominate, which is most style-preset posts.
  const inline = data.sourceInline === true && !carousel;
  const sourceCard = {
    image: data.sourceImage,
    pill: data.sourceLabel ?? 'EMPTY ROOM',
    caption: data.sourceCaption,
    lightPill: true,
  };
  const cards = inline ? [sourceCard, ...shown] : shown;

  // Inline aims for a balanced block rather than a wide row: four cards read far better
  // as two by two than as four slivers, and equal columns are what keeps every card the
  // same shape. Square-ish counts get their square; five or more fall back to three up.
  const cols = inline
    ? (cards.length === 4 ? 2 : (cards.length >= 5 ? 3 : cards.length))
    : (shown.length >= 3 ? 3 : 2);

  // A last row that does not divide evenly leaves a hole, and a hole in a grid of photos
  // reads as a missing image rather than as a design choice. Stretch the final card across
  // whatever is left: 4 items in 3 columns gives 3 then 1 full width, 5 gives 3 then 1 plus
  // a double. Works for any count without special cases.
  //
  // Not applied inline, where a stretched last card would be the one thing breaking the
  // uniform shape that inline exists to provide.
  const remainder = cards.length % cols;
  const lastSpan = (inline || remainder === 0) ? 1 : cols - remainder + 1;

  const grid = cards
    .map((v, i) => {
      const span = i === cards.length - 1 ? lastSpan : 1;
      return photoCard({
        ...v,
        style: span > 1 ? `grid-column: span ${span};` : '',
      });
    })
    .join('\n      ');

  const body = `<div class="frame field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    <div>
      ${headline(data.headline)}
      ${data.subhead ? `<div class="subhead">${escapeHtml(data.subhead)}</div>` : ''}
    </div>
    ${inline ? '' : `<div class="hero">
      ${photoCard(sourceCard)}
    </div>`}
    <div class="variants" style="--cols: ${cols};">
      ${grid}
    </div>
    ${fieldFooter({
      note: data.disclosure ?? 'Virtually staged with Stagify.ai',
      action: (!carousel || slideIndex === slideCount - 1) ? data.cta : null,
    })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
