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
(function () {
  'use strict';

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
    var ch = sc.clientHeight, sh = sc.scrollHeight, st = sc.scrollTop;
    if (sh <= ch + 1) { bar.classList.remove('show'); return; }
    bar.classList.add('show');

    // Anchor the bar over the scroll container's visible viewport.
    var r = sc.getBoundingClientRect();
    bar.style.top = r.top + 'px';
    bar.style.height = r.height + 'px';
    bar.style.right = Math.max(0, window.innerWidth - r.right) + 'px';

    trackH = r.height;
    thumbH = Math.max(40, Math.round(trackH * (ch / sh)));
    var maxScroll = sh - ch;
    var maxThumb = trackH - thumbH;
    var top = maxScroll > 0 ? (st / maxScroll) * maxThumb : 0;
    thumb.style.height = thumbH + 'px';
    thumb.style.transform = 'translateY(' + top + 'px)';
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
