/* Stagify.ai — animated nav pill.
   A single brand-gradient highlight glides between the top-nav links on hover
   and rests on the current page's link. Inspired by reactbits PillNav/GooeyNav.
   Purely decorative: if this never runs, the links stay clean navy text. */
(() => {
  "use strict";

  function init() {
    const nav = document.querySelector(".site-header .nav-center");
    if (!nav) return;

    // Include every link, even ones currently hidden (the pro-only AI Designer
    // link starts hidden and is revealed later for Pro users).
    const links = Array.from(nav.querySelectorAll(".nav-link"));
    if (!links.length) return;

    nav.classList.add("nav--pill");

    const pill = document.createElement("span");
    pill.className = "nav-pill";
    pill.setAttribute("aria-hidden", "true");
    nav.appendChild(pill);

    const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();

    function matchesPage(a) {
      const path = (a.getAttribute("href") || "").split("#")[0];
      // A pure in-page anchor (e.g. href="#contact") points at the current page.
      if (path === "") return true;
      const href = path.split("/").pop().toLowerCase();
      return href === here || (here === "" && href === "index.html");
    }
    // A link counts as usable only if it's actually laid out (not display:none
    // via .hidden or the .desktop-only mobile rule).
    function isVisible(el) {
      return !!el && !el.classList.contains("hidden") && el.offsetParent !== null;
    }
    function pageActive() {
      return links.find((a) => matchesPage(a) && isVisible(a)) || null;
    }

    let active = pageActive();

    function moveTo(el, lit) {
      // offset* is relative to the positioned nav-center and unaffected by
      // scroll/transforms, so it stays correct across clicks and navigation.
      pill.style.setProperty("--pill-x", el.offsetLeft + "px");
      pill.style.setProperty("--pill-w", el.offsetWidth + "px");
      pill.style.setProperty("--pill-h", el.offsetHeight + "px");
      pill.style.setProperty("--pill-top", el.offsetTop + "px");
      pill.classList.add("is-active");
      links.forEach((l) => l.classList.toggle("is-lit", l === lit));
    }

    function rest() {
      if (!active || !isVisible(active)) active = pageActive();
      if (active && isVisible(active)) {
        moveTo(active, active);
      } else {
        pill.classList.remove("is-active");
        links.forEach((l) => l.classList.remove("is-lit"));
      }
    }

    links.forEach((a) => {
      a.addEventListener("mouseenter", () => {
        if (isVisible(a)) moveTo(a, a);
      });
      // On click, lock the pill to the clicked link so it doesn't snap back to
      // the old active item (matters for same-page anchors and slow navigations).
      a.addEventListener("click", () => {
        if (isVisible(a)) {
          active = a;
          moveTo(a, a);
        }
      });
    });
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
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(rest);

    // The AI Designer link is revealed later for Pro users — re-settle when it
    // appears so the pill can land on it (and rest there on its own page).
    const ai = nav.querySelector(".nav-ai-designer-pro");
    if (ai && "MutationObserver" in window) {
      let wasHidden = ai.classList.contains("hidden");
      new MutationObserver(() => {
        const h = ai.classList.contains("hidden");
        if (h !== wasHidden) {
          wasHidden = h;
          rest();
        }
      }).observe(ai, { attributes: true, attributeFilter: ["class"] });
    }

    // Place it on the current page's link right away (transitions are off until
    // .is-ready is added, so it's steady on Home from the first paint), then
    // enable gliding for later moves. Uses a timeout, not rAF, so it still
    // settles in a backgrounded tab.
    rest();
    setTimeout(() => {
      pill.classList.add("is-ready");
      rest();
    }, 60);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
