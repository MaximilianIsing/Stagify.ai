// Hero stat pills + free-account upgrade nudge for the home page (scripts/app.js).
//
// loadHeroStats pulls the two public count endpoints and reveals/animates the
// stat pills (via window.StagifyHeroStats from count-up.js when present).
// updateHeroFreeGensLine is exposed by the entry as
// window.__stagifyUpdateHeroFreeGensLine so auth.js (a classic script) can call
// it on sign-in/out. Both no-op on pages without the hero elements.

/** Show upgrade nudge only for users signed into a free account. */
export function updateHeroFreeGensLine() {
    var el = document.getElementById('hero-free-gens-today');
    if (!el) return;
    var auth = window.StagifyAuth;
    var isSignedInFree =
      auth && auth.getToken && auth.getToken() && auth.user && !(auth.isProUser && auth.isProUser());
    if (!isSignedInFree) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = window.LanguageSystem?.getText('hero.freeGensUpgrade') ||
      'Try Stagify+ today — <a class="hero-free-gens-upgrade" href="stagify-plus.html">Upgrade</a>';
    el.classList.remove('hidden');
}

// Load hero stat pills from server, then reveal and animate to live counts
export function loadHeroStats(options) {
    if (!document.querySelector('.stat-pill-number[data-stat]')) return;

    var opts = options || {};
    var isRefresh = opts.refresh === true;

    Promise.all([
      fetch('/api/prompt-count').then(function (r) {
        return r.json();
      }),
      fetch('/api/contact-count').then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        var promptData = results[0];
        var contactData = results[1];
        var rooms =
          promptData && promptData.promptCount !== undefined
            ? Number(promptData.promptCount)
            : null;
        var users =
          contactData && contactData.usersServed !== undefined
            ? Number(contactData.usersServed)
            : contactData && contactData.contactCount !== undefined
              ? Number(contactData.contactCount) +
                Number(contactData.userCount || 0)
              : null;

        if (window.StagifyHeroStats && typeof window.StagifyHeroStats.setCounts === 'function') {
          window.StagifyHeroStats.setCounts(
            { roomsStaged: rooms, usersServed: users },
            { refresh: isRefresh }
          );
          return;
        }

        var wrap = document.getElementById('hero-stats');
        var roomsEl = document.querySelector('.stat-pill-number[data-stat="roomsStaged"]');
        var usersEl = document.querySelector('.stat-pill-number[data-stat="usersServed"]');
        if (roomsEl && rooms != null && !Number.isNaN(rooms)) roomsEl.textContent = String(rooms);
        if (usersEl && users != null && !Number.isNaN(users)) usersEl.textContent = String(users);
        if (wrap) wrap.classList.add('is-ready');
      })
      .catch(function (error) {
        console.error('Error loading hero stats:', error);
        if (
          window.StagifyHeroStats &&
          typeof window.StagifyHeroStats.revealWithoutCounts === 'function'
        ) {
          window.StagifyHeroStats.revealWithoutCounts();
        }
      });
}
