/* Prototype page for the #testimonials section redesign. Throwaway — not part of
   the app. Classic script on purpose: this folder lives outside public/, so the page
   is opened over file://, where <script type="module"> is blocked by CORS.

   Every concept renders from the one COPY array below. That is deliberate — the real
   sentence lengths are what decide whether a layout works, and identical text across
   all eight is what makes the height badges a fair comparison. */
(function () {
  'use strict';

  /* The real star path from public/index.html:1106, so the row is pixel-honest. */
  var STAR = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

  /* ------------------------------------------------------------------------
     Six FICTIONAL testimonials. Invented people at invented brokerages — none of
     this is a real endorsement and none of it may be shipped. Lengths are matched
     to the two real quotes in english.json (36-41 words) so the layouts below are
     stressed the way the real content will stress them.
     ------------------------------------------------------------------------ */
  var COPY = [
    {
      quote: 'I listed a vacant townhouse on a Thursday and had the staged photos up before the weekend open house. Two offers by Sunday. I used to book a stager three weeks out and hope the furniture matched the light.',
      name: 'Dana Whitfield (Broker)',
      firm: 'Harbor & Co Realty',
      loc: 'Portland, OR',
      logo: 'assets/logo-1.svg'
    },
    {
      quote: 'What sold me was the price. Physical staging on a mid-range listing runs four figures before anyone moves a couch. I ran eleven rooms through Stagify last month for less than one weekend of rental furniture.',
      name: 'Marcus Iyer (Listing Agent)',
      firm: 'Vireo Property Group',
      loc: 'Austin, TX',
      logo: 'assets/logo-2.svg'
    },
    {
      quote: 'My clients are the ones who noticed. Sellers see their empty living room come back furnished and suddenly understand what a buyer will picture. It has made the pricing conversation much easier on my side.',
      name: 'Priya Raman (Broker)',
      firm: 'Maple Key Realty',
      loc: 'Toronto, ON',
      logo: 'assets/logo-3.svg'
    },
    {
      quote: 'I shoot everything on my phone between showings. I upload from the car, pick a style, and the render is waiting by the time I’m back at the office. No lighting kit, no scheduling, no waiting on a photographer.',
      name: 'Tom Beckett (Broker)',
      firm: 'Northstone Estates',
      loc: 'Denver, CO',
      logo: 'assets/logo-4.svg'
    },
    {
      quote: 'The style range is what keeps me here. A downtown loft and a suburban colonial shouldn’t be staged the same way, and I can match the furniture to the buyer I’m actually trying to reach.',
      name: 'Sofia Marchetti (Agent)',
      firm: 'Alder Lane Properties',
      loc: 'Miami, FL',
      logo: 'assets/logo-5.svg'
    },
    {
      quote: 'I was sceptical that AI staging would look convincing enough for an MLS listing. It does. I still disclose it on every photo, which takes one click, and not one buyer has been surprised at the showing.',
      name: 'Yuki Tanaka (Broker)',
      firm: 'Quarry Bay Realty',
      loc: 'Seattle, WA',
      logo: 'assets/logo-6.svg'
    }
  ];

  var HEAD_TITLE = 'What agents are saying';
  var HEAD_SUB = 'Straight from brokers who made the switch.';

  /* STAND-IN media for concept 6: only three real before/after pairs exist in
     public/media-webp/Homepage/BeforeAfter/, so the After renders are cycled twice
     across the six quotes. Enough to judge the layout, not the photography. */
  var SHOTS = [
    '../public/media-webp/Homepage/BeforeAfter/After1.webp',
    '../public/media-webp/Homepage/BeforeAfter/After2.webp',
    '../public/media-webp/Homepage/BeforeAfter/After3.webp'
  ];

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
     Tiny helpers
     ------------------------------------------------------------------------ */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function starsHTML(cls) {
    var svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR + '"/></svg>';
    return '<div class="' + (cls || 'stars') + '" role="img" aria-label="Rated 5 out of 5 stars">' +
      new Array(6).join(svg) + '</div>';
  }

  function logoHTML(t, cls) {
    return '<img class="' + cls + '" src="' + esc(t.logo) + '" alt="' + esc(t.firm) +
      ' logo" width="72" height="72" decoding="async">';
  }

  /* The shared card used by concepts 1, 3, 4, 5 and 6. */
  function cardHTML(t, extraClass) {
    return '<figure class="tq ' + (extraClass || '') + '">' +
      starsHTML() +
      '<blockquote class="tq__text">' + esc(t.quote) + '</blockquote>' +
      '<figcaption class="tq__by">' +
        '<span class="tq__meta">' +
          '<span class="tq__name">' + esc(t.name) + '</span>' +
          '<span class="tq__firm">' + esc(t.firm) + '</span>' +
          '<span class="tq__loc">' + esc(t.loc) + '</span>' +
        '</span>' +
        logoHTML(t, 'tq__logo') +
      '</figcaption>' +
    '</figure>';
  }

  function headHTML() {
    return '<div class="hs__head">' +
      '<h2 class="hs__title">' + esc(HEAD_TITLE) + '</h2>' +
      '<p class="hs__sub">' + esc(HEAD_SUB) + '</p>' +
    '</div>';
  }

  /* Plain buttons with aria-current, NOT role="tab". These dots scroll a rail or
     advance a rotator; they do not own tabpanels, and tab semantics without
     aria-controls is a promise to a screen reader that nothing keeps. Concept 2's
     chips are a real tablist and are built separately. */
  function dotsHTML(n, label) {
    var out = '<div class="dots" role="group" aria-label="' + esc(label) + '">';
    for (var i = 0; i < n; i++) {
      out += '<button class="dot" type="button" data-i="' + i +
        '" aria-current="' + (i === 0) + '" aria-label="Testimonial ' + (i + 1) +
        ' of ' + n + '"></button>';
    }
    return out + '</div>';
  }

  var ARROW_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';
  var ARROW_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 5 16 12 9 19"/></svg>';

  function arrowsHTML(n, label) {
    return '<button class="narw" type="button" data-prev aria-label="Previous">' + ARROW_L + '</button>' +
      dotsHTML(n, label) +
      '<button class="narw" type="button" data-next aria-label="Next">' + ARROW_R + '</button>';
  }

  function syncDots(root, active) {
    var dots = root.querySelectorAll('.dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].setAttribute('aria-current', String(i === active));
    }
  }

  /* ======================================================================
     0. Today — the shipped .tw-* markup, with all six quotes poured in.
     ====================================================================== */

  function buildToday(root) {
    var html = headHTML() + '<div class="tw-grid">';
    COPY.forEach(function (t, i) {
      html += '<figure class="tw-card">' +
        starsHTML('tw-stars') +
        '<blockquote class="tw-text">' + esc(t.quote) + '</blockquote>' +
        '<figcaption class="tw-by">' +
          '<span class="tw-by__meta">' +
            '<span class="tw-name">' + esc(t.name) + '</span>' +
            '<span class="tw-org">' + esc(t.firm) + '</span>' +
            '<span class="tw-loc">' + esc(t.loc) + '</span>' +
          '</span>' +
          logoHTML(t, 'tw-logo') +
        '</figcaption>' +
      '</figure>';
    });
    root.innerHTML = html + '</div>';

    /* The shipped cursor spotlight, copied from index-inline.js:44-64, so concept 0
       behaves like the real thing on hover as well as looking like it. */
    if (!window.matchMedia || !matchMedia('(hover: hover)').matches) return;
    root.querySelectorAll('.tw-card').forEach(function (card) {
      var queued = false, lx = 0, ly = 0;
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        lx = e.clientX - r.left; ly = e.clientY - r.top;
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () {
          queued = false;
          card.style.setProperty('--mx', lx + 'px');
          card.style.setProperty('--my', ly + 'px');
        });
      });
    });
  }

  /* ======================================================================
     1. Snap rail
     ====================================================================== */

  function buildRail(root) {
    var html = headHTML() +
      '<div class="t1__trk" tabindex="0" role="group" aria-label="Agent testimonials, scrollable">';
    COPY.forEach(function (t) { html += cardHTML(t); });
    html += '</div><div class="ctl">' + arrowsHTML(COPY.length, 'Choose a testimonial') + '</div>';
    root.innerHTML = html;

    var trk = root.querySelector('.t1__trk');
    var cards = trk.children;
    var prev = root.querySelector('[data-prev]');
    var next = root.querySelector('[data-next]');

    /* Card position INSIDE the scroller. Deliberately not offsetLeft: offsetLeft is
       measured from the offsetParent, and nothing between a card and <body> is
       positioned, so it returns a page coordinate. Feeding that to scrollTo() moved
       the rail to a wild offset (in practice: clamped to 0, so the dots and arrows
       silently did nothing). Rect deltas are independent of the offsetParent chain. */
    function cardOffset(i) {
      return cards[i].getBoundingClientRect().left -
        trk.getBoundingClientRect().left + trk.scrollLeft;
    }

    function activeIndex() {
      /* Nearest card to the left edge — reading scrollLeft alone breaks the moment
         the basis changes between desktop and phone. */
      var best = 0, bestGap = Infinity;
      for (var i = 0; i < cards.length; i++) {
        var gap = Math.abs(cardOffset(i) - trk.scrollLeft);
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      return best;
    }

    function goTo(i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      trk.scrollTo({ left: cardOffset(i), behavior: REDUCED ? 'auto' : 'smooth' });
    }

    var raf = false;
    trk.addEventListener('scroll', function () {
      if (raf) return;
      raf = true;
      requestAnimationFrame(function () {
        raf = false;
        var i = activeIndex();
        syncDots(root, i);
        prev.disabled = trk.scrollLeft <= 1;
        next.disabled = trk.scrollLeft >= trk.scrollWidth - trk.clientWidth - 1;
      });
    });

    prev.addEventListener('click', function () { goTo(activeIndex() - 1); });
    next.addEventListener('click', function () { goTo(activeIndex() + 1); });
    root.querySelectorAll('.dot').forEach(function (d) {
      d.addEventListener('click', function () { goTo(Number(d.dataset.i)); });
    });
    trk.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(activeIndex() + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(activeIndex() - 1); }
    });
    /* Both, not just prev — `next` is only ever assigned inside the scroll handler,
       so before the first scroll it would keep whatever the markup left it with. */
    prev.disabled = true;
    next.disabled = false;
  }

  /* ======================================================================
     2. Featured + roster
     ====================================================================== */

  function buildFeature(root) {
    var html = headHTML() + '<div class="t2__stage">';
    COPY.forEach(function (t, i) {
      html += '<div class="t2__slide' + (i === 0 ? ' is-on' : '') + '" id="t2-p' + i + '"' +
        ' role="tabpanel" aria-labelledby="t2-t' + i + '"' + (i === 0 ? '' : ' inert') + '>' +
        '<figure class="tq">' +
          starsHTML() +
          '<blockquote class="tq__text">' + esc(t.quote) + '</blockquote>' +
          '<figcaption class="tq__by">' +
            '<span class="tq__meta">' +
              '<span class="tq__name">' + esc(t.name) + '</span>' +
              '<span class="tq__firm">' + esc(t.firm) + '</span>' +
              '<span class="tq__loc">' + esc(t.loc) + '</span>' +
            '</span>' +
          '</figcaption>' +
        '</figure>' +
      '</div>';
    });
    html += '</div><div class="t2__roster" role="tablist" aria-label="Choose a testimonial">';
    COPY.forEach(function (t, i) {
      html += '<button class="t2__chip" type="button" role="tab" id="t2-t' + i + '"' +
        ' aria-controls="t2-p' + i + '" aria-selected="' + (i === 0) + '"' +
        ' tabindex="' + (i === 0 ? '0' : '-1') + '">' +
        '<img src="' + esc(t.logo) + '" alt="' + esc(t.firm) + '" width="72" height="72">' +
      '</button>';
    });
    root.innerHTML = html + '</div>';

    var slides = root.querySelectorAll('.t2__slide');
    var chips = root.querySelectorAll('.t2__chip');
    var at = 0;

    function show(i, focus) {
      at = (i + slides.length) % slides.length;
      slides.forEach(function (s, k) {
        s.classList.toggle('is-on', k === at);
        if (k === at) s.removeAttribute('inert'); else s.setAttribute('inert', '');
      });
      chips.forEach(function (c, k) {
        c.setAttribute('aria-selected', String(k === at));
        c.tabIndex = k === at ? 0 : -1;
      });
      if (focus) chips[at].focus();
    }

    chips.forEach(function (c, i) {
      c.addEventListener('click', function () { show(i); });
      c.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1, true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1, true); }
        if (e.key === 'Home') { e.preventDefault(); show(0, true); }
        if (e.key === 'End') { e.preventDefault(); show(slides.length - 1, true); }
      });
    });
  }

  /* ======================================================================
     3. Wall of six
     ====================================================================== */

  function buildWall(root) {
    var html = headHTML() + '<div class="t3">';
    COPY.forEach(function (t) { html += cardHTML(t); });
    root.innerHTML = html + '</div>';
  }

  /* ======================================================================
     4. Counter-marquee
     ====================================================================== */

  function buildMarquee(root) {
    function row(items, rev) {
      var set = '';
      items.forEach(function (t) { set += cardHTML(t); });
      /* The set appears twice so translateX(-50%) lands exactly on the seam. The
         second copy is aria-hidden — otherwise every quote is announced twice. */
      return '<div class="t4__row' + (rev ? ' t4__row--rev' : '') + '">' +
        '<div class="t4__trk">' + set +
          '<div class="t4__dup" aria-hidden="true" style="display:contents">' + set + '</div>' +
        '</div></div>';
    }
    root.innerHTML = headHTML() +
      row(COPY.slice(0, 3), false) +
      row(COPY.slice(3, 6), true);
  }

  /* ======================================================================
     5. Swipe deck
     ====================================================================== */

  function buildDeck(root) {
    var html = headHTML() + '<div class="t5"><div class="t5__stack">';
    COPY.forEach(function (t) { html += cardHTML(t, 't5__card'); });
    html += '</div>' +
      '<p class="t5__hint">Drag the top card away, or use the arrows.</p>' +
      '<div class="ctl">' +
        '<button class="narw" type="button" data-prev aria-label="Previous">' + ARROW_L + '</button>' +
        '<span class="t5__count" aria-live="polite">1 / ' + COPY.length + '</span>' +
        '<button class="narw" type="button" data-next aria-label="Next">' + ARROW_R + '</button>' +
      '</div></div>';
    root.innerHTML = html;

    var cards = Array.prototype.slice.call(root.querySelectorAll('.t5__card'));
    var count = root.querySelector('.t5__count');
    var order = cards.map(function (_, i) { return i; });

    function paint() {
      order.forEach(function (cardIdx, pos) {
        var c = cards[cardIdx];
        c.style.setProperty('--i', pos);
        c.dataset.i = pos;
        if (pos === 0) c.dataset.top = '1'; else delete c.dataset.top;
        /* inert, not aria-hidden: the buried cards are still partly visible, and
           aria-hidden on visible content is a violation. inert at least keeps them
           out of the tab order honestly. Neither is great — see the README. */
        if (pos === 0) c.removeAttribute('inert'); else c.setAttribute('inert', '');
      });
      count.textContent = (order[0] + 1) + ' / ' + cards.length;
    }

    function next() { order.push(order.shift()); paint(); }
    function prev() { order.unshift(order.pop()); paint(); }

    root.querySelector('[data-next]').addEventListener('click', next);
    root.querySelector('[data-prev]').addEventListener('click', prev);

    /* Drag. Only the card at position 0 has pointer-events (see concepts.css). */
    var drag = null;
    cards.forEach(function (c) {
      c.addEventListener('pointerdown', function (e) {
        if (c.dataset.top !== '1') return;
        drag = { x: e.clientX, card: c };
        c.classList.add('is-dragging');
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', function (e) {
        if (!drag || drag.card !== c) return;
        var dx = e.clientX - drag.x;
        c.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 26) + 'deg)';
      });
      function release(e) {
        if (!drag || drag.card !== c) return;
        var dx = e.clientX - drag.x;
        drag = null;
        c.classList.remove('is-dragging');
        if (Math.abs(dx) > 90) {
          c.classList.add('is-flying');
          c.style.transform = 'translateX(' + (dx > 0 ? 640 : -640) + 'px) rotate(' + (dx > 0 ? 22 : -22) + 'deg)';
          window.setTimeout(function () {
            c.classList.remove('is-flying');
            c.style.transform = '';
            next();
          }, REDUCED ? 0 : 420);
        } else {
          c.style.transform = '';
        }
      }
      c.addEventListener('pointerup', release);
      c.addEventListener('pointercancel', release);
    });

    paint();
  }

  /* ======================================================================
     6. Quote + proof
     ====================================================================== */

  function buildProof(root) {
    var html = headHTML() + '<div class="t6">';
    COPY.forEach(function (t, i) {
      html += '<div class="t6__item">' +
        '<div class="t6__shot">' +
          '<img src="' + SHOTS[i % SHOTS.length] + '" alt="A room ' + esc(t.name.split(' (')[0]) +
            ' staged with Stagify" loading="lazy" decoding="async">' +
          '<span class="t6__standin">STAND-IN</span>' +
        '</div>' +
        cardHTML(t) +
      '</div>';
    });
    root.innerHTML = html + '</div>';
  }

  /* ======================================================================
     7. Editorial + rating band
     ====================================================================== */

  var ROTATE_MS = 6500;

  function buildEditorial(root) {
    var html = headHTML() + '<div class="t7">' +
      '<span class="t7__mark" aria-hidden="true">“</span>' +
      '<div class="t7__stage" aria-live="polite">';
    COPY.forEach(function (t, i) {
      html += '<figure class="t7__slide' + (i === 0 ? ' is-on' : '') + '"' + (i === 0 ? '' : ' inert') + '>' +
        '<blockquote class="t7__q">' + esc(t.quote) + '</blockquote>' +
        '<figcaption class="t7__who">' +
          '<img src="' + esc(t.logo) + '" alt="" width="72" height="72">' +
          '<span class="t7__whotxt">' +
            '<span class="tq__name" style="display:block">' + esc(t.name) + '</span>' +
            '<span class="tq__firm" style="display:block">' + esc(t.firm) + ' · ' + esc(t.loc) + '</span>' +
          '</span>' +
        '</figcaption>' +
      '</figure>';
    });
    html += '</div>' +
      '<div class="t7__bar"><div class="t7__fill"></div></div>' +
      '<div class="ctl">' + arrowsHTML(COPY.length, 'Choose a testimonial') + '</div>' +
      '<div class="t7__band">' +
        '<div class="t7__score">' +
          '<span class="t7__num">5.0</span>' +
          '<div class="t7__scoretxt">' + starsHTML() + '6 verified reviews</div>' +
        '</div>' +
        '<span class="t7__sep" aria-hidden="true"></span>' +
        '<div class="t7__logos">';
    COPY.forEach(function (t) {
      html += '<img src="' + esc(t.logo) + '" alt="' + esc(t.firm) + '" width="72" height="72" loading="lazy">';
    });
    root.innerHTML = html + '</div></div></div>';

    var slides = root.querySelectorAll('.t7__slide');
    var fill = root.querySelector('.t7__fill');
    var at = 0;
    var timer = null;

    function show(i) {
      at = (i + slides.length) % slides.length;
      slides.forEach(function (s, k) {
        s.classList.toggle('is-on', k === at);
        if (k === at) s.removeAttribute('inert'); else s.setAttribute('inert', '');
      });
      syncDots(root, at);
      restartBar();
    }

    function restartBar() {
      if (REDUCED) return;
      fill.classList.remove('is-running');
      void fill.offsetWidth;               /* force a reflow so the animation replays */
      fill.style.setProperty('--dur', ROTATE_MS + 'ms');
      fill.classList.add('is-running');
    }

    function start() {
      if (REDUCED || timer) return;
      timer = window.setInterval(function () { show(at + 1); }, ROTATE_MS);
      restartBar();
    }
    function stop() {
      window.clearInterval(timer);
      timer = null;
      fill.classList.remove('is-running');
    }

    root.querySelector('[data-prev]').addEventListener('click', function () { stop(); show(at - 1); });
    root.querySelector('[data-next]').addEventListener('click', function () { stop(); show(at + 1); });
    root.querySelectorAll('.dot').forEach(function (d) {
      d.addEventListener('click', function () { stop(); show(Number(d.dataset.i)); });
    });

    var t7 = root.querySelector('.t7');
    t7.addEventListener('pointerenter', stop);
    t7.addEventListener('focusin', stop);
    t7.addEventListener('pointerleave', start);

    /* Only run the timer while the section is actually on screen. Read the LAST
       entry, not entries[0] — entries[0] is the OLDEST, so a scroll that leaves and
       re-enters inside one callback would latch this off permanently. */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        if (e.isIntersecting) start(); else stop();
      }, { threshold: 0.25 }).observe(t7);
    } else {
      start();
    }
  }

  /* ======================================================================
     Wire-up, height badges, viewport toggle
     ====================================================================== */

  var BUILDERS = {
    today: buildToday,
    rail: buildRail,
    feature: buildFeature,
    wall: buildWall,
    marquee: buildMarquee,
    deck: buildDeck,
    proof: buildProof,
    editorial: buildEditorial
  };

  Object.keys(BUILDERS).forEach(function (key) {
    var host = document.querySelector('[data-concept="' + key + '"]');
    if (host) BUILDERS[key](host);
  });

  function measure() {
    var base = 0;
    var hosts = {};
    var phone = document.documentElement.classList.contains('vp-phone');
    Object.keys(BUILDERS).forEach(function (key) {
      var host = document.querySelector('[data-concept="' + key + '"]');
      if (!host) return;
      hosts[key] = Math.round(host.getBoundingClientRect().height);
      if (key === 'today') base = hosts[key];
    });

    Object.keys(hosts).forEach(function (key) {
      var badge = document.querySelector('.badge[data-h="' + key + '"]');
      if (!badge) return;
      var h = hosts[key];
      badge.classList.remove('badge--save', 'badge--cost');
      if (key === 'today') {
        /* In phone view the baseline is only rendering ONE of the six quotes, so every
           comparison against it flatters the other seven. Say so on the badge rather
           than letting the number imply a fair fight. */
        badge.textContent = phone
          ? h + 'px · baseline — but showing only 1 of 6 quotes'
          : h + 'px · baseline';
        return;
      }
      var pct = base ? Math.round(((h - base) / base) * 100) : 0;
      if (phone) {
        /* Same reason: against a baseline showing 1 of 6, "% shorter" is noise. */
        badge.textContent = h + 'px · all 6 quotes reachable';
        badge.classList.add('badge--save');
      } else if (pct <= -3) {
        badge.classList.add('badge--save');
        badge.textContent = h + 'px · ' + Math.abs(pct) + '% shorter than today';
      } else if (pct >= 3) {
        badge.classList.add('badge--cost');
        badge.textContent = h + 'px · ' + pct + '% taller than today';
      } else {
        badge.textContent = h + 'px · about the same as today';
      }
    });
  }

  /* Re-measure whenever a demo actually changes size. A double-rAF after the phone
     toggle is NOT enough: @container rules resolve during layout, so the concepts
     restyle a frame or more after the container's width changes, and the badges read
     the old desktop heights. A ResizeObserver waits for the size that really happened,
     and covers the late font swap and concept 6's lazy images for free.
     No feedback loop: measure() only writes to .badge, which is outside .concept__demo. */
  var mt = null;
  function scheduleMeasure() {
    window.clearTimeout(mt);
    mt = window.setTimeout(measure, 120);
  }

  requestAnimationFrame(function () { requestAnimationFrame(measure); });
  window.addEventListener('load', scheduleMeasure);
  window.addEventListener('resize', scheduleMeasure);

  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(scheduleMeasure);
    document.querySelectorAll('.concept__demo').forEach(function (d) { ro.observe(d); });
  }

  /* The viewport toggle. Media queries key off the window, which never changes on
     this page, so .concept__demo is a size container and this just clamps its
     width — see the banner comment at the top of concepts.css. */
  var vp = document.querySelector('[data-vp]');
  if (vp) {
    var label = vp.querySelector('[data-vp-label]');
    vp.addEventListener('click', function () {
      var on = document.documentElement.classList.toggle('vp-phone');
      vp.setAttribute('aria-pressed', String(on));
      label.textContent = on ? 'Phone · 390px' : 'Desktop · 1044px';
      scheduleMeasure();
    });
  }
})();
