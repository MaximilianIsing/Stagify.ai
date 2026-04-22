(function () {
  var AUTH_BOUND = false;
  var authModeRegister = true;
  var authFlowForgot = false;
  var dropdownOpen = false;
  var GOOGLE_AUTH_INITIALIZED = false;
  var googleOAuthConfig = { loaded: false, clientId: '' };
  var googleSignInFetchInFlight = false;
  /** Stripe Customer Portal login (Dashboard → Customer portal → link). */
  var STRIPE_CUSTOMER_PORTAL_LOGIN =
    'https://billing.stripe.com/p/login/5kQ4gz35w3s42na1Jf7EQ00';
  var PORTAL_HELP_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';

  function ensureAuthModal() {
    if (document.getElementById('auth-modal')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div id="auth-modal" class="auth-modal hidden" aria-hidden="true">' +
      '<div class="auth-modal__backdrop" id="auth-modal-backdrop"></div>' +
      '<div class="auth-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">' +
      '<button type="button" class="auth-modal__close" id="auth-modal-close" aria-label="Close">×</button>' +
      '<h2 id="auth-modal-title">Welcome to Stagify</h2>' +
      '<p class="auth-modal__sub" id="auth-modal-sub">Create a free account to upload and stage your photos.</p>' +
      '<div id="auth-error" class="auth-error" role="alert"></div>' +
      '<form id="auth-form" novalidate>' +
      '<div class="auth-field"><label for="auth-email">Email</label>' +
      '<input type="email" id="auth-email" name="email" autocomplete="email" required placeholder="you@example.com"></div>' +
      '<div id="auth-standard-panel">' +
      '<div class="auth-field"><label for="auth-password">Password</label>' +
      '<input type="password" id="auth-password" name="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters"></div>' +
      '<div class="auth-field" id="auth-password-confirm-row"><label for="auth-password-confirm">Confirm password</label>' +
      '<input type="password" id="auth-password-confirm" name="passwordConfirm" autocomplete="new-password" minlength="8" placeholder="Re-enter password"></div>' +
      '<div class="auth-actions"><button type="submit" class="btn btn-primary btn-lg" id="auth-submit"><strong id="auth-submit-label">Create account</strong></button></div>' +
      '<div id="auth-google-panel" class="auth-google-panel hidden" aria-hidden="true">' +
      '<p class="auth-divider"><span>or</span></p>' +
      '<div id="auth-google-btn-container" class="auth-google-btn-container"></div>' +
      '</div>' +
      '<button type="button" class="auth-forgot-link" id="auth-forgot-link">Forgot your password?</button>' +
      '</div>' +
      '<div id="auth-forgot-panel" class="hidden">' +
      '<p class="auth-modal__sub auth-forgot-copy">We’ll email you a one-time link to set a new password. The link expires in one hour.</p>' +
      '<div class="auth-actions"><button type="button" class="btn btn-primary btn-lg" id="auth-forgot-send"><strong>Send reset link</strong></button></div>' +
      '<button type="button" class="auth-forgot-back" id="auth-forgot-back">Back to sign in</button>' +
      '<div id="auth-forgot-feedback" class="auth-error" role="status"></div>' +
      '</div>' +
      '</form>' +
      '<div class="auth-toggle"><span id="auth-toggle-label">Already have an account?</span> ' +
      '<button type="button" id="auth-mode-toggle">Sign in</button></div>' +
      '</div></div>';
    document.body.insertBefore(wrap.firstElementChild, document.body.firstChild);
  }

  function refreshAuthModalLayout() {
    var std = document.getElementById('auth-standard-panel');
    var frg = document.getElementById('auth-forgot-panel');
    var tgl = document.querySelector('#auth-modal .auth-toggle');
    var mainsub = document.getElementById('auth-modal-sub');
    var title = document.getElementById('auth-modal-title');
    if (!std || !frg) return;
    if (authFlowForgot && !authModeRegister) {
      std.classList.add('hidden');
      frg.classList.remove('hidden');
      if (tgl) tgl.classList.add('hidden');
      if (mainsub) mainsub.classList.add('hidden');
      if (title) title.textContent = 'Reset password';
    } else {
      frg.classList.add('hidden');
      std.classList.remove('hidden');
      if (tgl) tgl.classList.remove('hidden');
      if (mainsub) mainsub.classList.remove('hidden');
      var fb = document.getElementById('auth-forgot-feedback');
      if (fb) {
        fb.textContent = '';
        fb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
      }
    }
    updateGooglePanelVisibility();
  }

  function updateGooglePanelVisibility() {
    var gp = document.getElementById('auth-google-panel');
    if (!gp) return;
    var show =
      googleOAuthConfig.loaded &&
      googleOAuthConfig.clientId &&
      !(authFlowForgot && !authModeRegister);
    if (show) {
      gp.classList.remove('hidden');
      gp.setAttribute('aria-hidden', 'false');
    } else {
      gp.classList.add('hidden');
      gp.setAttribute('aria-hidden', 'true');
    }
  }

  function handleGoogleCredential(response) {
    var errEl = document.getElementById('auth-error');
    if (!response || !response.credential) {
      if (errEl) errEl.textContent = 'Google sign-in was cancelled.';
      return;
    }
    if (errEl) errEl.textContent = '';
    fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          if (errEl) errEl.textContent = (result.data && result.data.error) || 'Google sign-in failed';
          return;
        }
        var data = result.data;
        window.StagifyAuth.setToken(data.token);
        window.StagifyAuth.user = data.user;
        window.StagifyAuth.applyUserToUI();
        closeAuthModal();
        if (window.__stagifyPendingStaging) {
          window.__stagifyPendingStaging = false;
          var stageModal = document.getElementById('stage-modal');
          if (stageModal) stageModal.classList.remove('hidden');
        }
        refresh();
      })
      .catch(function () {
        if (errEl) errEl.textContent = 'Network error. Please try again.';
      });
  }

  function initGoogleButtonWhenReady() {
    var clientId = googleOAuthConfig.clientId;
    if (!clientId || !window.google || !google.accounts || !google.accounts.id) return;
    var container = document.getElementById('auth-google-btn-container');
    if (!container) return;
    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    container.innerHTML = '';
    var dialog = document.querySelector('.auth-modal__dialog');
    var maxW = dialog ? Math.min(320, dialog.clientWidth - 48) : 280;
    var btnW = Math.max(240, maxW);
    google.accounts.id.renderButton(container, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      width: btnW,
    });
    GOOGLE_AUTH_INITIALIZED = true;
    updateGooglePanelVisibility();
  }

  function tryInitGoogleSignIn() {
    if (GOOGLE_AUTH_INITIALIZED) {
      updateGooglePanelVisibility();
      return;
    }
    if (googleOAuthConfig.loaded) {
      if (
        googleOAuthConfig.clientId &&
        window.google &&
        google.accounts &&
        google.accounts.id &&
        !GOOGLE_AUTH_INITIALIZED
      ) {
        initGoogleButtonWhenReady();
      } else {
        updateGooglePanelVisibility();
      }
      return;
    }
    if (googleSignInFetchInFlight) return;
    googleSignInFetchInFlight = true;
    fetch('/api/auth/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        googleOAuthConfig.loaded = true;
        googleOAuthConfig.clientId = (cfg && cfg.googleClientId) || '';
        if (!googleOAuthConfig.clientId) {
          updateGooglePanelVisibility();
          return;
        }
        var existing = document.querySelector('script[data-stagify-google-gsi]');
        if (existing) {
          initGoogleButtonWhenReady();
          return;
        }
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.setAttribute('data-stagify-google-gsi', '1');
        s.onload = function () {
          initGoogleButtonWhenReady();
        };
        s.onerror = function () {
          googleOAuthConfig.clientId = '';
          updateGooglePanelVisibility();
        };
        document.head.appendChild(s);
      })
      .catch(function () {
        googleOAuthConfig.loaded = true;
        googleOAuthConfig.clientId = '';
        updateGooglePanelVisibility();
      })
      .finally(function () {
        googleSignInFetchInFlight = false;
      });
  }

  function syncAuthFormMode() {
    if (authModeRegister) {
      authFlowForgot = false;
    }
    var title = document.getElementById('auth-modal-title');
    var sub = document.getElementById('auth-modal-sub');
    var submitLabel = document.getElementById('auth-submit-label');
    var toggleLabel = document.getElementById('auth-toggle-label');
    var toggleBtn = document.getElementById('auth-mode-toggle');
    var confirmRow = document.getElementById('auth-password-confirm-row');
    var confirmInput = document.getElementById('auth-password-confirm');
    var passInput = document.getElementById('auth-password');
    if (authModeRegister) {
      if (title) title.textContent = 'Create your free account';
      if (sub) sub.textContent = 'Sign up to upload and stage images. Free plan includes 3 staging runs per day.';
      if (submitLabel) submitLabel.textContent = 'Create account';
      if (toggleLabel) toggleLabel.textContent = 'Already have an account?';
      if (toggleBtn) toggleBtn.textContent = 'Sign in';
      if (confirmRow) confirmRow.classList.remove('hidden');
      if (confirmInput) confirmInput.required = true;
      if (passInput) passInput.setAttribute('autocomplete', 'new-password');
    } else {
      if (title) title.textContent = 'Sign in';
      if (sub) sub.textContent = 'Use your email and password to continue.';
      if (submitLabel) submitLabel.textContent = 'Sign in';
      if (toggleLabel) toggleLabel.textContent = 'New here?';
      if (toggleBtn) toggleBtn.textContent = 'Create account';
      if (confirmRow) confirmRow.classList.add('hidden');
      if (confirmInput) {
        confirmInput.required = false;
        confirmInput.value = '';
      }
      if (passInput) passInput.setAttribute('autocomplete', 'current-password');
    }
    var flink = document.getElementById('auth-forgot-link');
    if (flink) {
      if (authModeRegister) flink.classList.add('hidden');
      else flink.classList.remove('hidden');
    }
    refreshAuthModalLayout();
  }

  function closeAuthModal() {
    var m = document.getElementById('auth-modal');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
    window.__stagifyPendingStaging = false;
  }

  function openAuthModal(forStaging) {
    ensureAuthModal();
    bindAuthOnce();
    authFlowForgot = false;
    if (forStaging) window.__stagifyPendingStaging = true;
    var m = document.getElementById('auth-modal');
    if (!m) return;
    var err = document.getElementById('auth-error');
    if (err) err.textContent = '';
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
    syncAuthFormMode();
    tryInitGoogleSignIn();
    closeDropdown();
  }

  function bindAuthOnce() {
    if (AUTH_BOUND) return;
    if (!window.StagifyAuth) return;
    ensureAuthModal();
    AUTH_BOUND = true;

    var backdrop = document.getElementById('auth-modal-backdrop');
    var closeBtn = document.getElementById('auth-modal-close');
    var toggle = document.getElementById('auth-mode-toggle');
    var form = document.getElementById('auth-form');

    if (backdrop) backdrop.addEventListener('click', closeAuthModal);
    if (closeBtn) closeBtn.addEventListener('click', closeAuthModal);
    if (toggle) {
      toggle.addEventListener('click', function () {
        authModeRegister = !authModeRegister;
        authFlowForgot = false;
        syncAuthFormMode();
        var er = document.getElementById('auth-error');
        if (er) er.textContent = '';
      });
    }
    var forgotLink = document.getElementById('auth-forgot-link');
    if (forgotLink) {
      forgotLink.addEventListener('click', function () {
        authFlowForgot = true;
        syncAuthFormMode();
        var er = document.getElementById('auth-error');
        if (er) er.textContent = '';
      });
    }
    var forgotBack = document.getElementById('auth-forgot-back');
    if (forgotBack) {
      forgotBack.addEventListener('click', function () {
        authFlowForgot = false;
        syncAuthFormMode();
        var er = document.getElementById('auth-error');
        if (er) er.textContent = '';
      });
    }
    var forgotSend = document.getElementById('auth-forgot-send');
    if (forgotSend) {
      forgotSend.addEventListener('click', async function () {
        var fb = document.getElementById('auth-forgot-feedback');
        var emailEl = document.getElementById('auth-email');
        var email = emailEl ? emailEl.value.trim() : '';
        if (fb) fb.textContent = '';
        if (!email) {
          if (fb) fb.textContent = 'Enter your email address.';
          return;
        }
        forgotSend.disabled = true;
        try {
          var r = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
          });
          var data = await r.json().catch(function () {
            return {};
          });
          if (fb) {
            fb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
            if (!r.ok) {
              fb.textContent =
                data.error ||
                data.message ||
                'Something went wrong. Please try again in a few minutes.';
              fb.classList.add('auth-forgot-feedback--warn');
            } else if (data.emailSent) {
              fb.textContent =
                data.message ||
                'We sent a password reset link. Check your email (and spam).';
              fb.classList.add('auth-forgot-feedback--success');
            } else {
              fb.textContent =
                data.message ||
                'No account was found for that email.';
            }
          }
        } catch (err) {
          if (fb) fb.textContent = 'Something went wrong. Try again later.';
        }
        forgotSend.disabled = false;
      });
    }
    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (authFlowForgot) {
          return;
        }
        var errEl = document.getElementById('auth-error');
        var emailEl = document.getElementById('auth-email');
        var passEl = document.getElementById('auth-password');
        var confirmEl = document.getElementById('auth-password-confirm');
        var email = emailEl ? emailEl.value.trim() : '';
        var password = passEl ? passEl.value : '';
        if (errEl) errEl.textContent = '';
        if (authModeRegister) {
          var confirmPass = confirmEl ? confirmEl.value : '';
          if (password !== confirmPass) {
            if (errEl) errEl.textContent = 'Passwords do not match.';
            return;
          }
        }
        var path = authModeRegister ? '/api/auth/register' : '/api/auth/login';
        try {
          var r = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password }),
          });
          var data = await r.json();
          if (!r.ok) {
            if (errEl) errEl.textContent = data.error || 'Something went wrong';
            return;
          }
          window.StagifyAuth.setToken(data.token);
          window.StagifyAuth.user = data.user;
          window.StagifyAuth.applyUserToUI();
          closeAuthModal();
          if (window.__stagifyPendingStaging) {
            window.__stagifyPendingStaging = false;
            var stageModal = document.getElementById('stage-modal');
            if (stageModal) stageModal.classList.remove('hidden');
          }
          refresh();
        } catch (err) {
          if (errEl) errEl.textContent = 'Network error. Please try again.';
        }
      });
    }
    tryInitGoogleSignIn();
  }

  function closeDropdown() {
    var dd = document.getElementById('profile-menu-dropdown');
    var btn = document.getElementById('profile-menu-btn');
    dropdownOpen = false;
    if (dd) {
      dd.classList.add('hidden');
      dd.setAttribute('aria-hidden', 'true');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function openDropdown() {
    var dd = document.getElementById('profile-menu-dropdown');
    var btn = document.getElementById('profile-menu-btn');
    if (!dd || !btn) return;
    refresh();
    dd.classList.remove('hidden');
    dd.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    dropdownOpen = true;
  }

  function toggleDropdown(e) {
    e.stopPropagation();
    if (dropdownOpen) closeDropdown();
    else openDropdown();
  }

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function refresh() {
    var dd = document.getElementById('profile-menu-dropdown');
    if (!dd || !window.StagifyAuth) return;

    var u = window.StagifyAuth.user;
    var tok = window.StagifyAuth.getToken();

    if (!tok || !u) {
      dd.classList.add('profile-menu-dropdown--guest');
      dd.innerHTML =
        '<div class="profile-menu__section">' +
        '<button type="button" class="profile-menu__item" data-profile-action="signin">Sign in</button>' +
        '<button type="button" class="profile-menu__item" data-profile-action="signup">Create account</button>' +
        '</div>';
    } else {
      dd.classList.remove('profile-menu-dropdown--guest');
      var planLine = '';
      if (u.plan === 'pro') {
        planLine =
          '<div class="profile-menu__plan-row">' +
          '<div class="profile-menu__plan profile-menu__plan--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="18" height="18"> Stagify+</div>' +
          '<a class="profile-menu__portal-help" href="' +
          STRIPE_CUSTOMER_PORTAL_LOGIN +
          '" target="_blank" rel="noopener noreferrer" aria-label="Manage billing and subscription">' +
          PORTAL_HELP_SVG +
          '</a>' +
          '</div>';
      } else {
        var lim = u.dailyGenerationLimit != null ? u.dailyGenerationLimit : 3;
        var used = u.dailyGenerationsUsed != null ? u.dailyGenerationsUsed : 0;
        planLine = '<div class="profile-menu__plan">Free · ' + used + '/' + lim + ' staging today</div>';
      }
      var plusRow = '';
      if (u.plan !== 'pro') {
        plusRow =
          '<a href="stagify-plus.html" class="profile-menu__link profile-menu__link--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="20" height="20"> Upgrade to Stagify+</a>';
      }
      var manageRow = '';
      if (u.plan === 'pro' && u.canManageSubscription) {
        manageRow =
          '<button type="button" class="profile-menu__item" data-profile-action="manage-subscription">Manage subscription</button>';
      }
      dd.innerHTML =
        '<div class="profile-menu__header">' +
        '<div class="profile-menu__email">' +
        esc(u.email) +
        '</div>' +
        planLine +
        '</div>' +
        '<div class="profile-menu__divider"></div>' +
        '<div class="profile-menu__section">' +
        plusRow +
        manageRow +
        '<button type="button" class="profile-menu__item profile-menu__item--danger" data-profile-action="signout">Sign out</button>' +
        '</div>';
    }
  }

  function onDropdownClick(e) {
    var t = e.target.closest('[data-profile-action]');
    if (!t) return;
    var action = t.getAttribute('data-profile-action');
    if (action === 'signin') {
      authModeRegister = false;
      syncAuthFormMode();
      closeDropdown();
      openAuthModal(false);
      return;
    }
    if (action === 'signup') {
      authModeRegister = true;
      syncAuthFormMode();
      closeDropdown();
      openAuthModal(false);
      return;
    }
    if (action === 'manage-subscription') {
      e.preventDefault();
      if (window.StagifyAuth && typeof window.StagifyAuth.openBillingPortal === 'function') {
        window.StagifyAuth.openBillingPortal();
      }
      return;
    }
    if (action === 'signout') {
      e.preventDefault();
      closeDropdown();
      var tok = window.StagifyAuth.getToken();
      if (tok) {
        fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authToken: tok }),
        }).catch(function () {});
      }
      window.StagifyAuth.clear();
      window.StagifyAuth.applyUserToUI();
      refresh();
    }
  }

  function onDocClick(e) {
    if (!dropdownOpen) return;
    if (e.target.closest('.profile-menu-wrap')) return;
    closeDropdown();
  }

  var docBound = false;

  function init() {
    if (!document.getElementById('profile-menu-btn')) return;
    bindAuthOnce();
    if (document.getElementById('auth-modal')) {
      syncAuthFormMode();
    }
    var btn = document.getElementById('profile-menu-btn');
    var dd = document.getElementById('profile-menu-dropdown');
    btn.addEventListener('click', toggleDropdown);
    if (dd) dd.addEventListener('click', onDropdownClick);
    if (!docBound) {
      docBound = true;
      document.addEventListener('click', onDocClick);
    }

    if (window.StagifyAuth) {
      window.StagifyAuth.fetchMe().then(function () {
        window.StagifyAuth.applyUserToUI();
        refresh();
      });
    }
  }

  window.StagifyProfileMenu = {
    openAuthModal: openAuthModal,
    refresh: refresh,
    closeDropdown: closeDropdown,
    setAuthModeRegister: function (v) {
      authModeRegister = !!v;
      authFlowForgot = false;
      syncAuthFormMode();
    },
  };

  window.__stagifyOpenAuthForStaging = function () {
    authModeRegister = true;
    authFlowForgot = false;
    syncAuthFormMode();
    openAuthModal(true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
