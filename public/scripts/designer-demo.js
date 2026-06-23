(function () {
  // Optional label when you redeploy; each page load also appends a unique
  // timestamp so the browser always pulls the latest published Supademo embed.
  var SUPADEMO_CACHE_BUST = '1';

  function withCacheBust(url) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'v=' + encodeURIComponent(SUPADEMO_CACHE_BUST + '-' + Date.now());
  }

  function buildIframe(host) {
    if (host.querySelector('iframe')) return;
    var iframe = document.createElement('iframe');
    iframe.className = 'designer-demo__frame';
    iframe.src = withCacheBust(host.getAttribute('data-supademo-embed'));
    iframe.title = host.getAttribute('data-supademo-title') || 'Stagify AI Designer demo';
    iframe.loading = 'lazy';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('webkitallowfullscreen', 'true');
    iframe.setAttribute('mozallowfullscreen', 'true');
    iframe.setAttribute('allowfullscreen', '');
    iframe.addEventListener('load', function () {
      host.classList.add('is-loaded');
    });
    host.appendChild(iframe);
    host.classList.add('is-loading');
  }

  function init() {
    var host = document.querySelector('[data-supademo-embed]');
    if (!host) return;

    // Load the embed in the background as soon as the page has painted and the
    // browser is idle — so it's already loaded by the time the user scrolls to
    // it, without blocking first paint or interactivity.
    if ('requestIdleCallback' in window) {
      requestIdleCallback(
        function () {
          buildIframe(host);
        },
        { timeout: 2500 }
      );
    } else {
      // No requestIdleCallback — wait until the page is fully loaded, then load
      // on the next tick so it never competes with the initial render.
      var load = function () {
        setTimeout(function () {
          buildIframe(host);
        }, 200);
      };
      if (document.readyState === 'complete') {
        load();
      } else {
        window.addEventListener('load', load, { once: true });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
