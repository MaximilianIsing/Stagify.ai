/* Stagify.ai — count-up animation for the hero stat numbers.
   Animates each .stat-pill-number from 0 to its target when it scrolls into
   view, re-running each time it re-enters. Inspired by reactbits CountUp
   (https://reactbits.dev/text-animations/count-up). */
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
    // easeOutQuart — quick start that settles smoothly
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    function frame(now) {
      const t = Math.min((now - start) / duration, 1);
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

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  }

  function init() {
    const els = Array.from(document.querySelectorAll(".stat-pill-number"));
    if (!els.length) return;

    els.forEach((el) => {
      el.dataset.countTo = String(
        parseFloat(el.textContent.replace(/[^0-9.]/g, "")) || 0
      );
    });

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      els.forEach((el) => (el.textContent = format(+el.dataset.countTo)));
      return;
    }

    els.forEach((el) => (el.textContent = "0"));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animate(entry.target, +entry.target.dataset.countTo, 1800);
          } else {
            running.delete(entry.target);
            entry.target.textContent = "0";
          }
        });
      },
      { threshold: 0.6 }
    );
    els.forEach((el) => observer.observe(el));

    // Safety net: if a stat is already on screen at load, don't wait on the
    // observer's first callback (which some browsers defer) — start it now.
    requestAnimationFrame(() => {
      els.forEach((el) => {
        if (el.textContent === "0" && inView(el)) {
          animate(el, +el.dataset.countTo, 1800);
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
