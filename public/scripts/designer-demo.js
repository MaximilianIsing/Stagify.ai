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
    if (host.__demoMounted || !window.SupademoPlayer) return;
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
    var hosts = [].slice.call(document.querySelectorAll('.designer-demo[data-demo]'));
    if (!hosts.length) return;
    // Mount once the browser is idle (or after load) so the frames never compete
    // with first paint. Each mount only warms 1–2 images — the rest load lazily
    // as the visitor steps through — so this stays lighter than the old embeds.
    var mountAll = function () { hosts.forEach(mount); };
    if ('requestIdleCallback' in window) {
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
