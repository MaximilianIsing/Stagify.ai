/* Stagify.ai — animated nav pill.
   A single brand-gradient highlight glides between the top-nav links on hover
   and rests on the current page's link. Inspired by reactbits PillNav/GooeyNav.
   Purely decorative: if this never runs, the links stay clean navy text. */
(() => {
  "use strict";

  function init() {
    const nav = document.querySelector(".site-header .nav-center");
    if (!nav) return;

    const links = Array.from(nav.querySelectorAll(".nav-link")).filter(
      (a) => !a.classList.contains("hidden")
    );
    if (!links.length) return;

    nav.classList.add("nav--pill");

    const pill = document.createElement("span");
    pill.className = "nav-pill";
    pill.setAttribute("aria-hidden", "true");
    nav.appendChild(pill);

    // Which link points at the page we're on?
    const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    const active =
      links.find((a) => {
        const href = (a.getAttribute("href") || "")
          .split("#")[0]
          .split("/")
          .pop()
          .toLowerCase();
        return href === here || (here === "" && href === "index.html");
      }) || null;

    function moveTo(el, lit) {
      const navRect = nav.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      pill.style.setProperty("--pill-x", r.left - navRect.left + "px");
      pill.style.setProperty("--pill-w", r.width + "px");
      pill.style.setProperty("--pill-h", r.height + "px");
      pill.classList.add("is-active");
      links.forEach((l) => l.classList.toggle("is-lit", l === lit));
    }

    function rest() {
      if (active) {
        moveTo(active, active);
      } else {
        pill.classList.remove("is-active");
        links.forEach((l) => l.classList.remove("is-lit"));
      }
    }

    links.forEach((a) => a.addEventListener("mouseenter", () => moveTo(a, a)));
    nav.addEventListener("mouseleave", rest);

    // Re-settle when widths change (fonts, language switch, resize).
    if ("ResizeObserver" in window) {
      let raf;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(rest);
      });
      ro.observe(nav);
    }
    window.addEventListener("resize", rest);
    window.addEventListener("load", rest);

    // Place it once layout is ready, without an entrance glide.
    pill.style.transition = "none";
    requestAnimationFrame(() => {
      rest();
      requestAnimationFrame(() => {
        pill.style.transition = "";
      });
    });
    setTimeout(rest, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
