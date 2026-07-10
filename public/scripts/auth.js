(function () {
  var TOKEN_KEY = 'stagifyAuthToken';

  window.StagifyAuth = {
    TOKEN_KEY: TOKEN_KEY,
    user: null,
    // Public client config from /api/auth/config (googleClientId, isStaging).
    // Populated by fetchConfig(); isStaging drives the staging-only UI (no Google
    // sign-in, no Stripe subscribe / help-center buttons).
    config: null,
    isStaging: false,
    _configPromise: null,

    getToken: function () {
      return localStorage.getItem(TOKEN_KEY);
    },

    /** Fetch (and cache) the public client config once per page load. */
    fetchConfig: function () {
      if (this._configPromise) return this._configPromise;
      var self = this;
      this._configPromise = fetch('/api/auth/config')
        .then(function (r) {
          return r.ok ? r.json() : {};
        })
        .then(function (cfg) {
          cfg = cfg || {};
          self.config = cfg;
          self.isStaging = !!cfg.isStaging;
          return cfg;
        })
        .catch(function () {
          self.config = {};
          return {};
        });
      return this._configPromise;
    },

    setToken: function (t) {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    },

    clear: function () {
      this.setToken(null);
      this.user = null;
    },

    fetchMe: function () {
      var tok = this.getToken();
      if (!tok) return Promise.resolve(null);
      var self = this;
      return fetch('/api/auth/me', {
        headers: { Authorization: 'Bearer ' + tok },
      })
        .then(function (r) {
          if (!r.ok) {
            self.clear();
            return null;
          }
          return r.json();
        })
        .then(function (d) {
          self.user = d && d.user ? d.user : null;
          return self.user;
        })
        .catch(function () {
          self.clear();
          return null;
        });
    },

    isProUser: function () {
      return !!(this.user && this.user.plan === 'pro');
    },

    /** Opens Stripe Customer Portal (cancel plan, update card). Requires canManageSubscription. */
    openBillingPortal: function () {
      var tok = this.getToken();
      if (!tok) return Promise.resolve(false);
      return fetch('/api/billing/customer-portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tok,
        },
        body: JSON.stringify({}),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, status: r.status, j: j };
          });
        })
        .then(function (x) {
          if (x.ok && x.j && x.j.url) {
            window.location.href = x.j.url;
            return true;
          }
          var msg =
            (x.j && x.j.error) ||
            (x.status === 503 ? 'Billing is not configured.' : 'Could not open billing portal.');
          if (typeof window.alert === 'function') window.alert(msg);
          return false;
        })
        .catch(function () {
          if (typeof window.alert === 'function') window.alert('Network error.');
          return false;
        });
    },

    applyUserToUI: function () {
      var u = this.user;
      var proPanel = document.getElementById('stagify-pro-panel');

      // "Remove existing furniture" is Stagify+ / Enterprise only (enterprise
      // users carry plan === 'pro'). Hide the control for everyone else and clear
      // any checked state so a downgraded/anon user can't submit removeFurniture.
      var removeRow = document.getElementById('remove-furniture-row');
      if (removeRow) {
        if (u && u.plan === 'pro') {
          removeRow.classList.remove('hidden');
        } else {
          removeRow.classList.add('hidden');
          var rfCb = document.getElementById('remove-furniture');
          if (rfCb && rfCb.checked) {
            rfCb.checked = false;
            rfCb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }

      document.querySelectorAll('.nav-ai-designer-pro, .nav-masking-studio-pro').forEach(function (el) {
        if (u && u.plan === 'pro') {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });

      if (!u) {
        if (proPanel) proPanel.classList.add('hidden');
        if (window.StagifyProfileMenu && typeof window.StagifyProfileMenu.refresh === 'function') {
          window.StagifyProfileMenu.refresh();
        }
        if (typeof window.__stagifyUpdateHeroFreeGensLine === 'function') {
          window.__stagifyUpdateHeroFreeGensLine();
        }
        return;
      }

      if (proPanel) {
        if (u.plan === 'pro') proPanel.classList.remove('hidden');
        else proPanel.classList.add('hidden');
      }

      if (window.StagifyProfileMenu && typeof window.StagifyProfileMenu.refresh === 'function') {
        window.StagifyProfileMenu.refresh();
      }
      if (typeof window.__stagifyUpdateHeroFreeGensLine === 'function') {
        window.__stagifyUpdateHeroFreeGensLine();
      }
    },
  };

  // --- Staging environment banner --------------------------------------------
  // A red bar across the very top of every page that loads this script, shown
  // only when the server reports IS_STAGING (via /api/auth/config). Keeps testers
  // aware they're on the staging/test site, not production. Sticky so it stays
  // visible; the sticky site header is nudged down to stack below it.
  window.StagifyAuth.fetchConfig().then(function (cfg) {
    if (cfg && cfg.showStagingBanner) showStagingBanner();
  });

  function showStagingBanner() {
    function mount() {
      if (!document.body || document.getElementById('stagify-staging-banner')) return;
      var bar = document.createElement('div');
      bar.id = 'stagify-staging-banner';
      bar.setAttribute('role', 'status');
      bar.style.cssText =
        'position:sticky;top:0;z-index:2147483647;flex:0 0 auto;' +
        'background:#dc2626;color:#fff;text-align:center;text-transform:uppercase;' +
        'letter-spacing:.05em;font:700 13px/1.25 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
        'padding:7px 14px;box-shadow:0 2px 8px rgba(0,0,0,.25)';
      bar.textContent = '⚠ Staging environment — test site, not the live stagify.ai';
      document.body.insertBefore(bar, document.body.firstChild);
      // Offset the sticky site header so it stacks below the banner (not under it).
      var h = bar.offsetHeight || 31;
      var s = document.createElement('style');
      s.textContent = '.site-header{top:' + h + 'px !important}';
      document.head.appendChild(s);
    }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
