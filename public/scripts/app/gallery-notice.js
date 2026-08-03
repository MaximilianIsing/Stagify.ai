// The eviction warning under a finished render.
//
// SAVING IS SILENT. There is deliberately no "saved to your gallery" confirmation: the
// gallery is somewhere renders simply are afterwards, not a feature the app announces
// every time it works. A message on every success is noise the user cannot act on, and
// it competes with the Download button it sits beside.
//
// SO THIS ONLY EVER SPEAKS WHEN SOMETHING WAS LOST. A free account keeps its last
// FREE_GALLERY_LIMIT entries and a Stagify+ account its last PRO_GALLERY_LIMIT, so a new
// render can push an older one out — and if that older one had a live share link, a
// client's link just stopped working. The staging response carries `gallery.evicted`
// precisely so that is something the app SAYS rather than something the agent discovers
// when a seller tells them the link is dead. Silence on success, a sentence on loss.
//
// WHY THERE IS NO SHARE BUTTON HERE
// The obvious thing to put beside a finished render is "Share this". It would not work.
// Rows are written synchronously but the BYTES are pushed after the response (see
// lib/staging/render-persistence.js — the user has already waited a minute for the
// render and must not wait again for a history feature), so at the moment this result
// appears the entry is still `pending`. Minting a link for it 404s by design:
// routes/gallery.js refuses to hand out a URL for bytes that are not there yet. Sharing
// lives on the gallery page, where the entry is `ok` by the time anyone sees it.

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
     * Renders NOTHING on a plain success — see the header. It stays silent when the
     * response carried no gallery payload at all (the gallery is off, or the caller was
     * anonymous) and equally when the save simply worked, which is the common case.
     *
     * @param {{ ids?: string[], tier?: 'free' | 'pro',
     *   evicted?: { id: string, hadLiveShare: boolean }[] }} [gallery] - `tier` decides
     *   whether the cap is named; see below.
     */
    show(gallery) {
      const el = node();
      if (!el) return;

      const evicted = gallery?.ids?.length ? (gallery.evicted ?? []) : [];
      if (!evicted.length) {
        // The success path, and the overwhelmingly common one. Nothing is said.
        clear();
        return;
      }

      const parts = [];
      // The cap is only NAMED for the free tier, where it is the upgrade prompt.
      // Stagify+ is sold as unlimited staging — which it is — and its gallery ceiling
      // is deliberately not advertised, so a Pro eviction says nothing about it.
      if (gallery.tier !== 'pro') {
        parts.push(
          t('modal.staging.galleryEvicted', 'Older stagings were removed to make room — the free plan keeps your most recent ones.'),
        );
      }
      // This one is said to BOTH tiers, and it is where "do not advertise the cap"
      // stops. A link the agent already sent a client has stopped working; they cannot
      // learn that anywhere else, and letting it die in silence is a broken product
      // rather than discreet marketing. It names the consequence, never the limit.
      if (evicted.some((e) => e.hadLiveShare)) {
        parts.push(
          t('modal.staging.galleryEvictedShared', 'An older staging had an active share link, which no longer works.'),
        );
      }

      if (!parts.length) {
        // A pro eviction with no live share: something went, but there is nothing the
        // user needs to know and nothing they could do about it.
        clear();
        return;
      }

      // textContent, never innerHTML — same rule as the share page. Nothing here is
      // user-typed today, but the day somebody adds a room name to this string is not
      // the day to discover the difference.
      el.textContent = parts.join(' ');
      el.classList.remove('hidden');
    },
  };
}
