import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, photoCard, lockup, cta, fieldHeader, fieldFooter, escapeHtml, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'carousel-deck',
  name: 'Carousel deck',
  layoutFamily: 'sequence',
  formats: ['carousel'],
  slides: [3, 8],
  description: 'A hook slide, then one proof slide per point, then a closing slide. Three layouts under one id, because the deck is one thought.',
  tone: 'builds, does not repeat',
  bestFor: 'Saves and shares. The format that earns the most dwell time, and the only one with room for an argument that needs more than a sentence.',
  slots: {
    'hook.question': 'The opening line. Under 60 characters. It has to be worth a swipe.',
    'hook.accent': 'Optional second clause in bright blue.',
    'hook.image': 'A tightly cropped photo behind the hook.',
    proofs: 'One to six { line, note, image, pill }. Each is one slide and one point.',
    'close.line': 'The closing ask. Under 44 characters.',
    'close.note': 'One supporting sentence.',
    cta: 'Text for the closing pill.',
  },
  rules: [
    'Slide one earns the swipe or the rest is never seen. Do not open with the brand.',
    'One point per proof slide. Two points on a slide means neither is read.',
    'Only the closing slide asks for the click.',
  ],
};

export function render(data, { format, brandCss, slideIndex = 0, slideCount = 1 }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`carousel-deck: unsupported format "${format}"`);

  const proofs = data.proofs ?? [];
  if (!proofs.length) throw new Error('carousel-deck needs at least one proof slide');
  if (!data.hook?.question) throw new Error('carousel-deck needs hook.question');
  if (!data.close?.line) throw new Error('carousel-deck needs close.line');

  const isHook = slideIndex === 0;
  const isClose = slideIndex === slideCount - 1;

  let body;

  if (isHook) {
    if (!data.hook.image) throw new Error('carousel-deck needs hook.image');
    body = `<div class="frame field--deep">
  <div class="hook">
    <div class="hook__photo" style="background-image: ${cssUrl(data.hook.image)};"></div>
    <div class="hook__scrim"></div>
    <div class="hook__inner">
      ${lockup({ bare: true })}
      <div>
        <div class="hook__q">${escapeHtml(data.hook.question)}${
  data.hook.accent ? ` <span class="accent">${escapeHtml(data.hook.accent)}</span>` : ''
}</div>
        <div class="swipe" style="margin-top: 30px;">
          <span class="swipe__label">${escapeHtml(data.hook.swipeLabel ?? 'Swipe')}</span>
          <span class="swipe__chev">&#8250;</span>
        </div>
      </div>
    </div>
  </div>
</div>`;
  } else if (isClose) {
    body = `<div class="frame field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    <div class="close">
      <div class="close__line">${escapeHtml(data.close.line)}</div>
      ${data.close.note ? `<div class="close__note">${escapeHtml(data.close.note)}</div>` : ''}
      ${data.cta ? `<div>${cta(data.cta, { light: true })}</div>` : ''}
    </div>
    ${fieldFooter({ note: data.disclosure ?? 'Virtually staged with Stagify.ai' })}
  </div>
</div>`;
  } else {
    // Proof slides sit between the hook and the close, so index 1 is proofs[0].
    const proof = proofs[(slideIndex - 1) % proofs.length];
    if (!proof.line) throw new Error('every proof slide needs a line');
    body = `<div class="frame field--deep">
  <div class="stack">
    ${fieldHeader(data.eyebrow ?? 'AI VIRTUAL STAGING')}
    <div>
      <div class="proof-line">${escapeHtml(proof.line)}</div>
      ${proof.note ? `<div class="proof-note">${escapeHtml(proof.note)}</div>` : ''}
    </div>
    <div class="proof">
      ${photoCard({ image: proof.image, pill: proof.pill, caption: proof.caption })}
    </div>
    ${fieldFooter({ note: data.disclosure ?? 'Virtually staged with Stagify.ai' })}
  </div>
</div>`;
  }

  return page({ brandCss, css, body, ...frame, title: data.hook.question });
}
