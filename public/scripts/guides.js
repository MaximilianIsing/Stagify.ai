(function () {
  // Optional label when you redeploy; each page load also appends a unique timestamp.
  var SUPADEMO_CACHE_BUST = '4';

  function withCacheBust(url) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'v=' + encodeURIComponent(SUPADEMO_CACHE_BUST + '-' + Date.now());
  }

  function mountFreshEmbed(panel) {
    if (!panel) return;
    var embedUrl = panel.getAttribute('data-supademo-embed');
    if (!embedUrl) return;
    var title = panel.getAttribute('data-supademo-title') || 'Supademo walkthrough';

    panel.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'guide-demo-embed__inner';

    // Skeleton shown while the embed loads; the iframe fades in over it on load.
    var placeholder = document.createElement('div');
    placeholder.className = 'guide-demo-embed__placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    var spinner = document.createElement('span');
    spinner.className = 'guide-demo-embed__spinner';
    placeholder.appendChild(spinner);
    wrap.appendChild(placeholder);

    var iframe = document.createElement('iframe');
    iframe.title = title;
    iframe.setAttribute('loading', 'eager');
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('webkitallowfullscreen', 'true');
    iframe.setAttribute('mozallowfullscreen', 'true');
    iframe.setAttribute('allowfullscreen', '');
    iframe.addEventListener(
      'load',
      function () {
        wrap.classList.add('is-loaded');
      },
      { once: true }
    );
    iframe.src = withCacheBust(embedUrl);
    wrap.appendChild(iframe);
    panel.appendChild(wrap);
  }

  function initDemoPicker() {
    var picker = document.querySelector('.guide-demo-picker');
    if (!picker) return;

    var buttons = picker.querySelectorAll('[data-demo]');
    var panels = {};
    var descs = {};
    var loaded = {};
    buttons.forEach(function (btn) {
      var key = btn.getAttribute('data-demo');
      panels[key] = document.getElementById('guide-demo-' + key);
      descs[key] = document.getElementById('guide-demo-desc-' + key);
      loaded[key] = false;
    });

    function loadPanel(key) {
      if (panels[key] && !loaded[key]) {
        mountFreshEmbed(panels[key]);
        loaded[key] = true;
      }
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
      Object.keys(loaded).forEach(function (k) {
        loaded[k] = false;
      });
      Object.keys(panels).forEach(function (k) {
        if (panels[k] && !panels[k].hidden) loadPanel(k);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDemoPicker);
  } else {
    initDemoPicker();
  }
})();
