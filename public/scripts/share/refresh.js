// Re-minting expired image URLs.
//
// WHY THIS MODULE HAS TO EXIST
// The manifest carries PRESIGNED R2 URLs with a short TTL (15 minutes). That is what
// keeps revocation bounded — but it also means a tab left open past the TTL has a page
// full of URLs that now 404, and without this the recipient sees permanently broken
// images with no way back. A reload would fix it; nobody reloads, they close the tab.
//
// So: an `onerror` on every image triggers ONE debounced re-fetch of the manifest and
// re-points the images at fresh URLs. Three situations fall out of the same mechanism:
//   * a URL that expired while the tab sat idle;
//   * a URL that expired mid lazy-scroll, before its image was ever requested;
//   * a share REVOKED while somebody was reading it — the re-fetch 404s, and the page
//     flips to the unavailable state on its own.
//
// Debounced and capped, because the failure mode to avoid is a broken manifest turning
// twenty broken images into twenty manifest requests, repeatedly, forever.

/** Wait this long after the first error before re-fetching, so a burst is one request. */
export const REFRESH_DEBOUNCE_MS = 400;

/** Give up after this many consecutive re-mints that did not fix anything. */
export const MAX_ATTEMPTS = 3;

/**
 * Attach expiry recovery to a set of images.
 *
 * @param {{ images: HTMLImageElement[], reload: () => Promise<any>, onGiveUp?: () => void,
 *   debounceMs?: number, setTimeoutImpl?: typeof setTimeout }} arg - `reload` re-fetches
 *   the manifest and returns the new one (or null when it is gone).
 * @returns {{ attach: (images: HTMLImageElement[]) => void, attempts: () => number }}
 */
export function createRefresher({ images, reload, onGiveUp, debounceMs = REFRESH_DEBOUNCE_MS, setTimeoutImpl = setTimeout }) {
  let timer = null;
  let attempts = 0;
  let running = false;

  async function run() {
    timer = null;
    if (running || attempts >= MAX_ATTEMPTS) return;
    running = true;
    attempts += 1;
    try {
      const fresh = await reload();
      // A reload that comes back empty means the share is gone, not that the URL aged
      // out — the caller flips the page to its unavailable state.
      if (!fresh) onGiveUp?.();
      else attempts = 0; // a successful re-mint resets the budget
    } catch {
      // Swallowed: a failed refresh must leave the page exactly as it was, showing the
      // images that still work, rather than replacing a partial gallery with an error.
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (timer !== null || attempts >= MAX_ATTEMPTS) return;
    timer = setTimeoutImpl(run, debounceMs);
  }

  function attach(list) {
    for (const img of list ?? []) {
      // `once` is deliberately NOT used: an image can expire again after a successful
      // re-mint if the tab stays open long enough, and a one-shot handler would leave it
      // broken the second time.
      img.addEventListener('error', schedule);
    }
  }

  attach(images);
  return { attach, attempts: () => attempts };
}
