import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, headline, fieldHeader, fieldFooter, escapeHtml, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'process-strip',
  name: 'Process strip',
  layoutFamily: 'sequence',
  formats: ['single', 'story', 'carousel'],
  slides: [2, 5],
  description: 'Numbered steps as full width horizontal bands, each with a title, a short note and a photo on the right.',
  tone: 'instructional, concrete',
  bestFor: 'Showing that the whole job is three steps. Works for the core flow and for any studio feature with a sequence.',
  slots: {
    'headline.lead': 'White clause. Under 34 characters.',
    'headline.accent': 'Pale blue clause. Under 34 characters.',
    steps: 'Two to five { title, note, image }. Title under 34 characters, note under 80.',
    cta: 'Footer pill text.',
  },
  rules: [
    'Use the real number of steps. Compressing four into three to look slicker is the kind of small lie that gets noticed at signup.',
  ],
};

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`process-strip: unsupported format "${format}"`);

  const steps = data.steps ?? [];
  if (steps.length < 2) throw new Error('process-strip needs at least two steps');

  const carousel = format === 'carousel';
  // One step per slide in carousel mode, so each gets a full frame.
  const shown = carousel ? [steps[slideIndex % steps.length]] : steps;
  const offset = carousel ? slideIndex % steps.length : 0;
  const tall = format === 'story' || format === 'reel';

  const rows = shown
    .map((step, i) => {
      if (!step.title) throw new Error('every process step needs a title');
      return `<div class="step">
        <span class="step__num">${offset + i + 1}</span>
        <div class="step__body">
          <div class="step__title">${escapeHtml(step.title)}</div>
          ${step.note ? `<div class="step__note">${escapeHtml(step.note)}</div>` : ''}
        </div>
        ${step.image ? `<div class="step__shot" style="background-image: ${cssUrl(step.image)};"></div>` : ''}
      </div>`;
    })
    .join('\n      ');

  const body = `<div class="frame${tall ? ' frame--tall' : ''} field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    ${headline(data.headline)}
    <div class="steps">
      ${rows}
    </div>
    ${fieldFooter({
    note: data.disclosure ?? 'Virtually staged with Stagify.ai',
    action: (!carousel || slideIndex === slideCount - 1) ? data.cta : null,
  })}
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.headline?.lead ?? 'Stagify post' });
}
