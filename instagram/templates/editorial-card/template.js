import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, photoCard, fieldHeader, fieldFooter, escapeHtml, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'editorial-card',
  name: 'Editorial card',
  layoutFamily: 'editorial',
  formats: ['single', 'carousel'],
  slides: [2, 6],
  description: 'Deep blue editorial field with a letterspaced eyebrow, a two tone headline, a subhead, and the photography sitting inside as rounded cards.',
  tone: 'authoritative, explanatory',
  bestFor: 'Ideas that need a sentence of setup. The only layout with room for a headline, a subhead and a caption at once.',
  provenance: 'Lifted from the real post instagram/history/backfill/07-27.png.',
  slots: {
    'headline.lead': 'White clause. Under 40 characters.',
    'headline.accent': 'Pale blue clause. Under 40 characters.',
    subhead: 'One sentence of setup. Under 110 characters.',
    cards: 'One or two photo cards as { image, pill, caption }. In carousel mode, one card per slide.',
    cta: 'Text for the footer pill.',
    disclosure: 'Virtual staging disclosure.',
  },
};

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`editorial-card: unsupported format "${format}"`);

  const cards = data.cards ?? [];
  if (!cards.length) throw new Error('editorial-card needs at least one card');

  // Carousel: slide one carries the full headline, later slides carry just the card and a
  // short running title, so the deck reads as one thought rather than as repeated posters.
  const carousel = format === 'carousel';
  const shown = carousel ? [cards[slideIndex % cards.length]] : cards.slice(0, 2);
  const leadSlide = !carousel || slideIndex === 0;

  const heading = leadSlide
    ? `<div>
    ${headline(data.headline)}
    ${data.subhead ? `<div class="subhead">${escapeHtml(data.subhead)}</div>` : ''}
  </div>`
    : `<div>${headline({ lead: data.runningTitle ?? data.headline.lead })}</div>`;

  const body = `<div class="frame${format !== 'single' && format !== 'carousel' ? ' frame--tall' : ''} field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    ${heading}
    <div class="cards grow${shown.length > 1 ? ' cards--two' : ''}">
      ${shown.map((card) => photoCard(card)).join('\n      ')}
    </div>
    ${fieldFooter({
      note: data.disclosure ?? 'Virtually staged with Stagify.ai',
      // Only the last slide asks for the click. A CTA on every slide reads as an advert
      // rather than a thought, and it costs a slide's worth of attention each time.
      action: (!carousel || slideIndex === slideCount - 1) ? data.cta : null,
    })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
