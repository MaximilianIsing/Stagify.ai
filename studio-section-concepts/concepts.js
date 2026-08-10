/* Prototype page for the #staging-studio section redesign. Throwaway — not part of
   the app, never served (this folder sits outside public/).

   Classic script on purpose: the folder is opened over file://, where
   <script type="module"> is blocked by CORS. That is the same reason the earlier
   info-section-concepts/ prototype was a classic script.

   Every concept draws from the SAME copy and the SAME images below. The height
   badges only mean anything if each layout is holding identical content. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ media */

  /* The real shipped WebPs. <img> over file:// has no CORS restriction, so the
     concepts show actual product output rather than gradient placeholders — which
     matters here in a way it didn't for the #learn prototype, because in this
     section the imagery IS the argument.

     Pair mapping is from staging-studio.js:18-31 — pair 2 is the Bedroom (the
     default), pair 1 the Living Room, pair 3 the Dining Room.

     Heads-up if you extend this: pairs 1 and 3 are NOT dimension-matched
     (Before1 898x600 vs After1 1264x845; Before3 600x400 vs After3 1264x843).
     They only look fine because every frame here is object-fit: cover in a 3:2
     box, exactly as .ba img is in home.css. Any layout that shows a before and an
     after at different sizes side by side will expose the upscale. */
  var M = '../public/media-webp/Homepage/';
  var PAIRS = {
    bedroom: { before: M + 'BeforeAfter/Before2.webp', after: M + 'BeforeAfter/After2.webp', room: 'Bedroom' },
    living: { before: M + 'BeforeAfter/Before1.webp', after: M + 'BeforeAfter/After1.webp', room: 'Living Room' },
    dining: { before: M + 'BeforeAfter/Before3.webp', after: M + 'BeforeAfter/After3.webp', room: 'Dining Room' },
    exterior: { before: M + 'Exterior/Before.webp', after: M + 'Exterior/After.webp', room: 'Exterior' }
  };

  /* The seven shipped furniture styles, in the order the staging modal lists them
     (public/index.html:1763-1770, and lib/staging/promptMatrix.js agrees). "Custom"
     is the eighth option in the product but is a free-text prompt, not a preset, so
     it appears here only as a chip.

     The `filter` values are STAND-INS. Seven per-style renders of one room do not
     exist yet, so each tile is the one real bedroom render, colour-graded, and
     stamped STAND-IN. They exist to judge grid density, tile size and label
     legibility — never to judge the styling itself. */
  var STYLES = [
    { key: 'standard', label: 'Standard', filter: 'none' },
    { key: 'modern', label: 'Modern', filter: 'saturate(1.18) contrast(1.06) hue-rotate(-6deg)' },
    { key: 'midcentury', label: 'Midcentury', filter: 'sepia(0.34) saturate(1.3) hue-rotate(-14deg)' },
    { key: 'scandinavian', label: 'Scandinavian', filter: 'brightness(1.12) saturate(0.7)' },
    { key: 'luxury', label: 'Luxury', filter: 'contrast(1.14) saturate(1.08) brightness(0.92) hue-rotate(9deg)' },
    { key: 'coastal', label: 'Coastal', filter: 'hue-rotate(16deg) saturate(1.22) brightness(1.06)' },
    { key: 'farmhouse', label: 'Farmhouse', filter: 'sepia(0.3) saturate(0.94) brightness(1.04)' }
  ];

  /* ------------------------------------------------------------------- copy */

  /* Strings that already exist and are translated in all 11 packs are marked with
     their key. Anything without a key is NEW and would cost 11 pack edits —
     test/server/static.test.js enforces cross-pack key parity, so there is no
     "add it to English only" option.

     Note home.studio.eyebrow ("Before & after") already exists, is translated
     everywhere, and is rendered NOWHERE on the page. It is a free slot. */
  var COPY = {
    // home.studio.title / .subtitle
    todayTitle: 'Drag to see what staging does',
    todaySub: 'The same listing photo, before and after Stagify. No movers, no rentals, no waiting.',
    // home.studio.kicker / .panelTitle / .panelBody
    kicker: 'How it looks',
    panelTitle: 'The same room, staged in seconds',
    panelBody: 'Drag the handle. The left is the original photo; everything on the right was staged by Stagify in seconds.',
    // home.studio.points.*
    points: [
      'About 8 seconds per photo',
      'Re-stage in any style, as often as you like',
      'Every image is yours, with full copyright'
    ],
    // home.studio.beforeLabel / .afterLabel
    before: 'Before',
    after: 'After',
    // home.studio.examples.*
    rooms: ['Bedroom', 'Living Room', 'Dining Room'],
    // home.studio.eyebrow — exists, translated, currently unused
    eyebrow: 'Before & after'
  };

  /* --------------------------------------------------------------- utilities */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function img(src, alt, cls) {
    var n = document.createElement('img');
    n.src = src;
    n.alt = alt || '';
    if (cls) n.className = cls;
    n.loading = 'lazy';
    n.decoding = 'async';
    return n;
  }

  function standin() {
    return el('span', 'standin', 'STAND-IN');
  }

  /* --------------------------------------------------------- the .ba wipe */

  /* A trimmed copy of mountWipe() from public/scripts/staging-studio.js: Pointer
     Events only (no mouse/touch split), setPointerCapture, and the full WAI-ARIA
     slider keyboard set. The one thing deliberately left out is the auto-sweep
     hint, because eight concepts sweeping at once would be noise. */
  function mountWipe(ba) {
    var handle = ba.querySelector('.ba-handle');
    if (!handle) return null;
    var pos = 52;

    function setPos(p) {
      pos = Math.max(0, Math.min(100, p));
      ba.style.setProperty('--pos', pos + '%');
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
      handle.setAttribute('aria-valuetext', Math.round(pos) + '%');
    }

    function fromEvent(e) {
      var r = ba.getBoundingClientRect();
      if (!r.width) return;
      setPos(((e.clientX - r.left) / r.width) * 100);
    }

    var dragging = false;
    ba.addEventListener('pointerdown', function (e) {
      dragging = true;
      ba.classList.add('is-dragging');
      if (e.pointerType === 'mouse') {
        fromEvent(e);
        e.preventDefault();
      }
      try { ba.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
    });
    ba.addEventListener('pointermove', function (e) {
      if (dragging) fromEvent(e);
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      ba.classList.remove('is-dragging');
      try { ba.releasePointerCapture(e.pointerId); } catch (_) { /* best effort */ }
    }
    ba.addEventListener('pointerup', end);
    ba.addEventListener('pointercancel', end);

    handle.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowDown') setPos(pos - 4);
      else if (k === 'ArrowRight' || k === 'ArrowUp') setPos(pos + 4);
      else if (k === 'PageDown') setPos(pos - 20);
      else if (k === 'PageUp') setPos(pos + 20);
      else if (k === 'Home') setPos(0);
      else if (k === 'End') setPos(100);
      else return;
      e.preventDefault();
    });

    setPos(pos);
    return { setPos: setPos };
  }

  function buildBa(before, after, altBefore, altAfter) {
    var ba = el('div', 'ba');
    ba.setAttribute('role', 'group');
    ba.setAttribute('aria-label', 'Before and after staging comparison');
    ba.appendChild(img(after, altAfter, 'ba-after'));
    ba.appendChild(img(before, altBefore, 'ba-before'));
    ba.appendChild(el('span', 'ba-tag ba-tag--before', COPY.before));
    ba.appendChild(el('span', 'ba-tag ba-tag--after', COPY.after));
    var h = el('div', 'ba-handle');
    h.setAttribute('role', 'slider');
    h.tabIndex = 0;
    h.setAttribute('aria-label', 'Reveal slider');
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', '100');
    h.appendChild(el('span', 'ba-handle__grip', '‹›'));
    ba.appendChild(h);
    return ba;
  }

  function sectionHead(title, sub, centered, eyebrow) {
    var head = el('div', 'hs__head' + (centered ? ' hs__head--center' : ''));
    if (eyebrow) head.appendChild(el('p', 'hs__eyebrow', eyebrow));
    head.appendChild(el('h2', 'hs__title', title));
    head.appendChild(el('p', 'hs__sub', sub));
    return head;
  }

  /* ------------------------------------------------------------ 0. today */

  function renderToday(root) {
    root.appendChild(sectionHead(COPY.todayTitle, COPY.todaySub, false));

    var shell = el('div', 'studio-shell');
    var ba = buildBa(
      PAIRS.bedroom.before,
      PAIRS.bedroom.after,
      'Empty bedroom before virtual staging',
      'Bedroom after AI virtual staging with Stagify.ai'
    );
    shell.appendChild(ba);

    var side = el('aside', 'studio-side glass');
    side.appendChild(el('div', 'studio-side__kicker', COPY.kicker));
    side.appendChild(el('h3', 'studio-side__title', COPY.panelTitle));
    side.appendChild(el('p', 'studio-side__body', COPY.panelBody));
    var list = el('ul', 'home-list');
    COPY.points.forEach(function (p) { list.appendChild(el('li', null, p)); });
    side.appendChild(list);

    var exWrap = el('div', 'studio-examples');
    var keys = ['bedroom', 'living', 'dining'];
    var btns = COPY.rooms.map(function (label, i) {
      var b = el('button', 'studio-ex' + (i === 0 ? ' is-active' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      b.addEventListener('click', function () {
        btns.forEach(function (o, j) {
          o.classList.toggle('is-active', j === i);
          o.setAttribute('aria-pressed', j === i ? 'true' : 'false');
        });
        ba.querySelector('.ba-before').src = PAIRS[keys[i]].before;
        ba.querySelector('.ba-after').src = PAIRS[keys[i]].after;
      });
      exWrap.appendChild(b);
      return b;
    });
    side.appendChild(exWrap);
    shell.appendChild(side);
    root.appendChild(shell);
    mountWipe(ba);
  }

  /* --------------------------------------- 1-3. the style family (shared) */

  /* One markup path, three modifier classes — the same trick that made concepts
     7-10 of the #learn prototype cheap to narrow down. The CSS carries the
     difference, so dropping two of the three costs nothing. */
  function buildLookTiles(onPick) {
    var tiles = el('div', 'look__tiles');
    var nodes = [];

    var empty = el('button', 'tile tile--empty');
    empty.type = 'button';
    empty.appendChild(img(PAIRS.bedroom.before, 'The same bedroom, empty'));
    empty.appendChild(el('span', 'tile__label', 'Empty room'));
    tiles.appendChild(empty);
    nodes.push(empty);

    STYLES.forEach(function (s, i) {
      var t = el('button', 'tile' + (i === 0 ? ' is-active' : ''));
      t.type = 'button';
      var im = img(PAIRS.bedroom.after, 'Bedroom staged in the ' + s.label + ' style');
      im.style.filter = s.filter;
      t.appendChild(im);
      t.appendChild(el('span', 'tile__label', s.label));
      t.appendChild(standin());
      tiles.appendChild(t);
      nodes.push(t);
    });

    if (onPick) {
      nodes.forEach(function (n, idx) {
        n.addEventListener('click', function () {
          nodes.forEach(function (o, j) { o.classList.toggle('is-active', j === idx); });
          onPick(idx === 0 ? null : STYLES[idx - 1]);
        });
      });
    }
    return tiles;
  }

  function buildLookFrame() {
    var frame = el('div', 'look__frame');
    frame.appendChild(img(PAIRS.bedroom.before, 'The same bedroom, empty', 'look__empty'));
    var staged = img(PAIRS.bedroom.after, 'Bedroom staged by Stagify', 'look__staged');
    frame.appendChild(staged);
    var cap = el('div', 'look__caption');
    cap.innerHTML = '<b>Bedroom</b><span>&middot;</span><b class="look__style">Standard</b>';
    frame.appendChild(cap);
    frame.appendChild(standin());
    return { frame: frame, staged: staged, name: cap.querySelector('.look__style') };
  }

  function renderBoard(root) {
    root.appendChild(sectionHead(
      'One photo. Seven looks.',
      'The same empty bedroom, staged in every style Stagify ships. Pick one. Change your mind as often as you like — it costs a click, not a furniture rental.',
      false,
      COPY.eyebrow
    ));
    var wrap = el('div', 'look look--board');
    var f = buildLookFrame();
    wrap.appendChild(f.frame);
    wrap.appendChild(buildLookTiles(function (style) {
      if (!style) {
        f.staged.style.opacity = '0';
        f.name.textContent = 'Empty';
        return;
      }
      f.staged.style.opacity = '1';
      f.staged.style.filter = style.filter;
      f.name.textContent = style.label;
    }));
    root.appendChild(wrap);
  }

  function renderMosaic(root) {
    root.appendChild(sectionHead(
      'One photo. Seven looks.',
      'Every furniture style Stagify ships, applied to the same empty bedroom. No movers, no rentals, no re-shoot.',
      true,
      COPY.eyebrow
    ));
    var wrap = el('div', 'look look--mosaic');
    // No onPick: this concept deliberately has no active state and no JS at all
    // in its shipped form. The tiles are built here only because this prototype
    // renders everything from one script.
    wrap.appendChild(buildLookTiles(null));
    root.appendChild(wrap);
  }

  function renderRail(root) {
    root.appendChild(sectionHead(
      'Every style, on your photo',
      'Pick a look and Stagify restages the room. Hold the photo to drop back to the empty original.',
      true,
      COPY.eyebrow
    ));
    var wrap = el('div', 'look look--rail');
    var f = buildLookFrame();
    wrap.appendChild(f.frame);

    var rail = el('div', 'rail');
    var chips = STYLES.map(function (s, i) {
      var c = el('button', 'rail__chip' + (i === 0 ? ' is-active' : ''), s.label);
      c.type = 'button';
      c.addEventListener('click', function () {
        chips.forEach(function (o, j) { o.classList.toggle('is-active', j === i); });
        f.staged.style.filter = s.filter;
        f.name.textContent = s.label;
      });
      rail.appendChild(c);
      return c;
    });
    var custom = el('button', 'rail__chip rail__chip--custom', '+ Custom prompt');
    custom.type = 'button';
    rail.appendChild(custom);
    wrap.appendChild(rail);

    var peek = el('button', 'peek', 'Hold to see the empty room');
    peek.type = 'button';
    function hold(on) {
      f.frame.classList.toggle('is-peeking', on);
      peek.classList.toggle('is-held', on);
    }
    peek.addEventListener('pointerdown', function () { hold(true); });
    f.frame.addEventListener('pointerdown', function () { hold(true); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      peek.addEventListener(ev, function () { hold(false); });
      f.frame.addEventListener(ev, function () { hold(false); });
    });
    peek.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { hold(true); e.preventDefault(); }
    });
    peek.addEventListener('keyup', function () { hold(false); });
    peek.addEventListener('blur', function () { hold(false); });
    wrap.appendChild(peek);
    root.appendChild(wrap);
  }

  /* ------------------------------------------------------------- 4. deck */

  function renderDeck(root) {
    root.appendChild(sectionHead(
      'Not quite right? Stage it again.',
      'Every run furnishes the room fresh, so a second pass is a second option — not a revision request and not another invoice.',
      false,
      COPY.eyebrow
    ));

    var wrap = el('div', 'deck');
    var stack = el('div', 'deck__stack');
    var order = STYLES.map(function (_, i) { return i; });
    var cards = STYLES.map(function (s) {
      var c = el('div', 'deck__card');
      var im = img(PAIRS.bedroom.after, 'Bedroom staged in the ' + s.label + ' style');
      im.style.filter = s.filter;
      c.appendChild(im);
      c.appendChild(el('span', 'deck__badge', s.label));
      c.appendChild(standin());
      stack.appendChild(c);
      return c;
    });

    /* The offsets have to be big enough to read as a stack. At translateY(-7px) +
       scale(0.97) the cards behind sat entirely under the top one and the whole
       thing looked like a single photo with a heavy shadow — the one interaction
       this concept is about was invisible until you clicked. */
    function layout() {
      order.forEach(function (cardIdx, depth) {
        var c = cards[cardIdx];
        c.style.zIndex = String(STYLES.length - depth);
        // Leans LEFT on purpose: at depth 3 the fan is 36px wide, which spills into
        // the section's own 48px padding. Fanning right would put it under the copy
        // card, since the grid gap is only 24px.
        c.style.transform =
          'translate(' + depth * -12 + 'px, ' + depth * -9 + 'px) scale(' +
          (1 - depth * 0.035) + ') rotate(' + depth * -1.6 + 'deg)';
        c.style.opacity = depth > 3 ? '0' : '1';
      });
    }
    layout();
    wrap.appendChild(stack);

    var side = el('aside', 'deck__side glass');
    side.appendChild(el('div', 'studio-side__kicker', 'Re-stage'));
    side.appendChild(el('h3', 'studio-side__title', 'Seven looks, one photo'));
    side.appendChild(el(
      'p',
      'studio-side__body',
      'Traditional staging gives you one arrangement and a rental agreement. Run it again here and the room comes back furnished a different way.'
    ));
    var count = el('div', 'deck__count', '');
    var btn = el('button', 'btn-primary', 'Stage it again');
    btn.type = 'button';
    var busy = false;
    function updateCount() {
      count.textContent = 'Showing ' + STYLES[order[0]].label + ' · ' + STYLES.length + ' styles ship today';
    }
    updateCount();
    btn.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      var top = cards[order[0]];
      top.classList.add('is-gone');
      window.setTimeout(function () {
        order.push(order.shift());
        top.classList.remove('is-gone');
        layout();
        updateCount();
        busy = false;
        btn.disabled = false;
      }, 460);
    });
    side.appendChild(btn);
    side.appendChild(count);
    wrap.appendChild(side);
    root.appendChild(wrap);
  }

  /* ------------------------------------------------------------- 5. reel */

  function renderReel(root) {
    root.appendChild(sectionHead(
      'A whole listing, not one lucky photo',
      'Four real pairs from this repo plus two stand-ins, staged as one set. Scroll the row, or flip the whole listing at once.',
      false,
      COPY.eyebrow
    ));

    var bar = el('div', 'reel__bar');
    bar.appendChild(el('div', 'reel__addr', '6 photos · one listing'));
    var toggle = el('div', 'toggle');
    // No class on the buttons themselves — the CSS targets `.toggle button`, and
    // giving them `toggle` would apply the container's own pill styling to each.
    var bBefore = el('button', null, COPY.before);
    var bAfter = el('button', 'is-active', COPY.after);
    bBefore.type = 'button';
    bAfter.type = 'button';
    toggle.appendChild(bBefore);
    toggle.appendChild(bAfter);
    bar.appendChild(toggle);
    root.appendChild(bar);

    var track = el('div', 'reel__track');
    var set = [
      { pair: PAIRS.living, label: 'Living Room', fake: false },
      { pair: PAIRS.bedroom, label: 'Primary Bedroom', fake: false },
      { pair: PAIRS.dining, label: 'Dining Room', fake: false },
      { pair: PAIRS.bedroom, label: 'Bedroom 2', fake: true, filter: STYLES[3].filter },
      { pair: PAIRS.living, label: 'Office', fake: true, filter: STYLES[2].filter },
      { pair: PAIRS.exterior, label: 'Exterior', fake: false }
    ];
    var frames = set.map(function (item) {
      var f = el('div', 'reel__frame');
      f.appendChild(img(item.pair.before, item.label + ', before staging'));
      var after = img(item.pair.after, item.label + ', after staging', 'reel__after');
      if (item.filter) after.style.filter = item.filter;
      f.appendChild(after);
      f.appendChild(el('span', 'reel__room', item.label));
      if (item.fake) f.appendChild(standin());
      track.appendChild(f);
      return f;
    });
    root.appendChild(track);

    function setAll(on) {
      frames.forEach(function (f, i) {
        window.setTimeout(function () { f.classList.toggle('is-staged', on); }, i * 110);
      });
      bAfter.classList.toggle('is-active', on);
      bBefore.classList.toggle('is-active', !on);
    }
    bBefore.addEventListener('click', function () { setAll(false); });
    bAfter.addEventListener('click', function () { setAll(true); });

    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        // entries[entries.length - 1], never entries[0]: entry 0 is the OLDEST.
        // Reading entry 0 is what silently latched the #learn prototype's autoplay
        // off for good when a scroll left and re-entered inside one callback.
        var last = entries[entries.length - 1];
        if (last.isIntersecting) {
          setAll(true);
          io.disconnect();
        }
      }, { threshold: 0.3 });
      io.observe(track);
    } else {
      setAll(true);
    }
  }

  /* ------------------------------------------------------------- 6. live */

  function renderLive(root) {
    root.appendChild(sectionHead(
      'Upload a photo. Get it back staged.',
      'No crew, no truck, no scheduling. The whole job is one upload and one download.',
      false,
      COPY.eyebrow
    ));

    var wrap = el('div', 'live');
    var frame = el('div', 'live__frame');
    frame.appendChild(img(PAIRS.bedroom.before, 'Empty bedroom before virtual staging'));
    frame.appendChild(img(PAIRS.bedroom.after, 'Bedroom after virtual staging', 'live__after'));
    var scan = el('div', 'live__scan');
    frame.appendChild(scan);
    var clock = el('div', 'live__clock', '0.0s');
    frame.appendChild(clock);
    wrap.appendChild(frame);

    var side = el('aside', 'live__side glass');
    side.appendChild(el('div', 'studio-side__kicker', 'How it runs'));
    var steps = el('ul', 'steps');
    ['Upload the photo', 'Read the room', 'Furnish it', 'Download'].forEach(function (s) {
      steps.appendChild(el('li', null, s));
    });
    side.appendChild(steps);
    side.appendChild(el(
      'p',
      'studio-side__body',
      'Most photos finish in about eight seconds. A render with several variations, or one the AI retries for a better result, takes longer.'
    ));
    var replay = el('button', 'btn-primary', 'Replay');
    replay.type = 'button';
    side.appendChild(replay);
    wrap.appendChild(side);
    root.appendChild(wrap);

    var lis = steps.querySelectorAll('li');
    var DURATION = 8000;
    var start = null;
    var raf = 0;
    var holdTimer = 0;

    function reset() {
      wrap.classList.remove('is-done', 'is-scanning');
      Array.prototype.forEach.call(lis, function (li) { li.classList.remove('is-on'); });
      clock.textContent = '0.0s';
      scan.style.top = '-34%';
    }

    function tick(ts) {
      if (start === null) start = ts;
      var t = ts - start;
      var pct = Math.min(1, t / DURATION);
      clock.textContent = (Math.min(t, DURATION) / 1000).toFixed(1) + 's';

      var step = t < 700 ? 0 : t < 3400 ? 1 : t < 7000 ? 2 : 3;
      Array.prototype.forEach.call(lis, function (li, i) {
        li.classList.toggle('is-on', i <= step);
      });
      wrap.classList.toggle('is-scanning', step === 1);
      if (step === 1) {
        var p = (t - 700) / 2700;
        scan.style.top = (-34 + p * 134) + '%';
      }
      wrap.classList.toggle('is-done', step >= 3);

      if (pct < 1) {
        raf = window.requestAnimationFrame(tick);
      } else {
        // Hold the finished state, then loop.
        raf = 0;
        holdTimer = window.setTimeout(function () {
          holdTimer = 0;
          reset();
          start = null;
          raf = window.requestAnimationFrame(tick);
        }, 2600);
      }
    }

    // Clearing holdTimer matters: the loop parks in a 2.6s setTimeout between runs,
    // and replaying during that window would leave the old timer to start a SECOND
    // rAF loop on top of this one. Both would then drive the same clock.
    function play() {
      if (raf) window.cancelAnimationFrame(raf);
      if (holdTimer) window.clearTimeout(holdTimer);
      raf = 0;
      holdTimer = 0;
      reset();
      start = null;
      raf = window.requestAnimationFrame(tick);
    }
    replay.addEventListener('click', play);

    reset();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      wrap.classList.add('is-done');
      clock.textContent = '8.0s';
      Array.prototype.forEach.call(lis, function (li) { li.classList.add('is-on'); });
      return;
    }
    // NOTE: a background tab throttles rAF to ~1fps or freezes it outright, so this
    // looks stuck if you check it from a hidden tab. Foreground the window.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        var last = entries[entries.length - 1];
        // !holdTimer too: raf is now 0 while the loop parks between runs, so
        // testing raf alone would let a re-entry start a duplicate loop.
        if (last.isIntersecting && !raf && !holdTimer) raf = window.requestAnimationFrame(tick);
      }, { threshold: 0.35 });
      io.observe(wrap);
    } else {
      raf = window.requestAnimationFrame(tick);
    }
  }

  /* ------------------------------------------------------------ 7. wipe2 */

  function renderWipe2(root) {
    root.appendChild(sectionHead(
      'Drag to see what staging does',
      'The same empty bedroom on the left, your chosen style on the right. Switch the style and drag again.',
      true,
      COPY.eyebrow
    ));

    var wrap = el('div', 'wipe2');
    var ba = buildBa(
      PAIRS.bedroom.before,
      PAIRS.bedroom.after,
      'Empty bedroom before virtual staging',
      'Bedroom after AI virtual staging with Stagify.ai'
    );
    ba.appendChild(standin());
    wrap.appendChild(ba);

    var after = ba.querySelector('.ba-after');
    var rail = el('div', 'rail');
    var chips = STYLES.map(function (s, i) {
      var c = el('button', 'rail__chip' + (i === 0 ? ' is-active' : ''), s.label);
      c.type = 'button';
      c.addEventListener('click', function () {
        chips.forEach(function (o, j) { o.classList.toggle('is-active', j === i); });
        after.style.filter = s.filter;
      });
      rail.appendChild(c);
      return c;
    });
    wrap.appendChild(rail);
    wrap.appendChild(el(
      'p',
      'wipe2__note',
      'Same widget as today. The three room buttons became seven style buttons, so the drag compares empty against the look you picked.'
    ));
    root.appendChild(wrap);
    mountWipe(ba);
  }

  /* ------------------------------------------------------------ bootstrap */

  var RENDERERS = {
    today: renderToday,
    board: renderBoard,
    mosaic: renderMosaic,
    rail: renderRail,
    deck: renderDeck,
    reel: renderReel,
    live: renderLive,
    wipe2: renderWipe2
  };

  var demos = [];
  Array.prototype.forEach.call(document.querySelectorAll('[data-concept]'), function (node) {
    var key = node.getAttribute('data-concept');
    var fn = RENDERERS[key];
    if (!fn) return;
    fn(node);
    demos.push({ key: key, node: node });
  });

  /* Height badges. Measured against concept 0, so the scroll cost of each
     direction is a number rather than a guess. */
  function measure() {
    var base = 0;
    demos.forEach(function (d) {
      d.h = Math.round(d.node.getBoundingClientRect().height);
      if (d.key === 'today') base = d.h;
    });
    demos.forEach(function (d) {
      var badge = document.querySelector('[data-h="' + d.key + '"]');
      if (!badge) return;
      if (d.key === 'today') {
        badge.textContent = 'Section height: ' + d.h + 'px · the baseline';
        return;
      }
      var delta = base ? Math.round((1 - d.h / base) * 100) : 0;
      badge.classList.remove('badge--save', 'badge--cost');
      if (delta > 0) {
        badge.classList.add('badge--save');
        badge.textContent = 'Section height: ' + d.h + 'px · ' + delta + '% shorter than today';
      } else if (delta < 0) {
        badge.classList.add('badge--cost');
        badge.textContent = 'Section height: ' + d.h + 'px · ' + Math.abs(delta) + '% taller than today';
      } else {
        badge.textContent = 'Section height: ' + d.h + 'px · same as today';
      }
    });
  }

  window.addEventListener('load', measure);
  measure();
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function () { measure(); });
    demos.forEach(function (d) { ro.observe(d.node); });
  } else {
    window.addEventListener('resize', measure);
  }
})();
