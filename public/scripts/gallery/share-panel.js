// The detail panel's share section: the link, the copy button, and the status line.
//
// THERE IS NO CREATE AND NO REVOKE. Every finished render has a link for its lifetime,
// minted by the listing and carried on the entry, so this widget paints a URL it has
// already been given rather than negotiating for one. That is why "no link" is reported as
// a failure rather than as "not yet" — the latter would invite a wait that never ends.
//
// It does now WRITE one thing: the "include the before photo" checkbox, which is the only
// control over what a live link publishes. Two rules make it honest. It is painted from
// the entry on every open, so it can never carry the last entry's state onto this one. And
// a failed save puts it back where it was, because a box that shows ticked while the
// server has it off is telling the owner their client can see a photo their client cannot
// — or worse, the reverse.
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
 *   updateShareSettings: (id: string, settings: Record<string, any>, fetchImpl?: typeof fetch)
 *     => Promise<{ ok: boolean }>,
 *   fetchImpl?: typeof fetch,
 *   doc: Document,
 * }} deps
 * @returns {{ paint: (entry: any) => void, status: (text: string) => void, bind: () => void }}
 */
export function createSharePanel({ byId, t, plural, copyText, updateShareSettings, fetchImpl, doc }) {
  // The entry currently on screen. `paint` is the only writer, so the change handler
  // always saves against the render whose panel is open rather than whichever one the grid
  // happens to be showing.
  /** @type {any} */
  let current = null;

  /** @param {string} text */
  const status = (text) => {
    const node = byId('gal-share-status');
    if (node) node.textContent = text;
  };

  /**
   * Show the entry's link and what it publishes.
   * @param {any} entry
   */
  function paint(entry) {
    const input = /** @type {any} */ (byId('gal-share-url'));
    const copy = /** @type {any} */ (byId('gal-share-copy'));
    const link = entry?.share?.url || '';
    current = entry ?? null;

    const beforeRow = /** @type {any} */ (byId('gal-share-before-row'));
    const beforeBox = /** @type {any} */ (byId('gal-share-before'));
    // Offered only when there is a source photo to offer and a link to put it on. The
    // same condition renderCompare uses to decide whether the owner's own before/after
    // slider is drawable, so the two never disagree about whether this entry has a before.
    const canShowBefore = Boolean(link) && Boolean(entry?.urls?.before);
    if (beforeRow) beforeRow.hidden = !canShowBefore;
    if (beforeBox) beforeBox.checked = entry?.share?.settings?.showBefore === true;

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

  /** Wire the copy button and the before-photo checkbox. */
  function bind() {
    byId('gal-share-before')?.addEventListener('change', async () => {
      const box = /** @type {any} */ (byId('gal-share-before'));
      const id = current?.id;
      if (!box || !id) return;
      const wanted = box.checked === true;
      // The WHOLE bag, merged onto what the listing handed over: the store rebuilds
      // settings from what arrives, so a delta would blank the headline and the contact
      // details along with it. See updateShareSettings in ./api.js.
      const settings = { ...(current.share?.settings ?? {}), showBefore: wanted };
      status(t('gallery.share.showBeforeSaving', 'Saving…'));
      const res = await updateShareSettings(id, settings, fetchImpl);
      if (!res?.ok) {
        // Put the control back where the server still has it. A box left ticked after a
        // failed save tells the owner their client can see a photo that was never
        // published — the one lie this panel must not tell.
        box.checked = !wanted;
        status(t('gallery.share.showBeforeFailed', 'Could not change what this link shows. Try again.'));
        return;
      }
      if (current.share) current.share.settings = settings;
      status(wanted
        ? t('gallery.share.showBeforeOn', 'The before photo is now part of this link.')
        : t('gallery.share.showBeforeOff', 'The link shows the staged photo only.'));
    });

    byId('gal-share-copy')?.addEventListener('click', async () => {
      const input = /** @type {any} */ (byId('gal-share-url'));
      const value = input?.value || '';
      if (!value) return;
      // Reports what actually happened. The link is on screen either way now, so a false
      // "Copied" costs a paste rather than the link — but it still sends somebody off to
      // paste an empty clipboard into a message to their client.
      const ok = await copyText(value, { doc });
      status(ok
        ? t('gallery.share.copied', 'Copied. The link is on your clipboard.')
        : t('gallery.share.copyFailed', 'Could not copy automatically. Select the link above and copy it.'));
      if (!ok && typeof input.select === 'function') input.select();
    });
  }

  return { paint, status, bind };
}
