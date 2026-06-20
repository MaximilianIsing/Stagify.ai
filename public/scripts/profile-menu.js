(function () {
  var AUTH_BOUND = false;
  var authModeRegister = true;
  var authFlowForgot = false;
  var authFlowVerify = false;
  var authPendingEmail = '';
  var dropdownOpen = false;
  var GOOGLE_AUTH_INITIALIZED = false;
  var googleOAuthConfig = { loaded: false, clientId: '' };
  var googleSignInFetchInFlight = false;
  /** Stripe Customer Portal login (Dashboard → Customer portal → link). */
  var STRIPE_CUSTOMER_PORTAL_LOGIN =
    'https://billing.stripe.com/p/login/5kQ4gz35w3s42na1Jf7EQ00';
  var PORTAL_STRIPE_ICON =
    '<img src="media-webp/Stripe.webp" alt="" aria-hidden="true">';

  function lang(key, fallback, vars) {
    var text = fallback;
    if (window.LanguageSystem && typeof window.LanguageSystem.getText === 'function') {
      var got = window.LanguageSystem.getText(key);
      if (typeof got === 'string' && got !== 'Loading...') text = got;
    }
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        text = text.split('{' + k + '}').join(vars[k]);
      });
    }
    return text;
  }

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
      '<div id="auth-google-panel" class="auth-google-panel hidden" aria-hidden="true">' +
      '<p class="auth-divider"><span>or</span></p>' +
      '<div id="auth-google-btn-container" class="auth-google-btn-container"></div>' +
      '</div>' +
      '<button type="button" class="auth-forgot-link" id="auth-forgot-link">Forgot your password?</button>' +
      '</div>' +
      '<div id="auth-verify-panel" class="hidden">' +
      '<p class="auth-modal__sub auth-forgot-copy" id="auth-verify-copy">Enter the 6-digit code we sent to your email.</p>' +
      '<div class="auth-field"><label for="auth-verify-code">Verification code</label>' +
      '<input type="text" id="auth-verify-code" name="verificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456"></div>' +
      '<button type="button" class="auth-forgot-back" id="auth-verify-back">Back</button>' +
      '<button type="button" class="auth-forgot-back" id="auth-verify-resend">Resend code</button>' +
      '<div id="auth-verify-feedback" class="auth-error" role="status"></div>' +
      '</div>' +
      '<div id="auth-submit-row" class="auth-actions"><button type="submit" class="btn btn-primary btn-lg" id="auth-submit"><strong id="auth-submit-label">Create account</strong></button></div>' +
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
    var verify = document.getElementById('auth-verify-panel');
    var submitRow = document.getElementById('auth-submit-row');
    var tgl = document.querySelector('#auth-modal .auth-toggle');
    var mainsub = document.getElementById('auth-modal-sub');
    var title = document.getElementById('auth-modal-title');
    var emailEl = document.getElementById('auth-email');
    var submitLabel = document.getElementById('auth-submit-label');
    if (!std || !frg) return;
    if (authModeRegister && authFlowVerify) {
      std.classList.add('hidden');
      frg.classList.add('hidden');
      if (verify) verify.classList.remove('hidden');
      if (submitRow) submitRow.classList.remove('hidden');
      if (tgl) tgl.classList.add('hidden');
      if (mainsub) mainsub.classList.add('hidden');
      if (title) title.textContent = lang('auth.verifyTitle', 'Verify your email');
      if (emailEl) emailEl.readOnly = true;
      if (submitLabel) submitLabel.textContent = lang('auth.createAccount', 'Create account');
      var verifyCopy = document.getElementById('auth-verify-copy');
      if (verifyCopy) {
        verifyCopy.textContent = lang('auth.verifyCopy', 'Enter the 6-digit code we sent to {email}.', {
          email: authPendingEmail || lang('auth.yourEmail', 'your email'),
        });
      }
    } else if (authFlowForgot && !authModeRegister) {
      std.classList.add('hidden');
      frg.classList.remove('hidden');
      if (verify) verify.classList.add('hidden');
      if (submitRow) submitRow.classList.add('hidden');
      if (tgl) tgl.classList.add('hidden');
      if (mainsub) mainsub.classList.add('hidden');
      if (title) title.textContent = lang('auth.resetTitle', 'Reset password');
      if (emailEl) emailEl.readOnly = false;
    } else {
      frg.classList.add('hidden');
      std.classList.remove('hidden');
      if (verify) verify.classList.add('hidden');
      if (submitRow) submitRow.classList.remove('hidden');
      if (tgl) tgl.classList.remove('hidden');
      if (mainsub) mainsub.classList.remove('hidden');
      if (emailEl) emailEl.readOnly = false;
      var fb = document.getElementById('auth-forgot-feedback');
      if (fb) {
        fb.textContent = '';
        fb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
      }
      var verifyFb = document.getElementById('auth-verify-feedback');
      if (verifyFb) {
        verifyFb.textContent = '';
        verifyFb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
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
      !(authFlowForgot && !authModeRegister) &&
      !(authModeRegister && authFlowVerify);
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
      if (errEl) errEl.textContent = lang('auth.googleCancelled', 'Google sign-in was cancelled.');
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
          if (errEl) errEl.textContent = (result.data && result.data.error) || lang('auth.googleFailed', 'Google sign-in failed');
          return null;
        }
        var data = result.data;
        window.StagifyAuth.setToken(data.token);
        return window.StagifyAuth.fetchMe();
      })
      .then(function (user) {
        if (!user) return;
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
        if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
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

  function resetAuthVerificationFlow() {
    authFlowVerify = false;
    authPendingEmail = '';
    var codeEl = document.getElementById('auth-verify-code');
    if (codeEl) codeEl.value = '';
    var verifyFb = document.getElementById('auth-verify-feedback');
    if (verifyFb) {
      verifyFb.textContent = '';
      verifyFb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
    }
  }

  function syncAuthFormMode() {
    if (authModeRegister) {
      authFlowForgot = false;
    } else {
      resetAuthVerificationFlow();
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
      if (title) title.textContent = lang('auth.registerTitle', 'Create your free account');
      if (sub) sub.textContent = lang('auth.registerSub', 'Sign up to upload and stage images.');
      if (submitLabel && !authFlowVerify) submitLabel.textContent = lang('auth.continue', 'Continue');
      if (toggleLabel) toggleLabel.textContent = lang('auth.alreadyHaveAccount', 'Already have an account?');
      if (toggleBtn) toggleBtn.textContent = lang('auth.signIn', 'Sign in');
      if (confirmRow) confirmRow.classList.remove('hidden');
      if (confirmInput) confirmInput.required = true;
      if (passInput) passInput.setAttribute('autocomplete', 'new-password');
    } else {
      if (title) title.textContent = lang('auth.signInTitle', 'Sign in');
      if (sub) sub.textContent = lang('auth.signInSub', 'Use your email and password to continue.');
      if (submitLabel) submitLabel.textContent = lang('auth.signIn', 'Sign in');
      if (toggleLabel) toggleLabel.textContent = lang('auth.newHere', 'New here?');
      if (toggleBtn) toggleBtn.textContent = lang('auth.createAccount', 'Create account');
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
    resetAuthVerificationFlow();
  }

  function openAuthModal(forStaging) {
    ensureAuthModal();
    bindAuthOnce();
    authFlowForgot = false;
    resetAuthVerificationFlow();
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
        resetAuthVerificationFlow();
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
    var verifyBack = document.getElementById('auth-verify-back');
    if (verifyBack) {
      verifyBack.addEventListener('click', function () {
        resetAuthVerificationFlow();
        syncAuthFormMode();
        var er = document.getElementById('auth-error');
        if (er) er.textContent = '';
      });
    }
    var verifyResend = document.getElementById('auth-verify-resend');
    if (verifyResend) {
      verifyResend.addEventListener('click', async function () {
        var fb = document.getElementById('auth-verify-feedback');
        var emailEl = document.getElementById('auth-email');
        var email = authPendingEmail || (emailEl ? emailEl.value.trim() : '');
        if (fb) {
          fb.textContent = '';
          fb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
        }
        if (!email) {
          if (fb) fb.textContent = lang('auth.enterEmail', 'Enter your email address.');
          return;
        }
        verifyResend.disabled = true;
        try {
          var r = await fetch('/api/auth/register/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
          });
          var data = await r.json().catch(function () {
            return {};
          });
          if (fb) {
            if (!r.ok) {
              fb.textContent = data.error || lang('auth.resendFailed', 'Could not resend code. Try again.');
              fb.classList.add('auth-forgot-feedback--warn');
            } else {
              fb.textContent = data.message || lang('auth.resendSuccess', 'We sent a new verification code.');
              fb.classList.add('auth-forgot-feedback--success');
            }
          }
        } catch (err) {
          if (fb) fb.textContent = lang('auth.networkError', 'Network error. Please try again.');
        }
        verifyResend.disabled = false;
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
          if (fb) fb.textContent = lang('auth.enterEmail', 'Enter your email address.');
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
                lang('auth.resetSomethingWrong', 'Something went wrong. Please try again in a few minutes.');
              fb.classList.add('auth-forgot-feedback--warn');
            } else if (data.emailSent) {
              fb.textContent =
                data.message ||
                lang('auth.resetLinkSent', 'We sent a password reset link. Check your email (and spam).');
              fb.classList.add('auth-forgot-feedback--success');
            } else {
              fb.textContent =
                data.message ||
                lang('auth.noAccountForEmail', 'No account was found for that email.');
            }
          }
        } catch (err) {
          if (fb) fb.textContent = lang('auth.resetTryLater', 'Something went wrong. Try again later.');
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
        if (authModeRegister && authFlowVerify) {
          var codeEl = document.getElementById('auth-verify-code');
          var code = codeEl ? codeEl.value.trim() : '';
          if (!/^\d{6}$/.test(code)) {
            if (errEl) errEl.textContent = lang('auth.enterVerificationCode', 'Enter the 6-digit verification code from your email.');
            return;
          }
          try {
            var vr = await fetch('/api/auth/register/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email, code: code }),
            });
            var vdata = await vr.json();
            if (!vr.ok) {
              if (errEl) errEl.textContent = vdata.error || lang('auth.verificationFailed', 'Verification failed');
              return;
            }
            window.StagifyAuth.setToken(vdata.token);
            await window.StagifyAuth.fetchMe();
            window.StagifyAuth.applyUserToUI();
            closeAuthModal();
            if (window.__stagifyPendingStaging) {
              window.__stagifyPendingStaging = false;
              var stageModal = document.getElementById('stage-modal');
              if (stageModal) stageModal.classList.remove('hidden');
            }
            refresh();
          } catch (verr) {
            if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
          }
          return;
        }
        if (authModeRegister) {
          var confirmPass = confirmEl ? confirmEl.value : '';
          if (password !== confirmPass) {
            if (errEl) errEl.textContent = lang('auth.passwordsNoMatch', 'Passwords do not match.');
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
            if (errEl) errEl.textContent = data.error || lang('auth.somethingWrong', 'Something went wrong');
            return;
          }
          if (authModeRegister && data.needsVerification) {
            authFlowVerify = true;
            authPendingEmail = email;
            refreshAuthModalLayout();
            var verifyFb = document.getElementById('auth-verify-feedback');
            if (verifyFb) {
              verifyFb.textContent = data.message || lang('auth.checkEmailForCode', 'Check your email for a verification code.');
              verifyFb.classList.add('auth-forgot-feedback--success');
            }
            return;
          }
          window.StagifyAuth.setToken(data.token);
          await window.StagifyAuth.fetchMe();
          window.StagifyAuth.applyUserToUI();
          closeAuthModal();
          if (window.__stagifyPendingStaging) {
            window.__stagifyPendingStaging = false;
            var stageModal = document.getElementById('stage-modal');
            if (stageModal) stageModal.classList.remove('hidden');
          }
          refresh();
        } catch (err) {
          if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
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
        '<button type="button" class="profile-menu__item" data-profile-action="signin">' +
        lang('profile.signIn', 'Sign in') +
        '</button>' +
        '<button type="button" class="profile-menu__item" data-profile-action="signup">' +
        lang('profile.createAccount', 'Create account') +
        '</button>' +
        '</div>';
    } else {
      dd.classList.remove('profile-menu-dropdown--guest');
      var planLine = '';
      if (u.plan === 'pro') {
        planLine =
          '<div class="profile-menu__plan-row">' +
          '<a href="stagify-plus.html" class="profile-menu__plan profile-menu__plan--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="18" height="18"> Stagify+</a>' +
          '<a class="profile-menu__portal-help" href="' +
          STRIPE_CUSTOMER_PORTAL_LOGIN +
          '" target="_blank" rel="noopener noreferrer" aria-label="' +
          esc(lang('profile.manageBillingAria', 'Manage billing in Stripe')) +
          '">' +
          PORTAL_STRIPE_ICON +
          '</a>' +
          '</div>';
      } else {
        planLine = '<div class="profile-menu__plan">' + lang('profile.freePlan', 'Free Plan') + '</div>';
      }
      var plusRow = '';
      if (u.plan !== 'pro') {
        plusRow =
          '<a href="stagify-plus.html" class="profile-menu__link profile-menu__link--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="20" height="20"> ' +
          lang('profile.upgradeToPlus', 'Upgrade to Stagify+') +
          '</a>';
      }
      var manageRow = '';
      if (u.plan === 'pro' && u.canManageSubscription) {
        manageRow =
          '<button type="button" class="profile-menu__item" data-profile-action="manage-subscription">' +
          lang('profile.manageSubscription', 'Manage subscription') +
          '</button>';
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
        '<button type="button" class="profile-menu__item profile-menu__item--danger" data-profile-action="signout">' +
        lang('profile.signOut', 'Sign out') +
        '</button>' +
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

  window.addEventListener('languagechange', function () {
    syncAuthFormMode();
    refresh();
  });
})();
