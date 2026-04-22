(function () {
  function setOpen(wrap, open) {
    var trig = wrap.querySelector('.nav-dropdown__trigger');
    wrap.classList.toggle('nav-dropdown--open', open);
    if (trig) trig.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeAll() {
    document.querySelectorAll('.nav-dropdown.nav-dropdown--open').forEach(function (wrap) {
      setOpen(wrap, false);
    });
  }

  function onDocClick(e) {
    if (e.target.closest('.nav-dropdown')) return;
    closeAll();
  }

  function bind() {
    var wraps = document.querySelectorAll('.nav-dropdown');
    if (!wraps.length) return;

    wraps.forEach(function (wrap) {
      var trig = wrap.querySelector('.nav-dropdown__trigger');
      if (!trig) return;
      trig.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var willOpen = !wrap.classList.contains('nav-dropdown--open');
        document.querySelectorAll('.nav-dropdown.nav-dropdown--open').forEach(function (w) {
          if (w !== wrap) setOpen(w, false);
        });
        setOpen(wrap, willOpen);
      });
    });

    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
