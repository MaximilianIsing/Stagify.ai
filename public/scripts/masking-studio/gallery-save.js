// Sending a finished composite to the gallery — the Masking Studio's half of
// POST /api/masking-studio/save.
//
// THIS MODULE IS IMPORTED BY EXACTLY ONE FILE, AND THAT IS A FEATURE.
// The requirement is that mask OPERATIONS never create gallery entries: not Apply Edit,
// not a retry, not switching between candidate versions, not Snap to object, and not the
// basic mask editor on the homepage or the AI Designer's copy of it. Rather than police
// that with conditions, none of those code paths can reach this module — generate-pipeline.js
// (which owns retryLayer and selectCandidate), snap-refine.js, scripts/mask/ and
// scripts/app/stage-mask-editor.js do not import it, and a drift guard in
// test/frontend/masking-studio/masking-studio-save.test.js fails the build if that changes.
// The single caller is the "Looks Good" handler in scripts/masking-studio-app.js.
//
// SILENT ON SUCCESS. See scripts/app/gallery-notice.js — saving is a background nicety, and
// a toast on every success is noise the user cannot act on. Only an eviction gets a
// sentence, because that is the one outcome that costs them something.

/**
 * A cheap perceptual fingerprint of a canvas.
 *
 * Answers the only question idempotence actually needs: "is this a different result from
 * the one already saved?" Downsampling to 64×64 first makes it a few milliseconds
 * regardless of the photo's size, and FNV-1a over those bytes is enough to separate two
 * composites — this guards a double-click, not an adversary.
 *
 * WHY NOT `state.genRun`. It looks like the obvious key and it is wrong: `retryLayer` reads
 * genRun without bumping it, and neither `selectCandidate` nor a snap touches it. Keying on
 * it would silently DROP the save after a genuine refine, and a missed save is worse than a
 * duplicate — the user pressed a button that means "keep this".
 *
 * Returns '' when the canvas cannot be read, and the caller treats that as "save anyway" —
 * failing OPEN is the right direction here for the same reason as above.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Document} [doc] - Injected so this runs under node --test with a small stand-in;
 *   the studio always passes the real document.
 * @returns {string} '' when it cannot be read.
 */
export function canvasDigest(canvas, doc) {
  try {
    const small = (doc || document).createElement('canvas');
    small.width = 64;
    small.height = 64;
    const ctx = small.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(canvas, 0, 0, 64, 64);
    const { data } = ctx.getImageData(0, 0, 64, 64);
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193);
      hash ^= data[i + 1];
      hash = Math.imul(hash, 0x01000193);
      hash ^= data[i + 2];
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  } catch (e) {
    return '';
  }
}

/**
 * Build the gallery-save island.
 *
 * @param {{
 *   state: import('./types.js').MsState,
 *   resultCanvas: HTMLCanvasElement,
 *   authToken: () => string,
 *   onEvicted: (gallery: any) => void,
 *   fetchImpl?: typeof fetch,
 *   doc?: Document,
 * }} deps - `onEvicted` receives the response's `gallery` payload so the entry can hand it
 *   to the shared eviction notice; it is not called when nothing was evicted. `doc` is a
 *   test seam.
 * @returns {{ saveToGallery: () => Promise<void> }}
 */
export function createGallerySave(deps) {
  const { state, resultCanvas, authToken, onEvicted, fetchImpl, doc } = deps;
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  /**
   * Save the current composite, once per distinct result.
   *
   * Never throws and never rejects: it is called with `void` from a click handler whose
   * real job is showing the user their result, and a gallery write must not be able to
   * interrupt that.
   *
   * @returns {Promise<void>}
   */
  async function saveToGallery() {
    try {
      if (!state.base) return;
      // "Looks Good → Refine Edit → Looks Good" is a designed loop, so this runs more than
      // once per session by intent. The digest is what separates a second press on the
      // same pixels (nothing to do) from a genuinely refined result (save it).
      const digest = canvasDigest(resultCanvas, doc);
      if (digest && digest === state.savedDigest) return;

      const after = resultCanvas.toDataURL('image/jpeg', 0.92);
      // The pristine original, for the before/after slider. Sent only on an INSERT: when
      // replacing, the entry already has its own source photo, and that photo — not the
      // image the studio was handed — is the right "before" for a refined "after".
      const before = state.sourceRenderId
        ? null
        : state.base.canvas.toDataURL('image/jpeg', 0.92);

      const res = await doFetch('/api/masking-studio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          after: after,
          before: before || undefined,
          renderId: state.sourceRenderId || undefined,
          areas: state.layers.filter((l) => l.status === 'done').length,
          prompts: state.layers.filter((l) => l.status === 'done').map((l) => l.prompt || ''),
          sourceName: state.sourceName || undefined,
          authToken: authToken() || undefined,
        }),
      });
      if (!res || !res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || !data.success) return;

      // Only now — a failed save must be retryable by pressing the button again.
      state.savedDigest = digest;
      if (data.gallery && data.gallery.evicted && data.gallery.evicted.length) {
        onEvicted(data.gallery);
      }
    } catch (e) {
      // Deliberately silent. The user has their image on screen and can still download it;
      // a red toast about a history feature they did not ask about is worse than nothing.
    }
  }

  return { saveToGallery };
}
