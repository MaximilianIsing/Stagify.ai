/* Stagify.ai — count-up animation for the hero stat numbers.
   Waits for live counts from app.js, then animates once. */
(() => {
  "use strict";

  function format(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  const running = new WeakSet();

  function animate(el, target, duration) {
    if (running.has(el)) return;
    running.add(el);
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    function frame(now) {
      const t = Math.min(Math.max((now - start) / duration, 0), 1);
      el.textContent = format(target * ease(t));
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = format(target);
        running.delete(el);
      }
    }
    requestAnimationFrame(frame);
  }

  function setCounts(counts) {
    const els = Array.from(document.querySelectorAll(".stat-pill-number[data-stat]"));
    if (!els.length) return;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    els.forEach((el) => {
      const key = el.dataset.stat;
      const target = counts[key];
      if (target == null || Number.isNaN(target)) return;

      if (reduceMotion) {
        el.textContent = format(target);
        return;
      }

      el.textContent = "0";
      animate(el, target, 1800);
    });
  }

  window.StagifyHeroStats = { setCounts };
})();
