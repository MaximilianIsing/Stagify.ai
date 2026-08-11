/* Stagify.ai — which box actually scrolls, and which band of pixels it paints.
 *
 * THE HOMEPAGE DOES NOT SCROLL THE WINDOW. `<main>` is the scroll container
 * (`overflow-y: auto`, ~8800px of content in a ~740px box) and `window.scrollY` is
 * pinned at 0 for the entire page. Two consequences bite every scroll-driven
 * animation on the site, and both used to be rediscovered file by file:
 *
 *   1. The painted band is main's border box — on an 842px viewport that is roughly
 *      [89, 773], NOT [0, 842]. Measuring against `window.innerHeight` budgets ~70px
 *      of headroom that does not exist and fires animations below the last visible
 *      pixel.
 *   2. An IntersectionObserver left at `root: null` still CLIPS against main, but its
 *      `rootMargin` expands the viewport, not main's clip rect. So a margin smaller
 *      than main's own inset is silently inert — `-6% 0px -6% 0px` on an 842px
 *      viewport gives [50, 791], looser than [89, 773] at both edges, and therefore
 *      changes nothing at all. Worse, a POSITIVE bottom margin cannot buy an early
 *      trigger either, because main's clip is what actually bounds the intersection.
 *      Arming an animation before its element is painted requires passing `root`
 *      explicitly, and then the margin means what it says.
 *
 * This module is the one place that resolves it. Import it rather than re-deriving the
 * walk; test/frontend/scroll-root.test.js fails the build on a second copy.
 */

/**
 * The element `el` actually scrolls in, or null for the viewport.
 *
 * @param {Element} el
 * @returns {Element|null}
 */
export function scrollRootOf(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The client-coordinate band `root` actually paints — its border box, or the viewport.
 *
 * @param {Element|null} root
 * @returns {{ top: number, bottom: number }}
 */
export function viewportBand(root) {
  if (root) {
    const r = root.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return { top: 0, bottom: vh };
}
