/* Stagify.ai — reveal homepage sections on scroll.
   Elements animate in as they enter the viewport and animate OUT in the
   direction they leave: content above slides up and fades as you scroll down,
   content below slides down and fades as you scroll up (and back again).
   Also warms image decoding so photos don't hitch when they animate in.
   Falls back to showing everything if IntersectionObserver is unavailable
   or the user prefers reduced motion. */
(() => {
  "use strict";

  function showAll() {
    document
      .querySelectorAll(".reveal")
      .forEach((el) => el.classList.add("is-visible"));
  }

  // Decode section images ahead of time so they're ready before they scroll in.
  function warmImages() {
    document
      .querySelectorAll(
        ".info-row__media img, .ba img, .plus-card__logo, .sponsor-logo, .cmp-brandcell img"
      )
      .forEach((img) => {
        if (img && typeof img.decode === "function") {
          img.decode().catch(() => {});
        }
      });
  }

  function init() {
    if (document.readyState === "complete") warmImages();
    else window.addEventListener("load", warmImages);

    const els = document.querySelectorAll(".reveal");
    if (!els.length) return;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      showAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (entry.isIntersecting) {
            el.classList.add("is-visible");
            el.classList.remove("exit-up", "exit-down");
            el.dataset.seen = "1";
          } else if (el.dataset.seen) {
            // Only animate OUT once it has been shown — that keeps the original
            // left/right entrance for the very first reveal. Which edge did it
            // leave through? Top => scrolled down (send it up); bottom =>
            // scrolled up (send it down).
            el.classList.remove("is-visible");
            const r = entry.boundingClientRect;
            const root = entry.rootBounds;
            const topEdge = root ? root.top : 0;
            if (r.bottom <= topEdge + 1) {
              el.classList.add("exit-up");
              el.classList.remove("exit-down");
            } else {
              el.classList.add("exit-down");
              el.classList.remove("exit-up");
            }
          }
        });
      },
      { threshold: 0.12, rootMargin: "-6% 0px -6% 0px" }
    );

    els.forEach((el) => observer.observe(el));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
