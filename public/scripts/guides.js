(function () {
  var FREE_EMBED =
    'https://app.supademo.com/embed/cmqldspgv0jrdqms4h4svk1dh?embed_v=2&utm_source=embed';
  var PLUS_EMBED =
    'https://app.supademo.com/embed/cmqleqav40k2pqms4hru96syf?embed_v=2&utm_source=embed';

  function initDemoPicker() {
    var picker = document.querySelector('.guide-demo-picker');
    if (!picker) return;

    var buttons = picker.querySelectorAll('[data-demo]');
    var panels = {
      free: document.getElementById('guide-demo-free'),
      plus: document.getElementById('guide-demo-plus'),
    };
    var descFree = document.getElementById('guide-demo-desc-free');
    var descPlus = document.getElementById('guide-demo-desc-plus');
    var loaded = { free: true, plus: false };

    function ensureIframe(panel, src, title) {
      if (!panel) return;
      if (panel.querySelector('iframe')) return;
      var wrap = document.createElement('div');
      wrap.className = 'guide-demo-embed__inner';
      wrap.innerHTML =
        '<iframe src="' +
        src +
        '" loading="lazy" title="' +
        title +
        '" allow="clipboard-write" frameborder="0" webkitallowfullscreen="true" mozallowfullscreen="true" allowfullscreen></iframe>';
      panel.appendChild(wrap);
    }

    function setDemo(key) {
      buttons.forEach(function (btn) {
        var active = btn.getAttribute('data-demo') === key;
        btn.classList.toggle('guide-demo-picker__btn--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.keys(panels).forEach(function (k) {
        var panel = panels[k];
        if (!panel) return;
        panel.classList.toggle('is-active', k === key);
        panel.hidden = k !== key;
      });
      if (key === 'plus' && !loaded.plus) {
        ensureIframe(panels.plus, PLUS_EMBED, 'Your first Stagify+ staging');
        loaded.plus = true;
      }
      if (descFree) descFree.classList.toggle('hidden', key !== 'free');
      if (descPlus) descPlus.classList.toggle('hidden', key !== 'plus');
    }

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setDemo(btn.getAttribute('data-demo'));
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDemoPicker);
  } else {
    initDemoPicker();
  }
})();
