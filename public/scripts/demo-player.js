/* ==========================================================================
   Stagify local walkthrough player — faithful rebuild of the Supademo embed.

   Given a demo ({ title, aspect, steps:[{ img, zoom, callouts:[…] }] }) it:
     • pans + zooms a "camera" to each step's crop rectangle (animated),
     • draws the step's callout — "Area" (rounded highlight over a UI element),
       "Tooltip" (pointless text card), or "Circle" (hotspot dot) — in the
       step's own colour, positioned per its tipposition,
     • steps via click / Next / Back / dots / arrow keys.

   Usage:  var p = SupademoPlayer.mount(rootEl, demo);  p.destroy();
   ========================================================================== */
(function (global) {
  'use strict';

  var GAP = 14;     // px between anchor and callout card
  var G = 10;       // px min gap from frame edge
  var BEAK = 16;    // px beak inset from card corner

  // circular-arrow "restart" glyph shown on the final step's button
  var RESTART_ICON = '<svg class="sdp__btn-ic" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><polyline points="1 4 1 10 7 10"/>' +
    '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function clamp(v, lo, hi) { return hi < lo ? lo : Math.max(lo, Math.min(hi, v)); }

  function SupademoPlayer(root, demo, opts) {
    opts = opts || {};
    this.root = root;
    this.demo = demo;
    this.steps = demo.steps || [];
    this.showDots = opts.dots !== false;   // pass {dots:false} for a chrome-free showcase
    this.i = 0;
    this.activeLayer = 0;
    this.currentSrc = null;
    this._ready = false;
    this._S = 1; this._zx = 0; this._zy = 0;
    this._build();
    this._bind();
    this.go(0, true);
  }

  SupademoPlayer.prototype._build = function () {
    var d = this.demo;
    this.root.classList.add('sdp');
    this.root.style.setProperty('--ar', d.aspect || 1.7778);

    var frame = el('div', 'sdp__frame', this.root);
    frame.setAttribute('tabindex', '0');
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-roledescription', 'interactive walkthrough');
    frame.setAttribute('aria-label', d.title || 'Walkthrough');
    this.frame = frame;

    // camera stage: holds the images + the in-scene callouts (area/dot)
    var stage = el('div', 'sdp__stage', frame);
    this.stage = stage;
    this.layers = [el('img', 'sdp__img', stage), el('img', 'sdp__img', stage)];
    this.layers.forEach(function (im) { im.setAttribute('draggable', 'false'); im.decoding = 'async'; });
    this.area = el('div', 'sdp__area', stage);
    this.dot = el('div', 'sdp__dot-hs', stage);

    // callout card (frame level — never scaled by the camera)
    var tip = el('div', 'sdp__tip', frame);
    this.tip = tip;
    this.text = el('p', 'sdp__text', tip);
    this.text.setAttribute('aria-live', 'polite');
    var foot = el('div', 'sdp__foot', tip);
    this.back = el('button', 'sdp__btn sdp__btn--back', foot);
    this.back.type = 'button'; this.back.textContent = 'Back';
    this.count = el('span', 'sdp__count', foot);
    el('span', 'sdp__spacer', foot);
    this.next = el('button', 'sdp__btn sdp__btn--next', foot);
    this.next.type = 'button'; this.next.textContent = 'Next';

    var bar = el('div', 'sdp__bar', frame);
    this.barFill = el('span', null, bar);

    // loading skeleton (shown until the first frame paints — no external markup needed)
    this.skeleton = el('div', 'sdp__skeleton', frame);
    this.skeleton.setAttribute('aria-hidden', 'true');
    el('span', 'sdp__spinner', this.skeleton);

    if (this.showDots) {
      var dots = el('div', 'sdp__dots', this.root);
      this.dots = this.steps.map(function (st, idx) {
        var b = el('button', 'sdp__dot', dots);
        b.type = 'button';
        b.setAttribute('aria-label', 'Go to step ' + (idx + 1));
        return b;
      });
    } else {
      this.dots = [];
    }
  };

  SupademoPlayer.prototype._bind = function () {
    var self = this;
    this.frame.addEventListener('click', function (e) {
      if (self.back.contains(e.target)) return;
      self.advance();
    });
    this.back.addEventListener('click', function (e) { e.stopPropagation(); self.go(self.i - 1); });
    this.dots.forEach(function (b, idx) { b.addEventListener('click', function () { self.go(idx); }); });
    this.frame.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); self.advance(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); self.go(self.i - 1); }
    });
    this._onResize = function () { self._place(self._callout(), true); };
    global.addEventListener('resize', this._onResize);
  };

  SupademoPlayer.prototype._warm = function (idx) {
    // Warm only the neighbouring frames so a mount costs ~1–2 image loads, not
    // the whole demo. Remaining frames load on demand as the user steps through.
    var steps = this.steps;
    [idx + 1, idx - 1].forEach(function (k) {
      var st = steps[k];
      if (st && st.img) { var im = new Image(); im.src = st.img; }
    });
  };

  SupademoPlayer.prototype._callout = function () {
    var st = this.steps[this.i];
    return (st && st.callouts && st.callouts[0]) || {};
  };

  SupademoPlayer.prototype.advance = function () {
    this.go(this.i >= this.steps.length - 1 ? 0 : this.i + 1);
  };

  SupademoPlayer.prototype.go = function (idx, immediate) {
    var n = this.steps.length; if (!n) return;
    idx = clamp(idx, 0, n - 1);
    this.i = idx;
    var st = this.steps[idx];
    var c = (st.callouts && st.callouts[0]) || {};

    if (c.bg) this.root.style.setProperty('--accent', c.bg);
    if (c.fg) this.root.style.setProperty('--accent-ink', c.fg);

    // crossfade the underlying screenshot only when it actually changes
    if (st.img !== this.currentSrc) {
      var incoming = this.layers[this.activeLayer ^ 1];
      var outgoing = this.layers[this.activeLayer];
      incoming.alt = 'Step ' + (idx + 1) + ': ' + (c.text || '');
      var self = this;
      var reveal = function () {
        incoming.classList.add('is-shown');
        outgoing.classList.remove('is-shown');
        if (!self._ready) { self._ready = true; self.root.classList.add('is-ready'); }
      };
      if (incoming.getAttribute('src') !== st.img) incoming.src = st.img;
      // Never reveal an unloaded frame — the skeleton stays up until it paints.
      if (incoming.complete) reveal();
      else incoming.onload = reveal;
      this.activeLayer ^= 1;
      this.currentSrc = st.img;
    }

    this._camera(st, immediate);

    // callout content
    this.text.textContent = c.text || '';
    this.tip.setAttribute('data-align', c.align || 'Left');
    this.count.textContent = (idx + 1) + ' / ' + n;
    this.back.hidden = idx === 0;
    if (idx === n - 1) this.next.innerHTML = RESTART_ICON + '<span>Restart</span>';
    else this.next.textContent = 'Next';
    this.barFill.style.width = ((idx + 1) / n * 100) + '%';
    this.dots.forEach(function (b, k) { b.classList.toggle('is-active', k === idx); });

    // in-scene shapes
    if (c.style === 'Area' && c.bw != null) {
      this.area.classList.add('is-on');
      this.dot.classList.remove('is-on');
      this.area.style.left = (c.cx - c.bw / 2) + '%';
      this.area.style.top = (c.cy - c.bh / 2) + '%';
      this.area.style.width = c.bw + '%';
      this.area.style.height = c.bh + '%';
    } else if (c.style === 'Circle' && c.cx != null) {
      this.dot.classList.add('is-on');
      this.area.classList.remove('is-on');
      this.dot.style.left = c.cx + '%';
      this.dot.style.top = c.cy + '%';
    } else {
      this.area.classList.remove('is-on');
      this.dot.classList.remove('is-on');
    }

    this._place(c, immediate);
    this._warm(idx);
  };

  SupademoPlayer.prototype._camera = function (st, immediate) {
    var z = st.zoom;
    var S = z && z.w ? 100 / z.w : 1;
    var zx = z ? z.x : 0, zy = z ? z.y : 0;
    this._S = S; this._zx = zx; this._zy = zy;
    if (immediate) this.stage.classList.add('no-anim');
    this.stage.style.setProperty('--s', S);
    this.stage.style.transform = 'translate(' + (-S * zx) + '%, ' + (-S * zy) + '%) scale(' + S + ')';
    if (immediate) { void this.stage.offsetWidth; this.stage.classList.remove('no-anim'); }
  };

  // Position the callout card at frame level using the camera-transformed anchor.
  SupademoPlayer.prototype._place = function (c, immediate) {
    c = c || {};
    var fw = this.frame.clientWidth, fh = this.frame.clientHeight;
    if (!fw || !fh) return;
    var S = this._S, zx = this._zx, zy = this._zy;

    // anchor rectangle in frame px (zero-size for point-style callouts)
    var Lpx, Tpx, Wpx, Hpx;
    if (c.style === 'Area' && c.bw != null) {
      Lpx = S * (c.cx - c.bw / 2 - zx) / 100 * fw;
      Tpx = S * (c.cy - c.bh / 2 - zy) / 100 * fh;
      Wpx = S * c.bw / 100 * fw;
      Hpx = S * c.bh / 100 * fh;
    } else {
      Lpx = S * ((c.cx != null ? c.cx : 50) - zx) / 100 * fw;
      Tpx = S * ((c.cy != null ? c.cy : 50) - zy) / 100 * fh;
      Wpx = 0; Hpx = 0;
    }

    var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    var midX = Lpx + Wpx / 2, midY = Tpx + Hpx / 2;
    var place, left, top, ax, ay;

    function below() { ax = midX; ay = Tpx + Hpx; left = ax - tw / 2; top = ay + GAP; place = 'bottom'; }
    function above() { ax = midX; ay = Tpx; left = ax - tw / 2; top = ay - GAP - th; place = 'top'; }
    function toRight() { ax = Lpx + Wpx; ay = midY; left = ax + GAP; top = ay - th / 2; place = 'right'; }
    function toLeft() { ax = Lpx; ay = midY; left = ax - GAP - tw; top = ay - th / 2; place = 'left'; }
    function center() { left = (fw - tw) / 2; top = (fh - th) / 2; place = 'center'; }

    // Resolve which side the card sits on.
    // A "Tooltip" (pointless) callout on a no-zoom step is a full-frame
    // intro/outro card — always centre it (centred cards draw no beak), even if
    // its stored tipposition says otherwise (e.g. the Masking welcome is "top").
    var stepZoom = this.steps[this.i] && this.steps[this.i].zoom;
    var side = c.tip;
    if (c.style === 'Tooltip') {
      if (!stepZoom || !side || side === 'autostart') side = 'center';
    } else if (!side || side === 'autostart') {
      side = 'auto';
    }

    if (side === 'center') center();
    else if (side === 'top') above();
    else if (side === 'bottom') below();
    else if (side === 'right') toRight();
    else if (side === 'left') toLeft();
    else { // auto — pick the side with room, preferring below then above then sides
      if (fh - (Tpx + Hpx) >= th + GAP + G) below();
      else if (Tpx >= th + GAP + G) above();
      else if (fw - (Lpx + Wpx) >= tw + GAP + G) toRight();
      else if (Lpx >= tw + GAP + G) toLeft();
      else below();
    }

    left = clamp(left, G, fw - tw - G);
    top = clamp(top, G, fh - th - G);

    if (immediate) this.tip.classList.add('no-anim');
    this.tip.setAttribute('data-place', place);
    this.tip.style.left = left + 'px';
    this.tip.style.top = top + 'px';
    if (place === 'top' || place === 'bottom') {
      this.tip.style.setProperty('--beak-x', clamp(ax - left, BEAK, tw - BEAK) + 'px');
    } else if (place === 'left' || place === 'right') {
      this.tip.style.setProperty('--beak-y', clamp(ay - top, BEAK, th - BEAK) + 'px');
    }
    if (immediate) { void this.tip.offsetWidth; this.tip.classList.remove('no-anim'); }
  };

  // Recompute the callout position — call after the player becomes visible
  // again (e.g. a tab it lives in is re-activated) or its box resizes.
  SupademoPlayer.prototype.reflow = function () { this._place(this._callout(), true); };

  SupademoPlayer.prototype.destroy = function () {
    global.removeEventListener('resize', this._onResize);
    this.root.innerHTML = '';
    this.root.classList.remove('sdp');
  };

  var api = { mount: function (root, demo, opts) { return new SupademoPlayer(root, demo, opts); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SupademoPlayer = api;
})(typeof window !== 'undefined' ? window : this);
