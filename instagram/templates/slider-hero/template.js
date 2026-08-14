import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, labelPill, capsule, fieldHeader, fieldFooter, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'slider-hero',
  name: 'Slider hero',
  layoutFamily: 'fullbleed',
  formats: ['single', 'reel'],
  description: 'The site\'s own before and after comparison control rendered as a poster: one card, a vertical seam, a drag handle, and a single capsule of copy.',
  tone: 'quiet, let the pair speak',
  bestFor: 'A pair so good that any sentence you add is in the way. Also the natural reel, since the seam is the thing that moves.',
  slots: {
    'headline.lead': 'Centred, white. Under 30 characters.',
    'headline.accent': 'Centred, pale blue. Under 30 characters.',
    beforeImage: 'Left of the seam.',
    afterImage: 'Right of the seam. Same camera position.',
    caption: 'Optional capsule of copy under the card. Under 50 characters. Leave it out when the frame already carries a CTA pill, or the footer and the capsule read as two identical white lozenges stacked up the frame.',
    showHandle: 'Draw the round drag handle on the seam. Off by default: on a still it is furniture from a control that cannot be dragged. Worth turning on for the reel, where the seam actually moves.',
    split: 'Seam position as a percentage from the left, 30 to 70. Defaults to 50.',
  },
  animates: {
    // reel.js walks this from 0.25 to 0.75 so the seam sweeps across the room.
    '--split': 'The seam position. Animating it is the whole reel.',
  },
};

export function render(data, { format, brandCss }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`slider-hero: unsupported format "${format}"`);
  if (!data.beforeImage || !data.afterImage) {
    throw new Error('slider-hero needs both beforeImage and afterImage');
  }

  const split = data.split ?? 50;
  const tall = format !== 'single' && format !== 'carousel';

  const body = `<div class="frame${tall ? ' frame--tall' : ''} field--deep" style="--split: ${split};">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    ${headline(data.headline)}

    <div class="compare">
      <div class="compare__half" style="background-image: ${cssUrl(data.afterImage)};"></div>
      <div class="compare__half compare__half--before" style="background-image: ${cssUrl(data.beforeImage)};"></div>
      <div class="seam"></div>
      ${data.showHandle ? '<div class="handle">&#8249;&#8250;</div>' : ''}
      ${labelPill(data.beforeLabel ?? 'BEFORE', 'before')}
      ${labelPill(data.afterLabel ?? 'AFTER', 'after')}
    </div>

    ${data.caption ? `<div class="caption-row">${capsule(data.caption)}</div>` : ''}
    ${fieldFooter({
    note: data.disclosure ?? 'Virtually staged with Stagify.ai',
    action: data.cta,
  })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
