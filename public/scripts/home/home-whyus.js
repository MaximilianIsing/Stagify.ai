/* Stagify.ai — #why, the "Why choose us" scoreboard.
 *
 * The section is a table of ten factors across five ways to stage a listing: us, a
 * traditional stager, a per-image AI tool, doing it yourself, and shipping empty
 * rooms. This module adds exactly one thing to it.
 *
 * COLUMN FOCUS. Hovering, focusing or tapping a competitor's header dims every column
 * except that one and ours, so a six-column grid collapses into the head-to-head the
 * visitor is actually running. This is the same interaction the old two-list layout
 * used for its row pairs, and the same one the NAR legend uses (wireNarLegend in
 * home-figures.js): hover/focus to preview, click to pin so touch and keyboard users
 * get the same thing, one attribute on the container that the CSS dims everything else
 * off. Pinning matters most on a phone, where the table scrolls sideways and a hover
 * cannot be performed at all.
 *
 * It used to also drive row-group filter pills and recompute the footer tally as they
 * changed. Both are gone (2026-08-10): the section shows one view, so the tally is
 * authored in the markup where it is correct for everyone, script or no script.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT. The column buttons ship in the markup and
 * are harmless inert — without this module they simply highlight nothing, exactly as
 * the old .whyus-row buttons did. Every dim rule in home.css is scoped behind
 * [data-vs-col-focus], which is never set at rest. So if this module never runs, the
 * section is still the finished section, and nothing about it is hidden or blank.
 */

/**
 * @typedef {object} Column
 * @property {string} key  the `data-vs-col` name shared by the header and its cells
 * @property {Element} btn the header button that owns focus and `aria-pressed`
 */

/** Exported so test/frontend/home-whyus.test.js can drive it against a fake DOM. */
export function initWhyUs() {
  const board = document.querySelector('.whyus-board');
  if (!board) return;

  /** @type {Column[]} */
  const columns = [];
  board.querySelectorAll('.whyus-th[data-vs-col]').forEach((th) => {
    const btn = th.querySelector('.whyus-col');
    // The `us` header has no button by design — it is never the thing you switch to.
    // A competitor header that lost its button is skipped rather than half-wired, so a
    // markup slip costs that column its highlight instead of taking the section down.
    if (btn) columns.push({ key: th.getAttribute('data-vs-col') || '', btn });
  });
  if (!columns.length) return;

  let pinned = '';

  /** @param {string} key the column to compare against, or "" for none */
  function focus(key) {
    // `data-vs-col-focus` on the board is the hook the CSS dims the other columns off.
    if (key) board.setAttribute('data-vs-col-focus', key);
    else board.removeAttribute('data-vs-col-focus');
  }

  for (const { key, btn } of columns) {
    btn.addEventListener('pointerenter', () => {
      if (!pinned) focus(key);
    });
    btn.addEventListener('pointerleave', () => {
      if (!pinned) focus('');
    });
    btn.addEventListener('focus', () => {
      if (!pinned) focus(key);
    });
    btn.addEventListener('blur', () => {
      if (!pinned) focus('');
    });
    btn.addEventListener('click', () => {
      pinned = pinned === key ? '' : key;
      for (const col of columns) {
        col.btn.setAttribute('aria-pressed', col.key === pinned ? 'true' : 'false');
      }
      focus(pinned);
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWhyUs);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired
    // long ago — a bare listener would never run and the columns would stay inert. See
    // the trap note at the top of index-deferred.js.
    initWhyUs();
  }
}
