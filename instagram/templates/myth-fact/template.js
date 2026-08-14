import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, fieldHeader, fieldFooter, escapeHtml, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'myth-fact',
  name: 'Myth and fact',
  layoutFamily: 'card',
  formats: ['single', 'carousel'],
  slides: [2, 5],
  description: 'Two stacked panels on the deep blue ground: the belief in muted red on top, the correction in brand blue below, each one line with an optional note and a small supporting photo.',
  tone: 'direct, unflinching, never smug',
  bestFor: 'The objections a competitor would rather not raise. Disclosure rules, "is this deceptive", "buyers feel tricked". Answering those honestly outperforms another before and after.',
  slots: {
    'headline.lead': 'White clause. Under 34 characters.',
    'headline.accent': 'Pale blue clause. Under 34 characters.',
    pairs: 'Two to five { myth, fact, mythNote, factNote, image }. One pair per slide in carousel mode.',
    cta: 'Footer pill text.',
  },
  rules: [
    'Never invent the myth. Use one a real agent has actually said.',
    'The fact has to be checkable. A myth answered with marketing copy is worse than not posting.',
  ],
};

function panel(kind, line, note, image) {
  if (!line) return '';
  const tag = kind === 'myth' ? 'Myth' : 'Fact';
  return `<div class="panel panel--${kind}${image ? ' panel--has-photo' : ''}">
      ${image ? `<div class="panel__photo" style="background-image: ${cssUrl(image)};"></div>` : ''}
      <span class="panel__tag">${tag}</span>
      <div class="panel__line">${escapeHtml(line)}</div>
      ${note ? `<div class="panel__note">${escapeHtml(note)}</div>` : ''}
    </div>`;
}

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`myth-fact: unsupported format "${format}"`);

  const pairs = data.pairs ?? [];
  if (!pairs.length) throw new Error('myth-fact needs at least one { myth, fact } pair');

  const carousel = format === 'carousel';
  const pair = pairs[carousel ? slideIndex % pairs.length : 0];
  if (!pair.myth || !pair.fact) throw new Error('every myth-fact pair needs both a myth and a fact');

  const body = `<div class="frame field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    ${slideIndex === 0 || !carousel ? headline(data.headline) : ''}
    ${panel('myth', pair.myth, pair.mythNote, null)}
    ${panel('fact', pair.fact, pair.factNote, pair.image)}
    ${fieldFooter({
    note: data.disclosure ?? 'Virtually staged with Stagify.ai',
    action: (!carousel || slideIndex === slideCount - 1) ? data.cta : null,
  })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
