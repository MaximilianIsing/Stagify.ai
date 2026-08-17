import { syncRemoveFurnitureRow } from './app/remove-furniture-gate.js';
import { syncStagingMenu } from './staging-menu.js';
import { syncGalleryTab } from './gallery-tab.js';
import { syncExteriorAccess } from './exterior-studio/access.js';
import { syncMaskingStudioAccess } from './masking-studio/access.js';
import { syncDesignerAccess } from './ai-designer/access.js';
import { syncPlusRail } from './app/plus-rail.js';

(function () {
  var TOKEN_KEY = 'stagifyAuthToken';
  // Last known plan ('pro' | 'free'), mirrored into storage purely so a render-blocking
  // head script can read it BEFORE paint — /api/auth/me is a round trip away, which is a
  // whole paint too late for a page that has to choose a shape (scripts/preview-gate.js).
  // It is a cache, never a fact: nothing may authorize on it, and the server gate
  // (requireProAccount) is what actually decides. Written by setUser() below, and only
  // there, so sign-out and an expired token both drop it on the floor with the token.
  var PLAN_KEY = 'stagifyPlan';

  window.StagifyAuth = {
    TOKEN_KEY: TOKEN_KEY,
    PLAN_KEY: PLAN_KEY,
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
          self.isStaging = !!(/** @type {any} */ (cfg)).isStaging;
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

    /**
     * Mirror the current plan into storage. Kept private to this file and called from
     * exactly two places — setUser (the /api/auth/me answer, and sign-out) and
     * applyUserToUI (which every auth change already funnels through, so a call site that
     * assigns `StagifyAuth.user` directly still cannot leave the cache stale).
     *
     * @param {{ plan?: string } | null | undefined} u - The account, or null when signed out.
     */
    cachePlan: function (u) {
      // Storage can throw (Safari private mode, a blocked third-party context). The cache
      // is an optimization — losing it costs a flash — so it may never break sign-in.
      try {
        if (u && u.plan) localStorage.setItem(PLAN_KEY, u.plan);
        else localStorage.removeItem(PLAN_KEY);
      } catch (e) {
        /* no cache this session */
      }
    },

    /**
     * Set the signed-in account and keep the plan cache with it.
     *
     * @param {{ plan?: string } | null | undefined} u - The account, or null when signed out.
     * @returns {any} The stored user, so callers can chain.
     */
    setUser: function (u) {
      this.user = u || null;
      this.cachePlan(this.user);
      return this.user;
    },

    clear: function () {
      this.setToken(null);
      // Via setUser so the cached plan goes with the token. If it outlived sign-out, the
      // next page load would pre-paint the studio for someone who is no longer signed in.
      this.setUser(null);
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
          return self.setUser(d && d.user ? d.user : null);
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

      // Re-mirror the plan before anything is painted. setUser already does this for the
      // two paths that own `user`, but a couple of render responses assign it directly
      // (exterior-studio-app.js, app/staging-pipeline.js) and then call straight through
      // to here — so this is what keeps the cache honest for them.
      this.cachePlan(u);

      // "Remove existing furniture" is Stagify+ / Enterprise only (enterprise users
      // carry plan === 'pro'), AND is unavailable for room types whose furniture is
      // fixed. Both conditions are applied by the shared gate so this call site and
      // the room-type select can't fight over the row — see remove-furniture-gate.js.
      // It reads the plan off window.StagifyAuth, which `u` already is.
      syncRemoveFurnitureRow();

      // The top-nav "Staging" dropdown's three Stagify+ rows. Same deal as the
      // row above: one idempotent writer owns the classes, so this call site
      // doesn't need to know which rows exist or what "locked" looks like. It
      // replaced a pair of nav links that were revealed by stripping `.hidden`,
      // which left free users with no hint the studios existed at all.
      syncStagingMenu();

      // The top-nav "Gallery" tab, hidden from signed-out visitors. Called before
      // the early return below on purpose: signing OUT has to put the tab away
      // again, and that is the branch that runs when it does.
      syncGalleryTab();

      // The PREVIEW pages, each of which shows one of three views on a single URL
      // (pitch for anonymous, the same pitch for free, the tool for Stagify+). Like the
      // three writers above they are idempotent and no-op on every page that is not
      // theirs — and like syncGalleryTab they are called BEFORE the early return below,
      // because signing OUT has to put the public pitch back.
      //
      // One line per page rather than a loop: each writer is bound to its own element
      // ids at module load (createPreviewAccess), and a registry would put the ids one
      // indirection away from the page that owns them for no saving at four entries.
      syncExteriorAccess();
      syncMaskingStudioAccess();
      syncDesignerAccess();

      // The "What Stagify+ could add" rail at the foot of the staging toolbar — the
      // inverse of the pro panel below, and the reason it is called up here with the
      // other four rather than in the branches: it is shown to signed-OUT visitors as
      // well as free ones, so the `if (!u)` return would skip exactly the people it
      // exists for. Signing out has to bring it back, and this is the branch that runs.
      syncPlusRail();

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
      bar.textContent = '⚠ Staging environment: test site, not the live stagify.ai';
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
