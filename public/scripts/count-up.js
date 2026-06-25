/* Stagify.ai — count-up animation for the hero stat numbers.
   Waits for live counts from app.js, then reveals pills and animates. */
(() => {
  "use strict";

  function format(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  function widthForText(text) {
    return Math.max(String(text).length, 1) + "ch";
  }

  const running = new WeakSet();

  function animate(el, target, duration) {
    if (running.has(el)) return;
    running.add(el);
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    let lastLen = 0;

    el.style.minWidth = "1ch";
    lastLen = 1;

    function frame(now) {
      const t = Math.min(Math.max((now - start) / duration, 0), 1);
      const text = format(target * ease(t));
      el.textContent = text;

      const len = text.length;
      if (len !== lastLen) {
        el.style.minWidth = widthForText(text);
        lastLen = len;
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        const finalText = format(target);
        el.textContent = finalText;
        el.style.minWidth = widthForText(finalText);
        el.removeAttribute("aria-hidden");
        running.delete(el);
      }
    }
    requestAnimationFrame(frame);
  }

  function revealWrap(wrap) {
    if (!wrap || wrap.classList.contains("is-ready")) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrap.classList.add("is-ready");
      });
    });
  }

  function setCounts(counts, options) {
    const opts = options || {};
    const isRefresh = opts.refresh === true;
    const wrap = document.querySelector(".hero-stats");
    const els = Array.from(document.querySelectorAll(".stat-pill-number[data-stat]"));
    if (!els.length) return;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let updated = 0;

    els.forEach((el) => {
      const key = el.dataset.stat;
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
      animate(el, target, 1200);
    });

    if (!updated) return;

    if (isRefresh && wrap && wrap.classList.contains("is-ready")) return;
    revealWrap(wrap);
  }

  function revealWithoutCounts() {
    const wrap = document.querySelector(".hero-stats");
    const els = Array.from(document.querySelectorAll(".stat-pill-number[data-stat]"));
    els.forEach((el) => {
      el.textContent = "—";
      el.style.minWidth = "1ch";
      el.removeAttribute("aria-hidden");
    });
    revealWrap(wrap);
  }

  window.StagifyHeroStats = { setCounts, revealWithoutCounts };
})();
