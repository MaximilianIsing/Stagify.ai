// Keyboard and outside-click behaviour for the footer's "Legal" disclosure.
//
// The menu itself is a native <details>/<summary> (markup in every footer-bearing
// page, styles under `.legal-menu` in styles/styles.css). That is deliberate: the
// footer is hand-copied into eleven HTML files with no partial, and anything the
// browser gives us for free — opening, closing, focus, Enter/Space, works with
// scripting off — is one less thing that can drift across eleven copies.
//
// So this file adds only what <details> does NOT do, and every one of them is a
// nicety rather than a requirement:
//   • close on a click outside (a <details> left open otherwise stays open behind
//     whatever you clicked next);
//   • close on Escape, returning focus to the trigger;
//   • Arrow Up/Down to walk the rows, as scripts/language-switcher.js does for the
//     language menu — same interaction, so it should feel the same;
//   • keep a panel centred on the trigger from running off the screen edge;
//   • let the panel fade OUT. A <details> drops its content the instant `open` goes,
//     which is a discrete change with nothing to transition, so the exit has to be
//     played first and the attribute removed after.
(function () {
  "use strict";

  function init() {
    var menus = document.querySelectorAll("[data-legal-menu]");
    for (var i = 0; i < menus.length; i++) wire(menus[i]);
  }

  /** @param {Element} root the <details> element */
  function wire(root) {
    var trigger = /** @type {HTMLElement | null} */ (root.querySelector(".legal-menu__trigger"));
    var list = /** @type {HTMLElement | null} */ (root.querySelector(".legal-menu__list"));
    var items = /** @type {HTMLElement[]} */ (Array.prototype.slice.call(root.querySelectorAll(".legal-menu__item")));
    if (!trigger) return;

    // Both handlers stay bound for the life of the page and gate on `open`
    // themselves, rather than being added and removed by a `toggle` listener.
    // `toggle` fires ASYNCHRONOUSLY — the element is already open when it returns,
    // so a key pressed in that gap reached a document with no keydown listener on
    // it yet, and the first Arrow press after opening the menu did nothing. Both
    // checks are a property read on an element we already hold.
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    // `toggle` is what tells us the panel is about to be seen; it fires late (see
    // above) but the clamp only has to beat the 220ms entry transition, not the key
    // that opened it. Resizing while open is the other way the panel can end up over
    // an edge — a phone rotating, or a desktop window dragged narrow.
    root.addEventListener("toggle", clamp);
    window.addEventListener("resize", clamp);
    // The native summary toggle is fine on the way in; on the way out it would drop
    // the content before the exit transition could run, so that half is taken over.
    trigger.addEventListener("click", onTriggerClick);

    // The markup ships `data-legal-menu` empty; this fills it in. It says the
    // enhancement is live, which is a real distinction — everything above is absent
    // until this module arrives, and the menu works the whole time without it. It is
    // also the only observable signal that it HAS arrived, which is what
    // e2e/legal-menu.spec.js waits on before pressing a key at it.
    root.setAttribute("data-legal-menu", "ready");

    var closeTimer = 0;

    function isOpen() {
      return root.hasAttribute("open");
    }

    function isClosing() {
      return root.hasAttribute("data-legal-menu-closing");
    }

    /**
     * Play the exit, then actually close.
     *
     * `open` has to stay on for the duration: the stylesheet's `[open]` rules are
     * what keep the panel rendered at all, and dropping the attribute first is the
     * discrete change that made the rows vanish rather than fade. The closing
     * attribute overrides those rules back to the hidden values, so the same
     * transition runs in reverse.
     *
     * The timer, rather than `transitionend`: the panel and its four rows each fire
     * one, the last is not reliably the panel's, and a transition that never starts
     * (reduced motion, a backgrounded tab) fires nothing at all. 220ms matches the
     * longest duration in the stylesheet; overshooting it only means the panel sits
     * invisible a few ms longer, where undershooting would cut the fade.
     */
    function close() {
      if (!isOpen() || isClosing()) return;
      root.setAttribute("data-legal-menu-closing", "");
      closeTimer = window.setTimeout(finishClose, 220);
    }

    function finishClose() {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
      root.removeAttribute("data-legal-menu-closing");
      root.removeAttribute("open");
    }

    /** Reopening mid-exit: cancel the close instead of letting it land. */
    function cancelClose() {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
      root.removeAttribute("data-legal-menu-closing");
    }

    /** @param {Event} e */
    function onTriggerClick(e) {
      if (isClosing()) {
        // Mid-exit: the element is still `open`, so the native toggle would close it
        // outright. Take the click as "open it again" and let the fade reverse.
        e.preventDefault();
        cancelClose();
        return;
      }
      if (!isOpen()) return; // opening — the native toggle is exactly right
      e.preventDefault();
      close();
    }

    /**
     * Nudge a panel that is centred on the trigger back inside the viewport.
     *
     * The CSS centres it, which is what it should look like and what it does on a
     * desktop. On a phone the trigger is the first item in a centre-aligned footer
     * line, so it sits well left of centre and half the panel would hang off the
     * screen. Measuring beats a breakpoint here: the overflow depends on how wide
     * the rest of the footer line is, which changes with the locale.
     *
     * The shift is written as a custom property rather than as `left`, because the
     * panel's transform is also carrying the entry animation — one of them has to
     * own `transform`, and it is the stylesheet.
     */
    function clamp() {
      if (!list || !isOpen()) return;
      var margin = 16;
      // Layout values, not getBoundingClientRect: the panel's transform is mid-flight
      // when this runs (`toggle` fires as the entry transition starts), so its rect is
      // still scaled to .96 and offset downward. offsetLeft/offsetWidth describe where
      // it will come to rest. offsetLeft is `left:50%` resolved against .legal-menu,
      // and the stylesheet's translateX(-50%) then centres the panel on that point.
      var origin = root.getBoundingClientRect().left + list.offsetLeft;
      var half = list.offsetWidth / 2;
      var shift = 0;
      if (origin - half < margin) shift = margin - (origin - half);
      else if (origin + half > window.innerWidth - margin) shift = window.innerWidth - margin - (origin + half);
      // A panel wider than the viewport cannot be clamped into it; the left-edge case
      // wins, which at least keeps the labels readable from their start.
      list.style.setProperty("--legal-menu-shift", Math.round(shift) + "px");
    }

    /** @param {Event} e */
    function onOutside(e) {
      // Capture phase, so a control that stops propagation still closes this menu.
      if (isOpen() && !root.contains(/** @type {Node} */ (e.target))) close();
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        close();
        trigger.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (!items.length) return;
      e.preventDefault();
      // -1 when focus is still on the trigger, so ArrowDown lands on the first row
      // and ArrowUp wraps to the last.
      var idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (e.key === "ArrowDown") {
        items[Math.min(idx + 1, items.length - 1)].focus();
      } else {
        (idx <= 0 ? items[items.length - 1] : items[idx - 1]).focus();
      }
    }
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
