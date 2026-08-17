/*
 * Aurora scrollbar — a custom scrollbar for the main scroll container with a
 * continuously flowing gradient (blue -> violet -> pink) and a glow.
 *
 * The native scrollbar can't be animated, so we hide it and draw our own thumb
 * that stays synced to the container's scroll position. Functionality (wheel,
 * keyboard, trackpad) is untouched — this only replaces the visual bar.
 *
 * Safe by design:
 *   - Only activates on fine-pointer (desktop) devices; touch keeps native overlay bars.
 *   - The native bar is hidden only once we add the `aurora-on` flag, so if this
 *     script never runs (or errors), the styled native scrollbar remains.
 */

/**
 * The bar's geometry for one frame — pure, so it can be tested without a DOM.
 *
 * The one thing here that is NOT simply "mirror the scrollport": the track runs
 * from the scrollport's top edge all the way to the BOTTOM OF THE WINDOW, not to
 * the scrollport's own bottom edge. `<main>` is the scroll container on this site
 * (styles.css: `body,main{overflow-y:auto}` + `main{flex:1}` in a full-height flex
 * column), so it stops above the pinned site footer — and a rail that ends ~70px
 * short of the window reads as "you cannot scroll any further down", which is
 * exactly what it was reported as. Only the rail moves; the layout is untouched
 * (the footer sits outside <main> on purpose — site-footer-parity.test.js).
 *
 * On the pages whose <main> already reaches the bottom — the ones carrying no shared
 * footer: gallery, masking-studio, ai-designer, exterior-studio, basic-mask —
 * `viewportH - rectTop === rectHeight`, so this is a no-op there by construction.
 *
 * @param {{rectTop:number, rectRight:number, viewportW:number, viewportH:number,
 *          clientH:number, scrollH:number, scrollTop:number, minThumb?:number}} m
 * @returns {{visible:boolean, top:number, height:number, right:number,
 *            thumbHeight:number, thumbTop:number}}
 */
export function auroraBarGeometry(m) {
  var minThumb = typeof m.minThumb === 'number' ? m.minThumb : 40;
  var height = Math.max(0, m.viewportH - m.rectTop);
  var thumbHeight = Math.min(height, Math.max(minThumb, Math.round(height * (m.clientH / m.scrollH))));
  var maxScroll = m.scrollH - m.clientH;
  var maxThumb = Math.max(0, height - thumbHeight);
  return {
    visible: m.scrollH > m.clientH + 1,
    top: m.rectTop,
    height: height,
    right: Math.max(0, m.viewportW - m.rectRight),
    thumbHeight: thumbHeight,
    thumbTop: maxScroll > 0 ? Math.max(0, (m.scrollTop / maxScroll) * maxThumb) : 0,
  };
}

(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;

  var sc = document.querySelector('main');
  if (!sc) return;

  document.documentElement.classList.add('aurora-on');

  var bar = document.createElement('div');
  bar.className = 'aurora-sb';
  bar.setAttribute('aria-hidden', 'true');
  var thumb = document.createElement('div');
  thumb.className = 'aurora-sb__thumb';
  bar.appendChild(thumb);
  document.body.appendChild(bar);

  var trackH = 0, thumbH = 0;
  var dragging = false, dragStartY = 0, dragStartScroll = 0;
  var flareUntil = 0;

  function flare() { bar.classList.add('flare'); flareUntil = (window.performance ? performance.now() : Date.now()) + 450; }

  function update() {
    var r = sc.getBoundingClientRect();
    var g = auroraBarGeometry({
      rectTop: r.top,
      rectRight: r.right,
      viewportW: window.innerWidth,
      // clientHeight excludes a horizontal scrollbar; innerHeight is the fallback
      // for the (impossible here — html carries overflow-x:clip) case of neither.
      viewportH: document.documentElement.clientHeight || window.innerHeight,
      clientH: sc.clientHeight,
      scrollH: sc.scrollHeight,
      scrollTop: sc.scrollTop,
    });

    if (!g.visible) { bar.classList.remove('show'); return; }
    bar.classList.add('show');

    // Anchored to the scroll container's left/top, but run to the window's bottom.
    bar.style.top = g.top + 'px';
    bar.style.height = g.height + 'px';
    bar.style.right = g.right + 'px';

    trackH = g.height;
    thumbH = g.thumbHeight;
    thumb.style.height = thumbH + 'px';
    thumb.style.transform = 'translateY(' + g.thumbTop + 'px)';
  }

  // Drive position + glow timeout from a single rAF loop so the thumb stays in
  // sync even when content height changes (e.g. language switch, lazy images).
  var rafId = 0;
  function tick(now) {
    update();
    if (flareUntil && now > flareUntil) { bar.classList.remove('flare'); flareUntil = 0; }
    rafId = requestAnimationFrame(tick);
  }
  function startLoop() { if (!rafId) rafId = requestAnimationFrame(tick); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  // Pause the loop while the tab is hidden to save battery.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop(); else startLoop();
  });

  sc.addEventListener('scroll', flare, { passive: true });

  // Drag the thumb to scroll.
  thumb.addEventListener('pointerdown', function (e) {
    dragging = true;
    dragStartY = e.clientY;
    dragStartScroll = sc.scrollTop;
    try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
    flare();
    e.preventDefault();
  });
  thumb.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var maxThumb = trackH - thumbH;
    var maxScroll = sc.scrollHeight - sc.clientHeight;
    var dy = e.clientY - dragStartY;
    sc.scrollTop = dragStartScroll + (maxThumb > 0 ? (dy / maxThumb) * maxScroll : 0);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { thumb.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  startLoop();
})();
