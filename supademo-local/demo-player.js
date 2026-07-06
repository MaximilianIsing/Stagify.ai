/* ==========================================================================
   Stagify local walkthrough player
   A dependency-free replacement for the Supademo embed. Given a demo object
   ({ title, aspect, steps:[{ img, text, x, y, bg, fg }] }) it renders a frame
   that steps through the screenshots with a pulsing hotspot + floating callout.

   Usage:  var player = SupademoPlayer.mount(rootEl, demo);
           player.destroy();
   ========================================================================== */
(function (global) {
  'use strict';

  var GAP = 16;      // px between hotspot and callout
  var GUTTER = 10;   // px min distance from frame edge
  var HOTSPOT_R = 11;

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function SupademoPlayer(root, demo) {
    this.root = root;
    this.demo = demo;
    this.steps = demo.steps || [];
    this.i = 0;
    this.activeLayer = 0;
    this._build();
    this._bind();
    this.go(0, true);
    this._preload();
  }

  SupademoPlayer.prototype._build = function () {
    var d = this.demo;
    this.root.classList.add('sdp');
    this.root.style.setProperty('--ar', d.aspect || 1.7778);
    var s0 = this.steps[0] || {};
    if (s0.bg) this.root.style.setProperty('--accent', s0.bg);
    if (s0.fg) this.root.style.setProperty('--accent-ink', s0.fg);

    var frame = el('div', 'sdp__frame', this.root);
    frame.setAttribute('tabindex', '0');
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-roledescription', 'interactive walkthrough');
    frame.setAttribute('aria-label', d.title || 'Walkthrough');
    this.frame = frame;

    // two stacked image layers for crossfading
    this.layers = [el('img', 'sdp__img', frame), el('img', 'sdp__img', frame)];
    this.layers.forEach(function (im) { im.setAttribute('draggable', 'false'); im.decoding = 'async'; });

    // hotspot
    this.hotspot = el('button', 'sdp__hotspot', frame);
    this.hotspot.type = 'button';
    this.hotspot.setAttribute('aria-label', 'Next step');

    // callout
    var tip = el('div', 'sdp__tip', frame);
    this.tip = tip;
    this.text = el('p', 'sdp__text', tip);
    this.text.setAttribute('aria-live', 'polite');
    var foot = el('div', 'sdp__foot', tip);
    this.back = el('button', 'sdp__btn sdp__btn--back', foot);
    this.back.type = 'button';
    this.back.textContent = 'Back';
    this.count = el('span', 'sdp__count', foot);
    el('span', 'sdp__spacer', foot);
    this.next = el('button', 'sdp__btn sdp__btn--next', foot);
    this.next.type = 'button';
    this.next.textContent = 'Next';

    // progress bar
    var bar = el('div', 'sdp__bar', frame);
    this.barFill = el('span', null, bar);

    // dot navigation (under the frame)
    var dots = el('div', 'sdp__dots', this.root);
    this.dots = this.steps.map(function (st, idx) {
      var b = el('button', 'sdp__dot', dots);
      b.type = 'button';
      b.setAttribute('aria-label', 'Go to step ' + (idx + 1));
      return b;
    });
  };

  SupademoPlayer.prototype._bind = function () {
    var self = this;
    // Click anywhere in the frame advances (like Supademo) — except Back.
    this.frame.addEventListener('click', function (e) {
      if (self.back.contains(e.target)) return;
      self.advance();
    });
    this.back.addEventListener('click', function (e) {
      e.stopPropagation();
      self.go(self.i - 1);
    });
    this.dots.forEach(function (b, idx) {
      b.addEventListener('click', function () { self.go(idx); });
    });
    this.frame.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); self.advance(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); self.go(self.i - 1); }
    });
    this._onResize = function () { self._place(); };
    global.addEventListener('resize', this._onResize);
  };

  SupademoPlayer.prototype._preload = function () {
    this.steps.forEach(function (st) { if (st.img) { var im = new Image(); im.src = st.img; } });
  };

  SupademoPlayer.prototype.advance = function () {
    this.go(this.i >= this.steps.length - 1 ? 0 : this.i + 1);
  };

  SupademoPlayer.prototype.go = function (idx, immediate) {
    var n = this.steps.length;
    if (!n) return;
    idx = clamp(idx, 0, n - 1);
    this.i = idx;
    var st = this.steps[idx];

    // crossfade to the new image
    var incoming = this.layers[this.activeLayer ^ 1];
    var outgoing = this.layers[this.activeLayer];
    var swap = function () {
      incoming.classList.add('is-shown');
      outgoing.classList.remove('is-shown');
    };
    if (incoming.getAttribute('src') !== st.img) {
      incoming.src = st.img;
    }
    incoming.alt = 'Step ' + (idx + 1) + ': ' + (st.text || '');
    if (immediate || incoming.complete) swap();
    else incoming.onload = swap;
    this.activeLayer ^= 1;

    // accent (constant across steps here, but honor per-step values)
    if (st.bg) this.root.style.setProperty('--accent', st.bg);
    if (st.fg) this.root.style.setProperty('--accent-ink', st.fg);

    // text + counter + controls
    this.text.textContent = st.text || '';
    this.count.textContent = (idx + 1) + ' / ' + n;
    this.back.hidden = idx === 0;
    this.next.textContent = idx === n - 1 ? 'Restart' : 'Next';
    this.barFill.style.width = ((idx + 1) / n * 100) + '%';
    this.dots.forEach(function (b, k) { b.classList.toggle('is-active', k === idx); });

    this._place();
  };

  // Position the callout above/below the hotspot, clamped inside the frame,
  // with the beak pointing at the hotspot.
  SupademoPlayer.prototype._place = function () {
    var st = this.steps[this.i];
    if (!st) return;
    var fw = this.frame.clientWidth, fh = this.frame.clientHeight;
    if (!fw || !fh) return;

    var hasHotspot = st.x != null && st.y != null;
    if (!hasHotspot) {
      this.hotspot.style.display = 'none';
      this.tip.setAttribute('data-place', 'center');
      this.tip.style.left = '50%';
      this.tip.style.top = 'auto';
      this.tip.style.bottom = GUTTER + 'px';
      this.tip.style.transform = 'translateX(-50%)';
      return;
    }
    this.hotspot.style.display = '';
    this.tip.style.bottom = 'auto';
    this.tip.style.transform = 'none';

    var hx = clamp(st.x, 0, 100) / 100 * fw;
    var hy = clamp(st.y, 0, 100) / 100 * fh;
    this.hotspot.style.left = hx + 'px';
    this.hotspot.style.top = hy + 'px';

    var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;

    // horizontal: center card on hotspot, clamp within frame
    var left = clamp(hx - tw / 2, GUTTER, fw - tw - GUTTER);

    // vertical: prefer below; flip above if it would overflow the bottom
    var place = 'b';
    var top = hy + HOTSPOT_R + GAP;
    if (top + th > fh - GUTTER) {
      var above = hy - HOTSPOT_R - GAP - th;
      if (above >= GUTTER) { place = 't'; top = above; }
      else { top = clamp(top, GUTTER, fh - th - GUTTER); } // no room either way → best effort
    }

    this.tip.setAttribute('data-place', place);
    this.tip.style.left = left + 'px';
    this.tip.style.top = top + 'px';
    this.tip.style.setProperty('--beak-left', clamp(hx - left, 20, tw - 20) + 'px');
  };

  SupademoPlayer.prototype.destroy = function () {
    global.removeEventListener('resize', this._onResize);
    this.root.innerHTML = '';
    this.root.classList.remove('sdp');
  };

  var api = {
    mount: function (root, demo) { return new SupademoPlayer(root, demo); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SupademoPlayer = api;
})(typeof window !== 'undefined' ? window : this);
