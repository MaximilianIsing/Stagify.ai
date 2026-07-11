import { lang } from './dom-utils.js';
import { AUTH_MODAL_HTML } from './auth-modal-template.js';
import { createGoogleSignIn } from './google-signin.js';

/**
 * The account auth modal — create-account / sign-in / forgot-password / email
 * verification. Owns its own form state and delegates Google sign-in to the
 * google-signin island. When auth state changes it calls back into the profile
 * dropdown through the injected callbacks.
 *
 * @param {object} deps
 * @param {() => void} deps.onRefresh       Re-render the profile dropdown (plan/email changed).
 * @param {() => void} deps.onCloseDropdown Close the profile dropdown (e.g. when opening the modal).
 * @returns Auth-modal controls used by the profile dropdown.
 */
export function createAuthModal({ onRefresh, onCloseDropdown }) {
  var AUTH_BOUND = false;
  var authModeRegister = true;
  var authFlowForgot = false;
  var authFlowVerify = false;
  var authPendingEmail = '';

  // Google Identity Services lives in its own island. It needs the modal's live
  // form mode (to hide its panel during forgot/verify) and a way to close the
  // modal on success; closeAuthModal is a hoisted declaration below.
  var gsi = createGoogleSignIn({
    getAuthFlow: function () {
      return {
        authModeRegister: authModeRegister,
        authFlowForgot: authFlowForgot,
        authFlowVerify: authFlowVerify,
      };
    },
    closeAuthModal: closeAuthModal,
    onRefresh: onRefresh,
  });

  function ensureAuthModal() {
    if (document.getElementById('auth-modal')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = AUTH_MODAL_HTML;
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
    var emailEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-email'));
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
    var termsNotice = document.getElementById('auth-terms-notice');
    if (termsNotice) {
      termsNotice.classList.toggle('hidden', !authModeRegister);
    }
    gsi.updateGooglePanelVisibility();
  }

  function resetAuthVerificationFlow() {
    authFlowVerify = false;
    authPendingEmail = '';
    var codeEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-verify-code'));
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
    var confirmInput = /** @type {HTMLInputElement} */ (document.getElementById('auth-password-confirm'));
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
    window.__stagifyPendingPlusRedirect = false;
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
    gsi.tryInitGoogleSignIn();
    onCloseDropdown();
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
    var verifyResend = /** @type {HTMLButtonElement} */ (document.getElementById('auth-verify-resend'));
    if (verifyResend) {
      verifyResend.addEventListener('click', async function () {
        var fb = document.getElementById('auth-verify-feedback');
        var emailEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-email'));
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
    var forgotSend = /** @type {HTMLButtonElement} */ (document.getElementById('auth-forgot-send'));
    if (forgotSend) {
      forgotSend.addEventListener('click', async function () {
        var fb = document.getElementById('auth-forgot-feedback');
        var emailEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-email'));
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
        var emailEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-email'));
        var passEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-password'));
        var confirmEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-password-confirm'));
        var email = emailEl ? emailEl.value.trim() : '';
        var password = passEl ? passEl.value : '';
        if (errEl) errEl.textContent = '';
        if (authModeRegister && authFlowVerify) {
          var codeEl = /** @type {HTMLInputElement} */ (document.getElementById('auth-verify-code'));
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
            var goPlusVerify = !!window.__stagifyPendingPlusRedirect;
            window.StagifyAuth.applyUserToUI();
            closeAuthModal();
            if (window.__stagifyPendingStaging) {
              window.__stagifyPendingStaging = false;
              var stageModal = document.getElementById('stage-modal');
              if (stageModal) stageModal.classList.remove('hidden');
            }
            onRefresh();
            if (goPlusVerify) {
              window.location.href = 'stagify-plus.html';
              return;
            }
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
          var goPlusLogin = !!window.__stagifyPendingPlusRedirect;
          window.StagifyAuth.applyUserToUI();
          closeAuthModal();
          if (window.__stagifyPendingStaging) {
            window.__stagifyPendingStaging = false;
            stageModal = document.getElementById('stage-modal');
            if (stageModal) stageModal.classList.remove('hidden');
          }
          onRefresh();
          if (goPlusLogin) {
            window.location.href = 'stagify-plus.html';
            return;
          }
        } catch (err) {
          if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
        }
      });
    }
    gsi.tryInitGoogleSignIn();
  }

  return {
    openAuthModal: openAuthModal,
    syncAuthFormMode: syncAuthFormMode,
    bindAuthOnce: bindAuthOnce,
    // Set the register/sign-in toggle without re-syncing (caller syncs next).
    setAuthModeRegister: function (v) {
      authModeRegister = !!v;
    },
    // External entry points reset the forgot-password flow and re-sync in one step.
    selectMode: function (v) {
      authModeRegister = !!v;
      authFlowForgot = false;
      syncAuthFormMode();
    },
    openForStaging: function () {
      authModeRegister = true;
      authFlowForgot = false;
      syncAuthFormMode();
      openAuthModal(true);
    },
    // Read by the dropdown's refresh() to hide the Stripe help button on staging.
    isStagingMode: gsi.isStagingMode,
  };
}
