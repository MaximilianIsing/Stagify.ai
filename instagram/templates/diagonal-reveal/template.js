import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  page, lockup, labelPill, cta, disclosure, headline, cssUrl, FRAME,
} from '../_macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'template.css'), 'utf8');

export const meta = {
  id: 'diagonal-reveal',
  name: 'Diagonal reveal',
  layoutFamily: 'fullbleed',
  formats: ['single', 'story', 'reel'],
  description: 'Full bleed photo split by a diagonal wipe, before above the line and after below, with the headline over a bottom scrim. The photo carries the post and the chrome stays out of the way.',
  tone: 'confident, product forward, minimal copy',
  bestFor: 'A single dramatic before and after where the room itself is the argument.',
  provenance: 'Lifted from the real post instagram/history/backfill/07-25.png.',
  slots: {
    'headline.lead': 'First clause, white. Under 26 characters.',
    'headline.accent': 'Second clause, brand blue. Under 26 characters.',
    beforeImage: 'Root relative path to the empty or unstaged room.',
    afterImage: 'The staged render. Must be the same camera position.',
    cta: 'Short action phrase for the bottom right pill.',
    disclosure: 'Virtual staging disclosure. Required when afterImage is a render.',
    'diagonal.leftY': 'Percent down the left edge where the wipe starts, 30 to 70.',
    'diagonal.rightY': 'Percent down the right edge, 10 to 60. Must be less than leftY.',
  },
};

const DEFAULT_DIAGONAL = { leftY: 49, rightY: 21 };

/**
 * @param {object} data see meta.json `slots`
 * @param {{ format: keyof typeof FRAME, brandCss: string }} ctx
 * @returns {string} a complete HTML document
 */
export function render(data, { format, brandCss }) {
  const frame = FRAME[format];
  if (!frame) throw new Error(`diagonal-reveal: unsupported format "${format}"`);
  if (!data.beforeImage || !data.afterImage) {
    throw new Error('diagonal-reveal needs both beforeImage and afterImage');
  }

  const { leftY, rightY } = { ...DEFAULT_DIAGONAL, ...(data.diagonal ?? {}) };
  if (leftY <= rightY) {
    // Not a hard geometric requirement, but every version of this composition reads as a
    // reveal because the eye travels up and to the right. A descending wipe looks like a
    // mistake, so make it an explicit choice rather than a silent one.
    throw new Error(
      `diagonal-reveal: leftY (${leftY}) must be greater than rightY (${rightY}) so the wipe rises left to right.`,
    );
  }

  // The wipe is a rotated bar, so it needs a real angle rather than two edge offsets. Rise
  // is negative because the line climbs as it goes right, and screen Y grows downward.
  const rise = ((rightY - leftY) / 100) * frame.height;
  const angleDeg = (Math.atan2(rise, frame.width) * 180) / Math.PI;
  const midY = (leftY + rightY) / 2;

  // Where the AFTER pill sits. `line` hugs the wipe so it reads as labelling the region
  // below it; `corner` mirrors the BEFORE pill at the opposite corner. A pill that is
  // neither tracking the line nor pinned to a corner just floats.
  // `corner` is the default because it is the placement that always looks deliberate:
  // bottom right, mirroring BEFORE at top left. `line` is the opt-in for shallow wipes
  // where hugging the diagonal reads better.
  const anchor = data.afterAnchor ?? 'corner';
  if (!['line', 'corner'].includes(anchor)) {
    throw new Error(`diagonal-reveal: afterAnchor must be "line" or "corner", got "${anchor}"`);
  }
  // Small offset so the pill sits just under the wipe rather than adrift from it, and
  // clamped so it can never wander down into the headline.
  const afterY = Math.min(rightY + 7, 62);
  // Clear of the whole bottom block, not just the CTA. That block is the headline plus the
  // footer row, roughly 270px at 4:5 and 290px on the taller frames, and it starts 48px or
  // 220px up. Pinning to 300 put the pill right on top of the headline; this leaves air.
  const afterBottom = format === 'single' || format === 'carousel' ? 380 : 580;

  const tall = format !== 'single' && format !== 'carousel';

  const body = `<div class="frame${tall ? ' frame--tall' : ''}" style="
  --left-y: ${leftY};
  --right-y: ${rightY};
  --mid-y: ${midY};
  --angle: ${angleDeg.toFixed(3)}deg;
  --after-y: ${afterY};
  --after-bottom: ${afterBottom};
">
  <div class="photo photo--after" style="background-image: ${cssUrl(data.afterImage)};"></div>
  <div class="photo photo--before" style="background-image: ${cssUrl(data.beforeImage)};"></div>

  <div class="wipe wipe--glow"></div>
  <div class="wipe wipe--edge"></div>

  <div class="top">
    ${labelPill(data.beforeLabel ?? 'BEFORE', 'before')}
    ${lockup()}
  </div>

  <div class="after-mark${anchor === 'corner' ? ' after-mark--corner' : ''}">${labelPill(data.afterLabel ?? 'AFTER', 'after')}</div>

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
