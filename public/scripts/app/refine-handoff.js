// "Refine in Masking Studio" on the staging result — the staging studio's half of the
// handoff (scripts/masking-handoff.js has the shared payload and the reason it is an id
// rather than an image URL).
//
// An island rather than four more lines in app.js, which sits at 641 against a 650-line cap.
//
// THE BUTTON IS REVEALED BY THE RENDER IDS, NOT BY A PLAN. A render that never reached the
// gallery has no id to hand over, and that covers every case at once: the gallery switched
// off, an anonymous stage, a persistence failure. There is deliberately no free/pro check —
// a free account's render gets an entry too, and the Masking Studio's own gate is the paid
// boundary. Gating here as well would mean two places to be wrong about who may refine.

import { sendToMaskingStudio } from '../masking-handoff.js';
import { localizedTarget } from '../i18n-routing.js';

/**
 * Wire the refine button.
 *
 * @param {{
 *   button: HTMLElement | null,
 *   getAfterIndex: () => number,
 *   getSourceName: () => string,
 *   navigate?: (href: string) => void,
 * }} deps - `getAfterIndex` reports which variation is on screen; `navigate` is a test seam.
 * @returns {{ setIds: (ids: string[]) => void }} `setIds` is called with each batch's render
 *   ids — an empty array hides the button again.
 */
export function createRefineHandoff({ button, getAfterIndex, getSourceName, navigate }) {
  /** @type {string[]} */
  let ids = [];
  const go = navigate || ((href) => { window.location.href = href; });

  button?.addEventListener('click', () => {
    // The render the user is LOOKING at. `gallery.ids` is index-aligned with the variations
    // the carousel pages through, so the index is what makes a 3-variation batch refine the
    // right one instead of always the first.
    const id = ids[getAfterIndex()] ?? ids[0];
    if (!id) return;
    // Navigate only if the handoff was actually stored — a blocked sessionStorage would
    // otherwise drop the user into an empty studio wondering where their photo went.
    if (!sendToMaskingStudio({ renderId: id, sourceName: getSourceName() })) return;
    go(localizedTarget('/masking-studio.html'));
  });

  return {
    setIds(next) {
      ids = Array.isArray(next) ? next : [];
      button?.classList.toggle('hidden', !ids.length);
    },
  };
}
