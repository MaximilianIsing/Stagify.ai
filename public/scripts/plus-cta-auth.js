(function () {
  // On the homepage, a logged-out visitor clicking "View Stagify+" is prompted to
  // create an account first; after sign-up they continue to the Stagify+ page.
  function init() {
    var ctas = document.querySelectorAll('.plus-cta');
    if (!ctas.length) return;
    ctas.forEach(function (cta) {
      cta.addEventListener('click', function (e) {
        var loggedIn =
          window.StagifyAuth &&
          typeof window.StagifyAuth.getToken === 'function' &&
          window.StagifyAuth.getToken();
        if (loggedIn) return; // has an account → follow the link to Stagify+

        var pm = window.StagifyProfileMenu;
        if (!pm || typeof pm.openAuthModal !== 'function') return; // can't prompt → allow normal nav

        e.preventDefault();
        window.__stagifyPendingPlusRedirect = true;
        if (typeof pm.setAuthModeRegister === 'function') pm.setAuthModeRegister(true);
        pm.openAuthModal(false);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
