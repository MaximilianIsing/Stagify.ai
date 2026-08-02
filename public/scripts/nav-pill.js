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

    // What page(s) a nav item stands for. Usually just its own href — but the
    // "Staging" item is a <button> that opens a dropdown, so it stands for the
    // pages its rows link to, and the pill rests on it while you're on one of
    // them. Without this a hrefless element read as `""`, which matchesPage()
    // treated as an in-page anchor and therefore as the CURRENT page — the pill
    // would have claimed Staging was active on every page of the site.
    function targetsOf(a) {
      const group = a.closest("[data-nav-group]");
      if (group) {
        return Array.from(group.querySelectorAll("a[href]")).map((x) => x.getAttribute("href"));
      }
      const own = a.getAttribute("href");
      return own === null ? [] : [own];
    }

    function matchesPage(a) {
      return targetsOf(a).some((raw) => {
        const path = raw.split("#")[0];
        // A pure in-page anchor (e.g. href="#contact") points at the current page.
        if (path === "") return true;
        const href = path.split("/").pop().toLowerCase();
        return href === here || (here === "" && href === "index.html");
      });
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

    // Offsets relative to nav-center, accumulated up the offsetParent chain.
    // offset* is measured against the nearest POSITIONED ancestor, which used to
    // always be nav-center itself — until the Staging item wrapped its trigger in
    // a position:relative container (the dropdown panel anchors to it). Reading
    // offsetLeft raw then measured from inside that wrapper, i.e. ~0, and parked
    // the pill at the far left of the nav instead of on the trigger.
    function offsetIn(el) {
      let x = 0;
      let y = 0;
      for (let node = el; node && node !== nav; node = node.offsetParent) {
        x += node.offsetLeft;
        y += node.offsetTop;
      }
      return { x, y };
    }

    function moveTo(el, lit) {
      // Unaffected by scroll/transforms, so it stays correct across clicks and
      // navigation.
      const { x, y } = offsetIn(el);
      pill.style.setProperty("--pill-x", x + "px");
      pill.style.setProperty("--pill-w", el.offsetWidth + "px");
      pill.style.setProperty("--pill-h", el.offsetHeight + "px");
      pill.style.setProperty("--pill-top", y + "px");
      pill.classList.add("is-active");
      links.forEach((l) => l.classList.toggle("is-lit", l === lit));
    }

    // While a nav dropdown is open the pill belongs to its trigger, the way it
    // belongs to a hovered link — a held state, not a new resting place.
    function openTrigger() {
      const group = nav.querySelector("[data-nav-group][data-open]");
      return group ? group.querySelector(".nav-link") : null;
    }

    function rest() {
      const pinned = openTrigger();
      if (pinned && isVisible(pinned)) {
        moveTo(pinned, pinned);
        return;
      }
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
        if (!isVisible(a)) return;
        // ...but only for something that actually navigates. A dropdown trigger
        // has no href; locking `active` onto it stranded the pill on "Staging"
        // for the rest of the page's life, because rest() only recomputes
        // `active` once it stops being visible. Its open state drives the pill
        // instead, via the observer below.
        if (a.getAttribute("href") === null) return;
        active = a;
        moveTo(a, a);
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

    // Switching language rewrites the link labels, changing their widths — the
    // ResizeObserver above won't fire if the centered nav container keeps the
    // same size, so re-settle explicitly. The text is already applied when this
    // event fires; the follow-up timeout catches any post-layout shift.
    window.addEventListener("languagechange", () => {
      rest();
      setTimeout(rest, 60);
    });

    // Re-settle whenever a nav dropdown opens or closes: opening lends the pill
    // to its trigger, closing gives it back to the current page's link. Driven
    // off the attribute rather than the trigger's click so it also covers the
    // ways a menu closes WITHOUT one — clicking away, or Escape.
    //
    // (The AI Designer / Masking Studio links used to be revealed here for Pro
    // users, which needed a similar observer to re-settle the pill when one
    // appeared. They now live inside this dropdown, so no nav item changes
    // visibility on plan any more.)
    if ("MutationObserver" in window) {
      nav.querySelectorAll("[data-nav-group]").forEach((group) => {
        new MutationObserver(rest).observe(group, {
          attributes: true,
          attributeFilter: ["data-open"],
        });
      });
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

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
