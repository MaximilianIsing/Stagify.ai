/* Stagify.ai — count-up animation for the hero stat numbers.
   Waits for live counts from app.js, then reveals the block and animates.

   THE SELECTORS BELOW ARE A CONTRACT WITH public/index.html: `.hero-stats` is the wrapper
   this reveals with `.is-ready`, and `.hp-stat__num[data-stat]` are the figures it writes.
   They were `.stat-pill-*` while the counters were pills; renaming them in the markup
   without renaming them here leaves the hero showing two blanks forever, and nothing
   errors. */
// The number/width math is pure and lives at module scope so it can be unit-tested
// directly (test/frontend/count-up.test.js). The IIFE below drives the DOM animation with
// these; the browser API is unchanged (window.StagifyHeroStats).

/** @param {number} n */
export function format(n) {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Does this span already show a real figure?
 *
 * The server now writes the live counts straight into the hero spans
 * (lib/seo/live-stats.js), so a blank one is no longer the only possible pre-JS state.
 * revealWithoutCounts below uses this to avoid replacing a correct, server-rendered
 * number with an em dash just because a fetch failed.
 * @param {string | null | undefined} text
 */
export function hasServerCount(text) {
  return /\d/.test(String(text == null ? "" : text));
}

/** @param {string} text */
export function widthForText(text) {
  return Math.max(String(text).length, 1) + "ch";
}

// Characters in 10^exp when grouped (exp 5 -> "100,000" -> 7). Commas count as a
// full char to match widthForText, so the reserved width is always a hair
// generous (commas render narrower than a digit) and never clips.
/** @param {number} exp */
export function lenAtDecade(exp) {
  return Math.pow(10, exp).toLocaleString("en-US").length;
}

// A continuous, monotonic pill width (in ch) for the current value: it eases
// across digit AND comma boundaries instead of snapping a whole ch at each one,
// always stays wide enough for the number (no clipping), and is clamped so it
// lands exactly on the final width with no end-of-count overshoot. We round the
// value first so the width tracks the *displayed* digits (e.g. 9.8 shows "10").
/** @param {number} value @param {number} finalLen */
export function smoothWidthCh(value, finalLen) {
  const v = Math.max(Math.round(value), 1);
  const lg = Math.log10(v);
  const k = Math.floor(lg);
  const frac = lg - k;
  const lead = lenAtDecade(k) + (lenAtDecade(k + 1) - lenAtDecade(k)) * frac;
  return Math.min(lead, finalLen);
}

// Ease-out ramp: the number climbs fast at the start then decelerates as it
// settles into its final value. Cubic (^3) gives a softer launch than quart
// (^4). The pill widens alongside it (width is tied to the digit count), but
// smoothWidthCh keeps that widening continuous so there are no janky per-digit
// steps like the original had.
/** @param {number} target @param {number} t */
export function rampValue(target, t) {
  return target * (1 - Math.pow(1 - t, 3));
}

(() => {
  "use strict";

  const running = new WeakSet();

  /** @param {HTMLElement} el @param {number} target @param {number} duration */
  function animate(el, target, duration) {
    if (running.has(el)) return;
    running.add(el);
    const start = performance.now();
    const finalText = format(target);
    const finalLen = Math.max(finalText.length, 1);

    // We drive min-width ourselves every frame (via smoothWidthCh) so the pill
    // grows smoothly with the number instead of snapping a whole ch at each new
    // digit. Suppress the CSS min-width transition while we do — it would lag and
    // fight the per-frame updates — then restore it so later stat refreshes ease.
    const prevTransition = el.style.transition;
    el.style.transition = "none";

    /** @param {number} now */
    function frame(now) {
      const t = Math.min(Math.max((now - start) / duration, 0), 1);
      const value = rampValue(target, t);
      el.textContent = format(value);
      el.style.minWidth = smoothWidthCh(value, finalLen).toFixed(3) + "ch";

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = finalText;
        el.style.minWidth = finalLen + "ch";
        el.style.transition = prevTransition;
        el.removeAttribute("aria-hidden");
        running.delete(el);
      }
    }
    requestAnimationFrame(frame);
  }

  /** @param {Element | null} wrap */
  function revealWrap(wrap) {
    if (!wrap || wrap.classList.contains("is-ready")) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrap.classList.add("is-ready");
      });
    });
  }

  /**
   * @param {Record<string, number | null | undefined>} counts - Figure per `data-stat` key.
   * @param {{ refresh?: boolean }} [options]
   */
  function setCounts(counts, options) {
    const opts = options || {};
    const isRefresh = opts.refresh === true;
    const wrap = document.querySelector(".hero-stats");
    const els = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll(".hp-stat__num[data-stat]")));
    if (!els.length) return;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let updated = 0;

    els.forEach((el) => {
      const key = /** @type {string} */ (el.dataset.stat); // the selector requires data-stat
      const target = counts[key];
      if (target == null || Number.isNaN(target)) return;

      updated++;

      if (reduceMotion || isRefresh) {
        const finalText = format(target);
        el.textContent = finalText;
        el.style.minWidth = widthForText(finalText);
        el.removeAttribute("aria-hidden");
        return;
      }

      el.setAttribute("aria-hidden", "true");
      el.textContent = "0";
      animate(el, target, 1700);
    });

    if (!updated) return;

    if (isRefresh && wrap && wrap.classList.contains("is-ready")) return;
    revealWrap(wrap);
  }

  function revealWithoutCounts() {
    const wrap = document.querySelector(".hero-stats");
    const els = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll(".hp-stat__num[data-stat]")));
    els.forEach((el) => {
      // Only blank out a span that was blank to begin with. If the server already put a
      // figure here, a failed /api/prompt-count is no reason to destroy it — the number is
      // still true, it just did not get to animate.
      if (!hasServerCount(el.textContent)) {
        el.textContent = "—";
        el.style.minWidth = "1ch";
      }
      el.removeAttribute("aria-hidden");
    });
    revealWrap(wrap);
  }

  window.StagifyHeroStats = { setCounts, revealWithoutCounts };
})();
