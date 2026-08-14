import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, photoCard, lockup, cta, disclosure, escapeHtml, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'quote-card',
  name: 'Quote card',
  layoutFamily: 'card',
  formats: ['single', 'story'],
  description: 'A large pull quote on the pale wash ground, an attribution row with a small round avatar, and a rounded render inset below.',
  tone: 'plain, human, no adjectives',
  bestFor: 'Something a real person said. Also the only light layout in the library, so it resets a grid that has gone solid navy.',
  slots: {
    quote: 'What they said, verbatim. Under 140 characters.',
    name: 'Who said it.',
    role: 'Their job and market, for example "Listing agent, Denver".',
    avatar: 'Optional round headshot.',
    image: 'The render being talked about.',
    cta: 'Footer pill text.',
  },
  rules: [
    'Never fabricate a quote or attribute one to a person who did not say it. Use a real customer with permission, or do not use this template.',
    'Dark type on light here, so contrast rules invert. Body copy uses --slate-deep; the grey tokens fail AA over the wash.',
  ],
};

export function render(data, { format, brandCss }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`quote-card: unsupported format "${format}"`);
  if (!data.quote) throw new Error('quote-card needs a quote');
  if (!data.name) {
    throw new Error('quote-card needs an attribution. An unattributed quote is a fabricated one.');
  }

  const tall = format === 'story' || format === 'reel';

  const body = `<div class="frame${tall ? ' frame--tall' : ''} field--wash">
  <div class="stack">
    ${lockup()}
    <div>
      <div class="mark">&#8220;</div>
      <div class="quote">${escapeHtml(data.quote)}</div>
    </div>

    <div class="attribution">
      ${data.avatar ? `<div class="attribution__avatar" style="background-image: ${cssUrl(data.avatar)};"></div>` : ''}
      <div>
        <div class="attribution__name">${escapeHtml(data.name)}</div>
        ${data.role ? `<div class="attribution__role">${escapeHtml(data.role)}</div>` : ''}
      </div>
    </div>

    ${data.image ? `<div class="inset">${photoCard({ image: data.image, pill: data.imagePill })}</div>` : ''}

    <div class="footer-light">
      ${disclosure(data.disclosure ?? 'Virtually staged with Stagify.ai', { dark: true })}
      ${data.cta ? cta(data.cta) : ''}
    </div>
  </div>
</div>`;

  return page({ brandCss, css, body, ...frame, title: data.name ?? 'Stagify post' });
}
