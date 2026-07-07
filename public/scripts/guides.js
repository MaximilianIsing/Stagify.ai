(function () {
  // Each walkthrough tab mounts the self-hosted player (window.STAGIFY_DEMOS +
  // SupademoPlayer) into its panel on first activation — no third-party embed.

  function demoByKey(key) {
    var data = window.STAGIFY_DEMOS && window.STAGIFY_DEMOS.demos;
    if (!data) return null;
    for (var i = 0; i < data.length; i++) {
      if (data[i].key === key) return data[i];
    }
    return null;
  }

  function mountPlayer(panel) {
    if (!panel || panel.__player || !window.SupademoPlayer) return;
    var demo = demoByKey(panel.getAttribute('data-demo'));
    if (!demo) return;
    panel.__player = window.SupademoPlayer.mount(panel, demo);
  }

  function initDemoPicker() {
    var picker = document.querySelector('.guide-demo-picker');
    if (!picker) return;

    var buttons = picker.querySelectorAll('[data-demo]');
    var panels = {};
    var descs = {};
    buttons.forEach(function (btn) {
      var key = btn.getAttribute('data-demo');
      panels[key] = document.getElementById('guide-demo-' + key);
      descs[key] = document.getElementById('guide-demo-desc-' + key);
    });

    // Mount on first activation (panel is visible → correct sizing); if already
    // mounted, just recompute the callout position for the current box size.
    function loadPanel(key) {
      var panel = panels[key];
      if (!panel) return;
      if (panel.__player) panel.__player.reflow();
      else mountPlayer(panel);
    }

    loadPanel('free');

    function setDemo(key) {
      buttons.forEach(function (btn) {
        var active = btn.getAttribute('data-demo') === key;
        btn.classList.toggle('guide-demo-picker__btn--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.keys(panels).forEach(function (k) {
        var panel = panels[k];
        if (!panel) return;
        var active = k === key;
        panel.classList.toggle('is-active', active);
        panel.hidden = !active;
        if (active) {
          panel.classList.remove('is-entering');
          void panel.offsetWidth;
          panel.classList.add('is-entering');
        }
      });
      loadPanel(key);
      Object.keys(descs).forEach(function (k) {
        if (descs[k]) descs[k].classList.toggle('hidden', k !== key);
      });
    }

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setDemo(btn.getAttribute('data-demo'));
      });
    });

    window.addEventListener('pageshow', function (event) {
      if (!event.persisted) return;
      // On bfcache restore, reposition whichever player is currently visible.
      Object.keys(panels).forEach(function (k) {
        if (panels[k] && !panels[k].hidden) loadPanel(k);
      });
    });
  }

  // When a topic card in the top grid is clicked, briefly highlight the matching
  // troubleshooting card it scrolls down to, so it's obvious which one is relevant.
  function initOverviewHighlight() {
    var cards = document.querySelectorAll('.guides-overview-card');
    if (!cards.length) return;

    function highlight(id) {
      var target = document.getElementById(id);
      if (!target || target.className.indexOf('guides-trouble-card') === -1) return;
      var all = document.querySelectorAll('.guides-trouble-card--highlight');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('guides-trouble-card--highlight');
      // Force a reflow so re-clicking the same card restarts the pulse animation.
      void target.offsetWidth;
      target.classList.add('guides-trouble-card--highlight');
    }

    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var href = card.getAttribute('href') || '';
        if (href.charAt(0) === '#') highlight(href.slice(1));
      });
    });

    function fromHash() {
      if (location.hash && location.hash.length > 1) highlight(location.hash.slice(1));
    }
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }

  function init() {
    initDemoPicker();
    initOverviewHighlight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
