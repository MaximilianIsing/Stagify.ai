// The "saved to your gallery" line under a finished render, and the eviction warning.
//
// WHY THIS IS A NOTICE AND NOT A SHARE BUTTON
// The obvious thing to put here is "Share this". It would not work. Rows are written
// synchronously but the BYTES are pushed after the response (see
// lib/staging/render-persistence.js — the user has already waited a minute for the
// render and must not wait again for a history feature), so at the moment this result
// appears the entry is still `pending`. Minting a link for it 404s by design:
// routes/gallery.js refuses to hand out a URL for bytes that are not there yet. Sharing
// lives on the gallery page, where the entry is `ok` by the time anyone sees it.
//
// WHY EVICTION IS SURFACED AT ALL
// A free account keeps its last FREE_GALLERY_LIMIT entries, so a render can silently
// push an older one out — and if that older one had a live share link, a client's link
// just stopped working. The staging response carries `gallery.evicted` precisely so this
// is something the app SAYS rather than something the agent discovers when a seller
// tells them the link is dead.

/** Where the notice is inserted, so the caller does not have to know the markup. */
export const NOTICE_ID = 'gallery-notice';

/**
 * Build the notice island.
 *
 * @param {{ doc?: Document, container: Element | null,
 *   lang?: (key: string, fallback: string) => string }} deps - `container` is the block
 *   the notice is appended to; `lang` defaults to the global LanguageSystem lookup with
 *   an English fallback, matching the rest of the staging UI.
 * @returns {{ show: (gallery: any) => void, clear: () => void }}
 */
export function createGalleryNotice({ doc = document, container, lang }) {
  const t = lang ?? ((key, fallback) => window.LanguageSystem?.getText(key) || fallback);

  /** @returns {HTMLElement | null} The notice element, created on first use. */
  function node() {
    if (!container) return null;
    let el = doc.getElementById(NOTICE_ID);
    if (!el) {
      el = doc.createElement('p');
      el.id = NOTICE_ID;
      el.className = 'gallery-notice hidden';
      container.appendChild(el);
    }
    return el;
  }

  function clear() {
    const el = node();
    if (el) {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  return {
    clear,

    /**
     * Reflect what the staging response said about the gallery.
     *
     * Silent when the response carried nothing — the gallery is off (no object store
     * configured) or the caller was anonymous, and announcing a feature that is not
     * running would be worse than saying nothing.
     *
     * @param {{ ids?: string[], tier?: 'free' | 'pro',
     *   evicted?: { id: string, hadLiveShare: boolean }[] }} [gallery] - `tier` decides
     *   whether the cap is named; see below.
     */
    show(gallery) {
      const el = node();
      if (!el) return;
      if (!gallery || !gallery.ids?.length) {
        clear();
        return;
      }

      const evicted = gallery.evicted ?? [];
      const parts = [t('modal.staging.savedToGallery', 'Saved to your gallery.')];

      if (evicted.length) {
        // The cap is only NAMED for the free tier, where it is the upgrade prompt.
        // Stagify+ is sold as unlimited staging — which it is — and its gallery ceiling
        // (200) is deliberately not advertised, so a Pro eviction says nothing here.
        if (gallery.tier !== 'pro') {
          parts.push(
            t('modal.staging.galleryEvicted', 'Older stagings were removed to make room — the free plan keeps your most recent ones.'),
          );
        }
        // This one is said to BOTH tiers, and that is the line where "do not advertise
        // the cap" stops. A link the agent already sent a client has stopped working;
        // they cannot learn that anywhere else, and letting it die in silence is a
        // broken product rather than discreet marketing. It names the consequence
        // without naming the limit.
        if (evicted.some((e) => e.hadLiveShare)) {
          parts.push(
            t('modal.staging.galleryEvictedShared', 'One of them had an active share link, which no longer works.'),
          );
        }
      }

      // textContent, never innerHTML — same rule as the share page. Nothing here is
      // user-typed today, but the day somebody adds a room name to this string is not
      // the day to discover the difference.
      el.textContent = parts.join(' ');
      el.classList.remove('hidden');
    },
  };
}
