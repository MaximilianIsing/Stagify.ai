/* global SupademoPlayer */ // provided by the classic demo-player.js loaded alongside
(function () {
  // Homepage demo sections (AI Designer, Masking Studio) mount the self-hosted
  // walkthrough player — no third-party iframe. Each host carries data-demo="<key>".
  // Mounting is deferred until the section nears the viewport so the frames stay
  // off the critical path and never compete with first paint.

  function demoByKey(key) {
    var data = window.STAGIFY_DEMOS && window.STAGIFY_DEMOS.demos;
    if (!data) return null;
    for (var i = 0; i < data.length; i++) {
      if (data[i].key === key) return data[i];
    }
    return null;
  }

  function mount(host) {
    if (host.__demoMounted) return;
    // demo-player.js / demo-data.js may not have executed yet. index-deferred.js
    // injects these tags dynamically, and a dynamically-inserted script is async by
    // default — so the array order there is a statement of intent, NOT a guarantee.
    // This used to `return` and do nothing, which was survivable while mounting ran
    // on an idle callback ~2.5s after load (the player had always arrived by then).
    // The showcase asks for its front panel the moment it initialises, so a silent
    // no-op here meant the walkthrough simply never appeared. Wait for the player
    // instead of dropping the request.
    if (!window.SupademoPlayer || !window.STAGIFY_DEMOS) {
      if (!host.__demoWait) {
        host.__demoWait = setInterval(function () {
          if (!window.SupademoPlayer || !window.STAGIFY_DEMOS) return;
          clearInterval(host.__demoWait);
          host.__demoWait = 0;
          mount(host);
        }, 100);
        // Give up rather than poll forever if the player genuinely failed to load.
        setTimeout(function () {
          if (host.__demoWait) { clearInterval(host.__demoWait); host.__demoWait = 0; }
        }, 15000);
      }
      return;
    }
    var demo = demoByKey(host.getAttribute('data-demo'));
    if (!demo) return;
    host.__demoMounted = true;
    // drop the static skeleton placeholder — the player renders its own
    host.textContent = '';
    var title = host.getAttribute('data-demo-title');
    var d = title ? Object.assign({}, demo, { title: title }) : demo;
    // dots:false keeps the homepage showcase chrome-free (nav via card + click)
    SupademoPlayer.mount(host, d, { dots: false });
  }

  function init() {
    // The homepage's demo hosts now live inside the studio showcase carousel, which
    // mounts ONLY the panel that is in front (scripts/studio-showcase.js) — mounting
    // both players here regardless meant paying for a walkthrough nobody had scrolled
    // to. Hosts outside a showcase (guides.html) keep the original eager behaviour.
    window.stagifyMountDemo = mount;
    // Announce, because the deferred scripts are injected dynamically and so execute
    // in no guaranteed order: the showcase may well have asked for its mount before
    // this file ran, and it retries on this event.
    document.dispatchEvent(new CustomEvent('stagify:demo-mount-ready'));

    var hosts = [].slice.call(document.querySelectorAll('.designer-demo[data-demo]'))
      .filter(function (host) { return !host.closest('[data-showcase]'); });
    if (!hosts.length) return;
    // Mount once the browser is idle (or after load) so the frames never compete
    // with first paint. Each mount only warms 1–2 images — the rest load lazily
    // as the visitor steps through — so this stays lighter than the old embeds.
    var mountAll = function () { hosts.forEach(mount); };
    if ('requestIdleCallback' in /** @type {any} */ (window)) {
      requestIdleCallback(mountAll, { timeout: 2500 });
    } else if (document.readyState === 'complete') {
      setTimeout(mountAll, 200);
    } else {
      window.addEventListener('load', function () { setTimeout(mountAll, 200); }, { once: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
