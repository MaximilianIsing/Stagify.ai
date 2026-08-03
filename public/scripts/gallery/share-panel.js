// The detail panel's share section: the link, the copy button, and the status line.
//
// THERE IS NO CREATE AND NO REVOKE. Every finished render has a link for its lifetime,
// minted by the listing and carried on the entry, so this widget paints a URL it has
// already been given rather than negotiating for one. That is why `paint` takes an entry
// and nothing else, and why "no link" is reported as a failure rather than as "not yet" —
// the latter would invite a wait that never ends.
//
// Extracted from gallery-app.js to keep that file under its 650-line ceiling. It is a
// good seam: nothing here touches the grid, the pager, or the open entry beyond the one
// passed in.

/**
 * Build the share section.
 *
 * @param {{
 *   byId: (id: string) => any,
 *   t: (key: string, fallback: string, vars?: Record<string, any>) => string,
 *   plural: (base: string, count: number, fallbacks: Record<string, string>, vars?: any) => string,
 *   copyText: (text: string, opts?: any) => Promise<boolean>,
 *   doc: Document,
 * }} deps
 * @returns {{ paint: (entry: any) => void, status: (text: string) => void, bind: () => void }}
 */
export function createSharePanel({ byId, t, plural, copyText, doc }) {
  /** @param {string} text */
  const status = (text) => {
    const node = byId('gal-share-status');
    if (node) node.textContent = text;
  };

  /**
   * Show the entry's link.
   * @param {any} entry
   */
  function paint(entry) {
    const input = /** @type {any} */ (byId('gal-share-url'));
    const copy = /** @type {any} */ (byId('gal-share-copy'));
    const link = entry?.share?.url || '';

    if (input) {
      input.value = link;
      input.hidden = !link;
    }
    if (copy) {
      copy.hidden = !link;
      copy.textContent = t('gallery.share.copy', 'Copy link');
    }

    if (!link) {
      // Not a state the owner can be in on purpose any more — the listing mints one for
      // every finished render — so it is reported as the failure it is rather than as
      // "no link yet", which would invite a wait that never ends.
      status(t('gallery.share.unavailable', 'This link could not be loaded. Reload the page and try again.'));
    } else if (!entry.share?.viewCount) {
      status(t('gallery.share.notOpened', 'Not opened yet'));
    } else {
      status(plural('gallery.share.opened', entry.share.viewCount, {
        one: 'Opened {count} time',
        other: 'Opened {count} times',
      }));
    }
  }

  /** Wire the copy button. */
  function bind() {
    byId('gal-share-copy')?.addEventListener('click', async () => {
      const input = /** @type {any} */ (byId('gal-share-url'));
      const value = input?.value || '';
      if (!value) return;
      // Reports what actually happened. The link is on screen either way now, so a false
      // "Copied" costs a paste rather than the link — but it still sends somebody off to
      // paste an empty clipboard into a message to their client.
      const ok = await copyText(value, { doc });
      status(ok
        ? t('gallery.share.copied', 'Copied — the link is on your clipboard.')
        : t('gallery.share.copyFailed', 'Could not copy automatically. Select the link above and copy it.'));
      if (!ok && typeof input.select === 'function') input.select();
    });
  }

  return { paint, status, bind };
}
