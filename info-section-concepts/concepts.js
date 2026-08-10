/* Prototype page for the #learn section redesign. Throwaway — not part of the app.
   Classic script on purpose: this folder lives outside public/, so the page is opened
   over file://, where <script type="module"> is blocked by CORS.

   Every concept renders from the SAME copy array below. That is deliberate: the height
   badges only mean anything if each layout is holding identical text. */
(function () {
  'use strict';

  /* The real strings from public/index.html, so the wrapping and the height badges
     reflect content that actually has to fit. Only the photos are placeholders. */
  var COPY = [
    {
      short: 'Why it works',
      eyebrow: 'Why it works',
      title: 'Buyers shop with their eyes first',
      body: 'Almost every buyer starts online, so your listing photos are the real first showing. Empty or dated rooms are hard to read; people can’t judge scale or picture living there. Staging gives each room a clear purpose and a pull, which is why agents have always relied on it.',
      points: [
        'Empty rooms photograph smaller and colder than they are',
        'Staging shows the intended use of every space',
        'Stronger photos earn more clicks, saves, and showings'
      ],
      caption: 'Demoing Stagify at a Compass office in New York',
      img: 'assets/photo-1.svg',
      alt: 'Placeholder standing in for the Compass office demo photo'
    },
    {
      short: 'How it works',
      eyebrow: 'How it works',
      title: 'From empty photo to listing-ready in ~8 seconds',
      body: 'Upload a photo, pick the room type and one of seven styles, and Stagify furnishes it in about eight seconds. Want changes? Remove the existing furniture, add a custom prompt, or mask one area to adjust it without starting over.',
      points: [
        '7 styles plus custom prompts and furniture removal',
        'Mask-edit any part of a result without redoing it',
        'Full copyright, yours to use on the MLS or in ads'
      ],
      caption: 'Walking a room of agents through their first staged listing',
      img: 'assets/photo-2.svg',
      alt: 'Placeholder standing in for the agent presentation photo'
    },
    {
      short: 'Who it’s for',
      eyebrow: 'Who it’s for',
      title: 'Made for agents, sellers, and buyers',
      body: 'Agents market every listing in minutes instead of waiting on a staging crew. Sellers stage their own photos without hiring anyone. Buyers preview a renovation before they commit. And with AI Designer, you can turn CAD floor-plan PDFs into photorealistic 3D room renders.',
      points: [
        'Agents: list sooner and close more',
        'Sellers & buyers: no software, no designer needed',
        'AI Designer: agentic room staging'
      ],
      caption: 'Sitting down one-on-one to stage an agent’s photos',
      img: 'assets/photo-3.svg',
      alt: 'Placeholder standing in for the one-on-one staging photo'
    },
    {
      short: 'For teams',
      eyebrow: 'Built for teams',
      title: 'Easy enough for your whole office',
      body: 'There’s no software to install and nothing to learn. Anyone on the team can open Stagify in a browser, upload a listing photo, and have it staged in seconds, whether on a laptop at the office or a phone in the field.',
      points: [
        'No design skills or software needed',
        'Works in any browser, on any device',
        'Every agent can stage their own listings'
      ],
      caption: 'Training a brokerage team on Stagify',
      img: 'assets/photo-4.svg',
      alt: 'Placeholder standing in for the brokerage training photo'
    }
  ];

  var CHEVRON =
    '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pointsHtml(points) {
    return '<ul class="home-list">' + points.map(function (p) {
      return '<li>' + esc(p) + '</li>';
    }).join('') + '</ul>';
  }

  function figureHtml(item, cls) {
    return '<figure class="' + cls + '">' +
      '<img src="' + item.img + '" alt="' + esc(item.alt) + '" loading="lazy" decoding="async">' +
      '<figcaption>' + esc(item.caption) + '</figcaption>' +
      '</figure>';
  }

  /* The section heading every concept shares, so each demo reads like the real page. */
  function headHtml() {
    return '<div class="home-section__head">' +
      '<h2 class="home-section__title">What virtual staging is, and why it sells</h2>' +
      '<p class="home-section__sub">A quick, honest rundown of how it works and who it’s for. No jargon.</p>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ 0. today */

  function renderBaseline(mount) {
    var rows = COPY.map(function (item, i) {
      return '<div class="info-row' + (i % 2 ? ' info-row--flip' : '') + '">' +
        figureHtml(item, 'info-row__media') +
        '<div class="info-row__text">' +
          '<span class="info-row__eyebrow">' + esc(item.eyebrow) + '</span>' +
          '<h3 class="info-row__title">' + esc(item.title) + '</h3>' +
          '<p class="info-row__body">' + esc(item.body) + '</p>' +
          pointsHtml(item.points) +
        '</div>' +
      '</div>';
    }).join('');
    mount.innerHTML = headHtml() + '<div class="info-rows">' + rows + '</div>';
  }

  /* ------------------------------------------- 1. accordion + persistent media */

  function renderAccordion(mount) {
    var items = COPY.map(function (item, i) {
      var open = i === 0;
      return '<div class="acc__item' + (open ? ' is-open' : '') + '" data-i="' + i + '">' +
        '<h3 class="acc__h">' +
          '<button type="button" class="acc__btn" aria-expanded="' + open + '" aria-controls="acc-p' + i + '" id="acc-b' + i + '">' +
            '<span class="acc__labels">' +
              '<span class="acc__eyebrow">' + esc(item.eyebrow) + '</span>' +
              '<span class="acc__title">' + esc(item.title) + '</span>' +
            '</span>' + CHEVRON +
          '</button>' +
        '</h3>' +
        '<div class="acc__panel" id="acc-p' + i + '" role="region" aria-labelledby="acc-b' + i + '">' +
          '<div class="acc__panel-in">' +
            '<p class="acc__body">' + esc(item.body) + '</p>' + pointsHtml(item.points) +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    var figs = COPY.map(function (item, i) {
      return figureHtml(item, 'acc__fig' + (i === 0 ? ' is-active' : ''));
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="acc">' +
        '<div class="acc__list">' + items + '</div>' +
        '<div class="acc__media">' + figs + '</div>' +
      '</div>';

    var root = mount.querySelector('.acc');
    var itemEls = [].slice.call(root.querySelectorAll('.acc__item'));
    var figEls = [].slice.call(root.querySelectorAll('.acc__fig'));

    function open(n) {
      itemEls.forEach(function (el, i) {
        var on = i === n;
        el.classList.toggle('is-open', on);
        el.querySelector('.acc__btn').setAttribute('aria-expanded', String(on));
      });
      figEls.forEach(function (f, i) { f.classList.toggle('is-active', i === n); });
    }

    itemEls.forEach(function (el, i) {
      el.querySelector('.acc__btn').addEventListener('click', function () {
        /* Always-one-open, like a tablist. Letting the last one close leaves the media
           pane showing a photo with no matching copy beside it. */
        if (!el.classList.contains('is-open')) open(i);
      });
      /* Hovering a closed row previews its photo — cheap, and it makes the pairing
         between the list and the pane obvious before you click anything. */
      el.addEventListener('mouseenter', function () {
        figEls.forEach(function (f, j) { f.classList.toggle('is-peek', j === i && !el.classList.contains('is-open')); });
      });
      el.addEventListener('mouseleave', function () {
        figEls.forEach(function (f) { f.classList.remove('is-peek'); });
      });
    });
  }

  /* -------------------------------------------------------- 2. segmented tabs */

  function renderTabs(mount) {
    var tabs = COPY.map(function (item, i) {
      return '<button type="button" role="tab" class="segt__tab' + (i === 0 ? ' is-active' : '') + '"' +
        ' aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? '0' : '-1') + '"' +
        ' aria-controls="segp' + i + '" id="segt' + i + '">' + esc(item.short) + '</button>';
    }).join('');

    var panels = COPY.map(function (item, i) {
      return '<div class="segt__panel' + (i === 0 ? ' is-active' : '') + '" id="segp' + i + '" role="tabpanel" aria-labelledby="segt' + i + '"' + (i === 0 ? '' : ' hidden') + '>' +
        figureHtml(item, 'segt__media') +
        '<div class="segt__text">' +
          '<span class="info-row__eyebrow">' + esc(item.eyebrow) + '</span>' +
          '<h3 class="info-row__title">' + esc(item.title) + '</h3>' +
          '<p class="info-row__body">' + esc(item.body) + '</p>' +
          pointsHtml(item.points) +
        '</div>' +
      '</div>';
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="segt">' +
        '<div class="segt__tabs" role="tablist" aria-label="Topics">' + tabs + '</div>' +
        '<div class="segt__stage">' + panels + '</div>' +
      '</div>';

    var root = mount.querySelector('.segt');
    var tabEls = [].slice.call(root.querySelectorAll('.segt__tab'));
    var panelEls = [].slice.call(root.querySelectorAll('.segt__panel'));

    function select(n, focus) {
      var i = (n + tabEls.length) % tabEls.length;
      tabEls.forEach(function (t, j) {
        var on = j === i;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
      panelEls.forEach(function (p, j) {
        var on = j === i;
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
      if (focus) tabEls[i].focus();
    }

    tabEls.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
    });
    root.querySelector('.segt__tabs').addEventListener('keydown', function (e) {
      var cur = tabEls.indexOf(document.activeElement);
      if (cur < 0) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); select(cur + 1, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); select(cur - 1, true); }
      else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
      else if (e.key === 'End') { e.preventDefault(); select(tabEls.length - 1, true); }
    });
  }

  /* --------------------------------------------------- 3. native <details> */

  function renderDetails(mount) {
    var rows = COPY.map(function (item, i) {
      return '<details class="det"' + (i === 0 ? ' open' : '') + ' name="learn-concept">' +
        '<summary class="det__sum">' +
          '<span class="det__labels">' +
            '<span class="det__eyebrow">' + esc(item.eyebrow) + '</span>' +
            '<span class="det__title">' + esc(item.title) + '</span>' +
          '</span>' + CHEVRON +
        '</summary>' +
        '<div class="det__body">' +
          figureHtml(item, 'det__media') +
          '<div class="det__text">' +
            '<p class="info-row__body">' + esc(item.body) + '</p>' + pointsHtml(item.points) +
          '</div>' +
        '</div>' +
      '</details>';
    }).join('');
    mount.innerHTML = headHtml() + '<div class="dets">' + rows + '</div>';

    /* No exclusive-open wiring here on purpose: `name=` on <details> does it natively
       in current Chrome, Safari and Firefox. Older browsers just allow several open
       at once, which is a fine degradation. This listener only re-measures. */
    mount.addEventListener('toggle', function () { window.dispatchEvent(new Event('resize')); }, true);
  }

  /* ---------------------------------------------------- 4. expanding grid */

  function renderGrid(mount) {
    var cards = COPY.map(function (item, i) {
      var open = i === 0;
      return '<article class="xcard' + (open ? ' is-open' : '') + '" data-i="' + i + '">' +
        figureHtml(item, 'xcard__media') +
        '<div class="xcard__text">' +
          '<h3 class="xcard__h">' +
            '<button type="button" class="xcard__btn" aria-expanded="' + open + '" aria-controls="xp' + i + '">' +
              '<span class="xcard__eyebrow">' + esc(item.eyebrow) + '</span>' +
              '<span class="xcard__title">' + esc(item.title) + '</span>' +
            '</button>' +
          '</h3>' +
          '<div class="xcard__panel" id="xp' + i + '">' +
            '<div class="xcard__panel-in">' +
              '<p class="info-row__body">' + esc(item.body) + '</p>' + pointsHtml(item.points) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
    mount.innerHTML = headHtml() + '<div class="xgrid">' + cards + '</div>';

    var cardEls = [].slice.call(mount.querySelectorAll('.xcard'));
    cardEls.forEach(function (card, i) {
      card.querySelector('.xcard__btn').addEventListener('click', function () {
        if (card.classList.contains('is-open')) return;
        cardEls.forEach(function (c, j) {
          var on = j === i;
          c.classList.toggle('is-open', on);
          c.querySelector('.xcard__btn').setAttribute('aria-expanded', String(on));
        });
      });
    });
  }

  /* ------------------------------------------- shared exclusive-open wiring */

  /**
   * One-open-at-a-time behaviour, shared by every strip/band/card concept.
   * Returns { open, els } so a caller can drive it (autoplay, deep link, …).
   */
  function wireExclusive(mount, itemSel, btnSel, opts) {
    opts = opts || {};
    var els = [].slice.call(mount.querySelectorAll(itemSel));
    var active = 0;

    function open(n) {
      active = ((n % els.length) + els.length) % els.length;
      els.forEach(function (el, i) {
        var on = i === active;
        el.classList.toggle('is-open', on);
        var btn = el.querySelector(btnSel);
        if (btn) btn.setAttribute('aria-expanded', String(on));
      });
      if (opts.onOpen) opts.onOpen(active);
    }

    els.forEach(function (el, i) {
      var btn = el.querySelector(btnSel);
      if (btn) btn.addEventListener('click', function () { open(i); });
      if (opts.hover) {
        /* Hover-to-open as well as click: on a wide screen that is the whole appeal
           of the pattern. Pointer-fine only, so a tap on a phone is a plain click. */
        el.addEventListener('mouseenter', function () {
          if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) open(i);
        });
      }
    });

    return { open: open, els: els, index: function () { return active; } };
  }

  /* ------------------------------------ 5 / 8 / 9 / 10. image strip family */

  /* One markup path for all four strip variants — they differ only by a modifier
     class on the root, so the CSS carries the difference rather than the JS.
     .strip__card and .strip__prog are always emitted; the base variant just hides
     the progress bar and makes the card a transparent passthrough. */
  function stripsHtml(variant) {
    var strips = COPY.map(function (item, i) {
      var open = i === 0;
      return '<div class="strip' + (open ? ' is-open' : '') + '" data-i="' + i + '">' +
        '<img class="strip__img" src="' + item.img + '" alt="' + esc(item.alt) + '" loading="lazy" decoding="async">' +
        '<div class="strip__scrim"></div>' +
        '<span class="strip__prog" aria-hidden="true"></span>' +
        '<h3 class="strip__h">' +
          '<button type="button" class="strip__btn" aria-expanded="' + open + '">' +
            '<span class="strip__eyebrow">' + esc(item.eyebrow) + '</span>' +
            '<span class="strip__title">' + esc(item.title) + '</span>' +
          '</button>' +
        '</h3>' +
        '<div class="strip__body"><div class="strip__card">' +
          '<p>' + esc(item.body) + '</p>' + pointsHtml(item.points) +
          '<p class="strip__cap">' + esc(item.caption) + '</p>' +
        '</div></div>' +
      '</div>';
    }).join('');
    return '<div class="strips' + (variant ? ' strips--' + variant : '') + '">' + strips + '</div>';
  }

  function renderStrips(mount) {
    mount.innerHTML = headHtml() + stripsHtml('');
    wireExclusive(mount, '.strip', '.strip__btn', { hover: true });
  }

  function renderStripsGlass(mount) {
    mount.innerHTML = headHtml() + stripsHtml('glass');
    wireExclusive(mount, '.strip', '.strip__btn', { hover: true });
  }

  function renderStripsWide(mount) {
    mount.innerHTML = headHtml() + stripsHtml('wide');
    wireExclusive(mount, '.strip', '.strip__btn', { hover: true });
  }

  function renderStripsAuto(mount) {
    mount.innerHTML = headHtml() + stripsHtml('auto');
    var api = wireExclusive(mount, '.strip', '.strip__btn', { hover: true });
    var root = mount.querySelector('.strips');
    var timer = null;
    var paused = false;
    var onScreen = true;

    /* No autoplay under reduced motion — an unrequested 5s content swap is exactly
       what that preference is asking you not to do. Clicking still works. */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.classList.add('is-static');
      return;
    }

    function tick() { api.open(api.index() + 1); }
    function stop() { clearInterval(timer); timer = null; }
    function sync() {
      var run = !paused && onScreen;
      if (run && !timer) timer = setInterval(tick, 5000);
      else if (!run && timer) stop();
      root.classList.toggle('is-paused', !run);
    }

    /* Pause on hover and on keyboard focus — a carousel that advances while you are
       reading it, or while your focus is inside it, is the classic complaint. */
    root.addEventListener('mouseenter', function () { paused = true; sync(); });
    root.addEventListener('mouseleave', function () { paused = false; sync(); });
    root.addEventListener('focusin', function () { paused = true; sync(); });
    root.addEventListener('focusout', function () { paused = false; sync(); });

    /* And stop entirely when scrolled away, so it is not burning frames off-screen.

       entries[entries.length - 1], NOT entries[0]: a callback can carry several
       coalesced changes and entry 0 is the OLDEST. Reading entry 0 latched onScreen
       to `false` on a fast scroll that left and re-entered within one callback, and
       nothing ever fired again to correct it — the carousel simply stopped for good. */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[entries.length - 1].isIntersecting;
        sync();
      }, { threshold: 0.25 }).observe(root);
    }
    sync();
  }

  /* --------------------------------------------------- 7. horizontal bands */

  function renderBands(mount) {
    var bands = COPY.map(function (item, i) {
      var open = i === 0;
      return '<div class="band' + (open ? ' is-open' : '') + '" data-i="' + i + '">' +
        '<img class="band__img" src="' + item.img + '" alt="' + esc(item.alt) + '" loading="lazy" decoding="async">' +
        '<div class="band__scrim"></div>' +
        '<h3 class="band__h">' +
          '<button type="button" class="band__btn" aria-expanded="' + open + '">' +
            '<span class="band__num">' + (i + 1) + '</span>' +
            '<span class="band__labels">' +
              '<span class="band__eyebrow">' + esc(item.eyebrow) + '</span>' +
              '<span class="band__title">' + esc(item.title) + '</span>' +
            '</span>' +
          '</button>' +
        '</h3>' +
        '<div class="band__body"><div class="band__card">' +
          '<p>' + esc(item.body) + '</p>' + pointsHtml(item.points) +
        '</div></div>' +
      '</div>';
    }).join('');
    mount.innerHTML = headHtml() + '<div class="bands">' + bands + '</div>';
    wireExclusive(mount, '.band', '.band__btn', { hover: true });
  }

  /* -------------------------------------------------- 11. hero + filmstrip */

  function renderHero(mount) {
    var figs = COPY.map(function (item, i) {
      return '<figure class="hero__fig' + (i === 0 ? ' is-active' : '') + '">' +
        '<img src="' + item.img + '" alt="' + esc(item.alt) + '" loading="lazy" decoding="async">' +
      '</figure>';
    }).join('');

    var copies = COPY.map(function (item, i) {
      return '<div class="hero__copy' + (i === 0 ? ' is-active' : '') + '">' +
        '<span class="info-row__eyebrow">' + esc(item.eyebrow) + '</span>' +
        '<h3 class="hero__title">' + esc(item.title) + '</h3>' +
        '<p class="hero__body">' + esc(item.body) + '</p>' +
        pointsHtml(item.points) +
      '</div>';
    }).join('');

    var thumbs = COPY.map(function (item, i) {
      return '<button type="button" class="hero__thumb' + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '" aria-pressed="' + (i === 0) + '">' +
        '<img src="' + item.img + '" alt="" loading="lazy" decoding="async">' +
        '<span class="hero__thumb-label">' + esc(item.short) + '</span>' +
      '</button>';
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="hero">' +
        '<div class="hero__stage">' + figs + '<div class="hero__copies">' + copies + '</div></div>' +
        '<div class="hero__thumbs">' + thumbs + '</div>' +
      '</div>';

    var figEls = [].slice.call(mount.querySelectorAll('.hero__fig'));
    var copyEls = [].slice.call(mount.querySelectorAll('.hero__copy'));
    var thumbEls = [].slice.call(mount.querySelectorAll('.hero__thumb'));

    thumbEls.forEach(function (t, i) {
      t.addEventListener('click', function () {
        figEls.forEach(function (f, j) { f.classList.toggle('is-active', j === i); });
        copyEls.forEach(function (c, j) { c.classList.toggle('is-active', j === i); });
        thumbEls.forEach(function (b, j) {
          b.classList.toggle('is-active', j === i);
          b.setAttribute('aria-pressed', String(j === i));
        });
      });
    });
  }

  /* --------------------------------------------------------- 12. mosaic */

  function renderMosaic(mount) {
    /* The feature cell is a single element whose contents swap, rather than four
       stacked cells — the three side tiles are the only things that move. */
    var sides = COPY.map(function (item, i) {
      return '<button type="button" class="mos__tile" data-i="' + i + '">' +
        '<img src="' + item.img + '" alt="" loading="lazy" decoding="async">' +
        '<span class="mos__tile-label">' + esc(item.short) + '</span>' +
      '</button>';
    }).join('');

    var features = COPY.map(function (item, i) {
      return '<div class="mos__feature' + (i === 0 ? ' is-active' : '') + '">' +
        '<img src="' + item.img + '" alt="' + esc(item.alt) + '" loading="lazy" decoding="async">' +
        '<div class="mos__card">' +
          '<span class="info-row__eyebrow">' + esc(item.eyebrow) + '</span>' +
          '<h3 class="mos__title">' + esc(item.title) + '</h3>' +
          '<p class="mos__body">' + esc(item.body) + '</p>' +
          pointsHtml(item.points) +
        '</div>' +
      '</div>';
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="mos">' +
        '<div class="mos__stage">' + features + '</div>' +
        '<div class="mos__side">' + sides + '</div>' +
      '</div>';

    var featureEls = [].slice.call(mount.querySelectorAll('.mos__feature'));
    var tileEls = [].slice.call(mount.querySelectorAll('.mos__tile'));

    function open(n) {
      featureEls.forEach(function (f, j) { f.classList.toggle('is-active', j === n); });
      /* The tile for whatever is already in the feature cell is hidden, so the side
         rail always shows the three you can switch TO. */
      tileEls.forEach(function (t, j) { t.classList.toggle('is-hidden', j === n); });
    }
    tileEls.forEach(function (t, i) { t.addEventListener('click', function () { open(i); }); });
    open(0);
  }

  /* ----------------------------------------------- 13. chips + detail drawer */

  function renderChips(mount) {
    var chips = COPY.map(function (item, i) {
      var open = i === 0;
      return '<h3 class="chip' + (open ? ' is-open' : '') + '" data-i="' + i + '">' +
        '<button type="button" class="chip__btn" aria-expanded="' + open + '">' +
          '<span class="chip__eyebrow">' + esc(item.eyebrow) + '</span>' +
          '<span class="chip__title">' + esc(item.title) + '</span>' +
        '</button>' +
      '</h3>';
    }).join('');

    var panes = COPY.map(function (item, i) {
      return '<div class="chips__pane' + (i === 0 ? ' is-active' : '') + '">' +
        figureHtml(item, 'chips__media') +
        '<div class="chips__text">' +
          '<p class="info-row__body">' + esc(item.body) + '</p>' + pointsHtml(item.points) +
        '</div>' +
      '</div>';
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="chips">' +
        '<div class="chips__row">' + chips + '</div>' +
        '<div class="chips__drawer">' + panes + '</div>' +
      '</div>';

    var paneEls = [].slice.call(mount.querySelectorAll('.chips__pane'));
    wireExclusive(mount, '.chip', '.chip__btn', {
      onOpen: function (n) {
        paneEls.forEach(function (p, j) { p.classList.toggle('is-active', j === n); });
      }
    });
  }

  /* -------------------------------------------------------- 6. snap rail */

  function renderRail(mount) {
    var cards = COPY.map(function (item, i) {
      return '<article class="rail__card" id="rc' + i + '">' +
        figureHtml(item, 'rail__media') +
        '<div class="rail__text">' +
          '<span class="info-row__eyebrow">' + esc(item.eyebrow) + '</span>' +
          '<h3 class="info-row__title">' + esc(item.title) + '</h3>' +
          '<p class="info-row__body">' + esc(item.body) + '</p>' +
          pointsHtml(item.points) +
        '</div>' +
      '</article>';
    }).join('');
    var dots = COPY.map(function (item, i) {
      return '<button type="button" class="rail__dot' + (i === 0 ? ' is-active' : '') + '" data-i="' + i + '">' +
        '<span class="sr-only">' + esc(item.short) + '</span></button>';
    }).join('');

    mount.innerHTML = headHtml() +
      '<div class="rail">' +
        '<div class="rail__track">' + cards + '</div>' +
        '<div class="rail__dots">' + dots + '</div>' +
      '</div>';

    var track = mount.querySelector('.rail__track');
    var cardEls = [].slice.call(track.querySelectorAll('.rail__card'));
    var dotEls = [].slice.call(mount.querySelectorAll('.rail__dot'));

    dotEls.forEach(function (d, i) {
      d.addEventListener('click', function () {
        /* scrollIntoView would walk every scrollable ancestor and yank the whole page.
           Scroll the track itself — the same reason studio-showcase.js uses scrollBy. */
        track.scrollTo({ left: cardEls[i].offsetLeft - cardEls[0].offsetLeft, behavior: 'smooth' });
      });
    });

    /* Which card is centred? Cheap rAF-throttled read on scroll. */
    var ticking = false;
    track.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var mid = track.scrollLeft + track.clientWidth / 2;
        var best = 0;
        var bestD = Infinity;
        cardEls.forEach(function (c, i) {
          var d = Math.abs(c.offsetLeft - cardEls[0].offsetLeft + c.offsetWidth / 2 - mid);
          if (d < bestD) { bestD = d; best = i; }
        });
        dotEls.forEach(function (d, i) { d.classList.toggle('is-active', i === best); });
      });
    }, { passive: true });
  }

  /* ------------------------------------------------------------ mount + measure */

  var RENDERERS = {
    baseline: renderBaseline,
    accordion: renderAccordion,
    tabs: renderTabs,
    details: renderDetails,
    grid: renderGrid,
    strips: renderStrips,
    rail: renderRail,
    bands: renderBands,
    stripsglass: renderStripsGlass,
    stripswide: renderStripsWide,
    stripsauto: renderStripsAuto,
    hero: renderHero,
    mosaic: renderMosaic,
    chips: renderChips
  };

  var mounts = [].slice.call(document.querySelectorAll('.concept__demo'));
  mounts.forEach(function (m) {
    var fn = RENDERERS[m.dataset.concept];
    if (fn) fn(m);
  });

  /* Height badges. The comparison is the point of the page, so it is measured live
     rather than quoted from a guess — open a concept, watch its number move. */
  var baselineH = 0;

  function measure() {
    var demos = mounts.map(function (m) {
      return { key: m.dataset.concept, h: Math.round(m.getBoundingClientRect().height) };
    });
    var base = demos.filter(function (d) { return d.key === 'baseline'; })[0];
    baselineH = base ? base.h : 0;
    demos.forEach(function (d) {
      var badge = document.querySelector('[data-cost="' + d.key + '"]');
      if (!badge) return;
      if (d.key === 'baseline') {
        badge.textContent = 'Section height: ' + d.h + 'px  ·  the baseline';
        badge.className = 'concept__cost';
        return;
      }
      var pct = baselineH ? Math.round((1 - d.h / baselineH) * 100) : 0;
      badge.textContent = 'Section height: ' + d.h + 'px  ·  ' +
        (pct > 0 ? pct + '% less scroll than today' : Math.abs(pct) + '% MORE scroll than today');
      badge.className = 'concept__cost' + (pct > 0 ? ' is-good' : ' is-bad');
    });
  }

  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);
  if ('ResizeObserver' in window) {
    /* Opening a panel changes a height mid-transition; observing the demos keeps the
       badge honest instead of showing a stale number. */
    var ro = new ResizeObserver(function () { measure(); });
    mounts.forEach(function (m) { ro.observe(m); });
  }
})();
