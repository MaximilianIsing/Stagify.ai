/* Prototype for the reworked #staging-studio section: one empty room, a pool of staged
   variations, and a button that deals a new one each press.

   Throwaway — not part of the app. Classic script on purpose, because this folder is
   opened over file:// where <script type="module"> is CORS-blocked.

   The three things this file is actually demonstrating:

   1. THE BAG, NOT Math.random(). Picking uniformly at random per press repeats fast —
      with 60 items the chance of a repeat inside the first 8 presses is already ~40%,
      and one repeat reads as "it's broken" rather than "unlucky". So the pool is
      shuffled once and walked in order; when it runs out it reshuffles, with the
      constraint that the new first card is never the current one.

   2. NOTHING IS PREFETCHED. The section loads the empty room and nothing else. Each
      press fetches exactly one image (~45 KB) and only swaps once it has decoded, so
      the visitor never sees a half-painted card. A 60-image pool therefore costs a
      visitor who never presses precisely nothing.

   3. THE BUTTON CHANGES ITS OWN LABEL. First press says "Stage this room"; every press
      after says "Stage it again". That is the whole narrative of the section — the
      product's value is that the second press is free. */
(function () {
  'use strict';

  var POOL_DIR = 'assets/pool/';
  var BEFORE = 'assets/before/1-living-oak.jpg';

  /* Filled from assets/pool/manifest.json at boot. Kept as a manifest rather than a
     hardcoded list so growing the pool later is a data change, not a code change. */
  var POOL = [];

  var els = {};
  var bag = [];
  var current = null;
  var pressed = 0;
  var busy = false;

  /* ------------------------------------------------------------------ the bag */

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function refill() {
    bag = shuffle(POOL);
    // Never let a reshuffle deal the card that is already on screen — that is the one
    // repeat a visitor is guaranteed to notice, because it happens back to back.
    if (current && bag.length > 1 && bag[0].file === current.file) {
      var t = bag[0]; bag[0] = bag[1]; bag[1] = t;
    }
  }

  function draw() {
    if (!bag.length) refill();
    return bag.shift();
  }

  /* --------------------------------------------------------------- the cards */

  function preload(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('failed to load ' + src)); };
      im.src = src;
    });
  }

  /* Deliberately NO style caption on the card.

     Each render is built from a promptMatrix style PLUS a palette/layout/material
     directive, and generatePrompt appends that directive after "Prioritize the following
     above everything else:" — so the directive routinely overrides the style. In practice
     a render tagged 'luxury' can come back with no luxury cues at all, and one tagged
     'coastal' can come back forest green. The style is honest provenance for the manifest
     and a dishonest caption for the card, so it stays in the data and off the screen. */
  function makeCard(item, n) {
    var card = document.createElement('div');
    card.className = 'sd__card';
    var im = document.createElement('img');
    im.src = POOL_DIR + item.file;
    im.alt = 'The same empty living room, staged by Stagify — arrangement ' + n;
    card.appendChild(im);
    return card;
  }

  async function stage() {
    if (busy || !POOL.length) return;
    busy = true;
    els.btn.disabled = true;
    els.stack.classList.add('is-working');

    var item = draw();
    try {
      await preload(POOL_DIR + item.file);
    } catch (e) {
      // A missing pool file must not strand the button in a disabled state.
      busy = false;
      els.btn.disabled = false;
      els.stack.classList.remove('is-working');
      return;
    }

    // Drop any card still mid-exit from an earlier press BEFORE adding another.
    // The exit is a 620ms timer, but once the images are warm a press completes in
    // ~50ms, so presses outrun their own cleanup and the stack grew by one <div>
    // per press — 70 presses left 70 cards in the DOM. Bounding it here keeps the
    // stack at two (one leaving, one arriving) no matter how fast the button is hit.
    var stale = els.stack.querySelectorAll('.sd__card.is-leaving');
    for (var s = 0; s < stale.length; s++) stale[s].remove();

    var card = makeCard(item, pressed + 1);
    // Enter from under the previous card, so the press reads as "dealt", not "swapped".
    card.classList.add('is-entering');
    els.stack.appendChild(card);
    // Force layout before removing the entering class, or the browser coalesces both
    // states into one and no transition runs at all.
    void card.offsetWidth;
    card.classList.remove('is-entering');

    var old = els.current;
    if (old) {
      old.classList.add('is-leaving');
      window.setTimeout(function () { old.remove(); }, 620);
    }
    els.current = card;
    current = item;
    pressed++;

    els.stack.classList.remove('is-working');
    els.root.classList.add('has-staged');
    els.btn.textContent = 'Stage it again';
    els.count.textContent = pressed === 1
      ? 'One of ' + POOL.length + ' looks. Press again for another.'
      : pressed + ' looks so far · ' + POOL.length + ' in the pool';
    els.btn.disabled = false;
    busy = false;
  }

  /* ----------------------------------------------------------------- render */

  function render(root) {
    els.root = root;

    var head = document.createElement('div');
    head.className = 'hs__head';
    head.innerHTML =
      '<p class="hs__eyebrow">Before &amp; after</p>' +
      '<h2 class="hs__title">Press it again. Get a different room.</h2>' +
      '<p class="hs__sub">One empty photo, staged by Stagify. Don\'t like this one? ' +
      'Staging it again costs you a click &mdash; not a rental, a crew, or another three weeks.</p>';
    root.appendChild(head);

    var shell = document.createElement('div');
    shell.className = 'sd';

    var stack = document.createElement('div');
    stack.className = 'sd__stack';
    var base = document.createElement('img');
    base.className = 'sd__base';
    base.src = BEFORE;
    base.alt = 'The empty living room before staging';
    stack.appendChild(base);
    var beforeTag = document.createElement('span');
    beforeTag.className = 'sd__before';
    beforeTag.textContent = 'Before';
    stack.appendChild(beforeTag);
    shell.appendChild(stack);
    els.stack = stack;

    var side = document.createElement('aside');
    side.className = 'sd__side glass';
    side.innerHTML =
      '<div class="studio-side__kicker">Re-stage</div>' +
      '<h3 class="studio-side__title">Every run furnishes it fresh</h3>' +
      '<p class="studio-side__body">Traditional staging gives you one arrangement and a ' +
      'rental agreement. Run it again and the room comes back furnished a different way ' +
      '&mdash; different layout, different palette, different materials.</p>';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary sd__btn';
    btn.textContent = 'Stage this room';
    side.appendChild(btn);
    var count = document.createElement('div');
    count.className = 'sd__count';
    count.textContent = 'The room is empty. Press to furnish it.';
    side.appendChild(count);
    shell.appendChild(side);

    els.btn = btn;
    els.count = count;
    btn.addEventListener('click', stage);

    root.appendChild(shell);
  }

  function boot() {
    var root = document.querySelector('[data-deck]');
    if (!root) return;
    render(root);
    fetch(POOL_DIR + 'manifest.json')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        POOL = list.filter(function (x) { return x && x.file; });
        refill();
        els.count.textContent = 'The room is empty. Press to furnish it — ' +
          POOL.length + ' looks in the pool.';
      })
      .catch(function () {
        els.count.textContent = 'Could not load the pool manifest.';
        els.btn.disabled = true;
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
