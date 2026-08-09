/* Stagify.ai — #why, the "Why Choose Us?" comparison.
 *
 * The section renders two columns of seven bullets, but they are not two independent
 * lists: row N under Stagify is the direct rebuttal to row N under Others ("Unlimited
 * free generations" answers "Expensive: Costly, per-image fees", and so on for all
 * seven). Nothing on screen said so, so the section read as two lists rather than as
 * an argument. Each <li> carries a `data-vs` pair key; hovering, focusing or tapping
 * either half lights BOTH and dims the other twelve.
 *
 * This is deliberately the same interaction as the NAR legend in home-figures.js
 * (wireNarLegend): hover/focus to preview, click to pin so touch and keyboard users
 * get the same thing, one attribute on the container that the CSS dims everything
 * else off. Pinning matters more here than it does there — below 760px .whyus-grid
 * collapses to one column, so a hover the visitor cannot perform is the only way in.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT. With no JS the markup is already the
 * finished section: every row is legible, `data-vs-focus` is never set, and the CSS
 * dim/lift rules are scoped behind it so nothing is hidden by default.
 */

/**
 * @typedef {object} Row
 * @property {string} key    the `data-vs` pair name shared by exactly two rows
 * @property {Element} li    the list item the ✓/– marker and the dim/lift styles hang off
 * @property {Element} btn   the button inside it that owns focus and `aria-pressed`
 */

/** Exported so test/frontend/home-whyus.test.js can drive it against a fake DOM. */
export function initWhyUs() {
  const grid = document.querySelector(".whyus-grid");
  if (!grid) return;

  /** @type {Row[]} */
  const rows = [];
  grid.querySelectorAll("[data-vs]").forEach((li) => {
    const btn = li.querySelector(".whyus-row");
    // A row with no button cannot be driven — skip it rather than half-wiring the
    // pair, so a markup slip degrades to "inert row" instead of "dead section".
    if (btn) rows.push({ key: li.getAttribute("data-vs") || "", li, btn });
  });
  if (!rows.length) return;

  let pinned = "";

  /** @param {string} key the pair to light, or "" for none */
  function light(key) {
    // `data-vs-focus` on the grid is the hook the CSS dims every unlit row off.
    if (key) grid.setAttribute("data-vs-focus", key);
    else grid.removeAttribute("data-vs-focus");
    rows.forEach((row) => {
      row.li.classList.toggle("is-lit", Boolean(key) && row.key === key);
    });
  }

  rows.forEach(({ key, btn }) => {
    btn.addEventListener("pointerenter", () => {
      if (!pinned) light(key);
    });
    btn.addEventListener("pointerleave", () => {
      if (!pinned) light("");
    });
    btn.addEventListener("focus", () => {
      if (!pinned) light(key);
    });
    btn.addEventListener("blur", () => {
      if (!pinned) light("");
    });
    btn.addEventListener("click", () => {
      pinned = pinned === key ? "" : key;
      rows.forEach((row) => {
        row.btn.setAttribute("aria-pressed", row.key === pinned ? "true" : "false");
      });
      light(pinned);
    });
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWhyUs);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired
    // long ago — a bare listener would never run and the pairing would silently not
    // happen. See the trap note at the top of index-deferred.js.
    initWhyUs();
  }
}
