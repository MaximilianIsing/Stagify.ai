import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, photoCard, fieldHeader, fieldFooter, escapeHtml, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'stat-card',
  name: 'Stat card',
  layoutFamily: 'type-first',
  formats: ['single', 'story'],
  description: 'One large number on the deep blue field, a short claim under it, and a photo band across the lower third.',
  tone: 'blunt, factual',
  bestFor: 'A single checkable figure. Also the layout that breaks up a grid full of before and afters, which is half its value.',
  slots: {
    figure: 'The number itself, digits only where possible. Under 6 characters.',
    unit: 'Optional suffix rendered smaller, for example "s" or "x" or "%".',
    claim: 'What the number means. Under 60 characters.',
    support: 'One clarifying sentence. Optional, under 120 characters.',
    source: 'Where the figure comes from. Required whenever the number is not something Stagify measured itself.',
    image: 'Photo for the lower band.',
    cta: 'Footer pill text.',
  },
  rules: [
    'Never invent a figure. If it cannot be sourced or measured, use a different template.',
    'A figure about Stagify itself needs no source line. Anything about the market does.',
  ],
};

export function render(data, { format, brandCss }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`stat-card: unsupported format "${format}"`);
  if (!data.figure) throw new Error('stat-card needs a figure');
  if (!data.claim) throw new Error('stat-card needs a claim saying what the figure means');
  if (!data.image) throw new Error('stat-card needs an image for the lower band');

  const tall = format === 'story' || format === 'reel';

  const body = `<div class="frame${tall ? ' frame--tall' : ''} field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}

    <div class="stat">
      <div class="numeral numeral--brand">${escapeHtml(data.figure)}${
  data.unit ? `<span class="unit">${escapeHtml(data.unit)}</span>` : ''
}</div>
      <div class="claim">${escapeHtml(data.claim)}</div>
      ${data.support ? `<div class="support">${escapeHtml(data.support)}</div>` : ''}
      ${data.source ? `<div class="source">${escapeHtml(data.source)}</div>` : ''}
    </div>

    <div class="band">
      ${photoCard({ image: data.image, pill: data.imagePill, caption: data.imageCaption })}
    </div>

    ${fieldFooter({
    note: data.disclosure ?? 'Virtually staged with Stagify.ai',
    action: data.cta,
  })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.claim ?? 'Stagify post' });
}
