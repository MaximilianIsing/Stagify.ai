import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, fieldHeader, fieldFooter, escapeHtml, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'annotated-callout',
  name: 'Annotated callout',
  layoutFamily: 'annotated',
  formats: ['single', 'carousel'],
  slides: [2, 4],
  description: 'One render marked with numbered pins and a numbered legend beneath it, calling out the specific staging decisions in the image.',
  tone: 'explanatory, specific, no adjectives',
  bestFor: 'The objection that AI staging is generic. Naming three decisions is the answer, and this is the only layout that can.',
  slots: {
    'headline.lead': 'White clause. Under 34 characters.',
    'headline.accent': 'Pale blue clause. Under 34 characters.',
    image: 'The staged render being annotated.',
    callouts: 'Three or four { x, y, text }. x and y are percentages across and down the photo. Text under 70 characters.',
    cta: 'Footer pill text.',
  },
  rules: [
    'Every callout must point at something actually visible at that coordinate. A pin on empty wall is worse than no pin.',
    'Three or four. Two looks thin, five turns the legend into a paragraph.',
  ],
};

const MIN = 3;
const MAX = 4;

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`annotated-callout: unsupported format "${format}"`);

  const carousel = format === 'carousel';
  const shots = carousel ? (data.shots ?? [data]) : [data];
  const shot = shots[slideIndex % shots.length];

  const callouts = shot.callouts ?? [];
  if (callouts.length < MIN || callouts.length > MAX) {
    throw new Error(`annotated-callout wants ${MIN} to ${MAX} callouts, got ${callouts.length}`);
  }
  if (!shot.image) throw new Error('annotated-callout needs an image');

  for (const c of callouts) {
    if (typeof c.x !== 'number' || typeof c.y !== 'number') {
      throw new Error('every callout needs numeric x and y percentages');
    }
    // Keep pins off the edges: a pin at 2% is half outside the rounded corner.
    if (c.x < 6 || c.x > 94 || c.y < 6 || c.y > 94) {
      throw new Error(`callout at ${c.x},${c.y} is too close to the edge. Keep both between 6 and 94.`);
    }
  }

  const pins = callouts
    .map((c, i) => `<div class="pin" style="left: ${c.x}%; top: ${c.y}%;">${i + 1}</div>`)
    .join('\n      ');

  const legend = callouts
    .map((c, i) => `<div class="legend__row">
        <span class="legend__num">${i + 1}</span>
        <div class="legend__text">${escapeHtml(c.text)}</div>
      </div>`)
    .join('\n      ');

  const body = `<div class="frame field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    ${headline(shot.headline ?? data.headline)}

    <div class="shot">
      <div class="shot__photo" style="background-image: ${cssUrl(shot.image)};"></div>
      ${pins}
    </div>

    <div class="legend">
      ${legend}
    </div>

    ${fieldFooter({
    note: data.disclosure ?? 'Virtually staged with Stagify.ai',
    action: (!carousel || slideIndex === slideCount - 1) ? data.cta : null,
  })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
