// "Refine in Masking Studio" in the gallery's detail panel.
//
// A sibling of rename.js / delete-confirm.js / share-panel.js, and an island for the same
// reason they are: gallery-app.js is at its 650-line cap, and this is one more control on a
// panel that already has three.
//
// UNLIKE its siblings it is not a two-step, because it changes nothing on its own — it
// stores a render id and navigates. The commit happens in the other studio, behind that
// studio's own "Looks Good".

import { sendToMaskingStudio } from '../masking-handoff.js';
import { localizedTarget } from '../i18n-routing.js';

/**
 * @param {{
 *   byId: (id: string) => any,
 *   getCurrent: () => any,
 *   isPro: () => boolean,
 *   navigate?: (href: string) => void,
 * }} deps - `isPro` is read from the LISTING's `search.enabled`, never from a plan on
 *   window.StagifyAuth — see the header of gallery-app.js. `navigate` is a test seam.
 * @returns {{ bind: () => void, paint: (entry: any) => void }}
 */
export function createRefineButton({ byId, getCurrent, isPro, navigate }) {
  const go = navigate || ((href) => { window.location.href = href; });

  return {
    bind() {
      byId('gal-refine')?.addEventListener('click', () => {
        const entry = getCurrent();
        if (!entry?.id) return;
        // Navigate only if the handoff was actually stored. A blocked sessionStorage would
        // otherwise drop the user into an empty studio wondering where their photo went.
        if (!sendToMaskingStudio({ renderId: entry.id, sourceName: entry.sourceName || '' })) return;
        // localizedTarget keeps a reader on /es on /es. Assigning rather than pushing: the
        // studio is where they asked to go, and Back should return to the gallery.
        go(localizedTarget('/masking-studio.html'));
      });
    },

    /**
     * Show or hide the button for the entry being opened.
     *
     * Hidden for a free account rather than shown-and-refused: the studio's own gate would
     * turn the click into a navigation followed by a paywall, which is a worse way to learn
     * the feature is not yours than simply not being offered it.
     *
     * @param {any} entry
     */
    paint(entry) {
      const btn = byId('gal-refine');
      if (!btn) return;
      btn.hidden = !isPro() || !entry?.id;
    },
  };
}
