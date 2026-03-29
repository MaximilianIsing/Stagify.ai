(function () {
  var TOKEN_KEY = 'stagifyAuthToken';

  window.StagifyAuth = {
    TOKEN_KEY: TOKEN_KEY,
    user: null,

    getToken: function () {
      return localStorage.getItem(TOKEN_KEY);
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

      document.querySelectorAll('.nav-ai-designer-pro').forEach(function (el) {
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
        return;
      }

      if (proPanel) {
        if (u.plan === 'pro') proPanel.classList.remove('hidden');
        else proPanel.classList.add('hidden');
      }

      if (window.StagifyProfileMenu && typeof window.StagifyProfileMenu.refresh === 'function') {
        window.StagifyProfileMenu.refresh();
      }
    },
  };
})();
