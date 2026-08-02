import { lang } from './dom-utils.js';
import { AUTH_MODAL_HTML } from './auth-modal-template.js';
import { createGoogleSignIn } from './google-signin.js';
import { localizedTarget } from '../i18n-routing.js';

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
  let AUTH_BOUND = false;
  let authModeRegister = true;
  let authFlowForgot = false;
  let authFlowVerify = false;
  let authPendingEmail = '';

  // Google Identity Services lives in its own island. It needs the modal's live
  // form mode (to hide its panel during forgot/verify) and a way to close the
  // modal on success; closeAuthModal is a hoisted declaration below.
  const gsi = createGoogleSignIn({
    getAuthFlow: () => ({ authModeRegister, authFlowForgot, authFlowVerify }),
    closeAuthModal: () => closeAuthModal(),
    onRefresh,
  });

  function ensureAuthModal() {
    if (document.getElementById('auth-modal')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = AUTH_MODAL_HTML;
    document.body.insertBefore(wrap.firstElementChild, document.body.firstChild);
  }

  // ── Element handles ─────────────────────────────────────────────────────────
  // The modal's markup is inserted once by ensureAuthModal() and then lives for
  // the page's lifetime, so the old code's ~20 getElementById calls per mode
  // toggle re-found the same nodes every time. They are resolved once here.
  //
  // The cache is keyed on the modal root: one lookup per access confirms the
  // cached handles still belong to the element currently in the document, so if
  // anything ever replaces the modal (a re-render, a test) the handles rebuild
  // instead of silently writing to a detached tree.
  /** @type {Record<string, any> | null} */
  let handles = null;

  /** Whatever had focus when the modal opened, so close() can hand it back. */
  /** @type {HTMLElement | null} */
  let authModalOpener = null;

  function els() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return null;
    if (handles && handles.modal === modal) return handles;
    const byId = (id) => document.getElementById(id);
    handles = {
      modal,
      backdrop: byId('auth-modal-backdrop'),
      closeBtn: byId('auth-modal-close'),
      title: byId('auth-modal-title'),
      sub: byId('auth-modal-sub'),
      error: byId('auth-error'),
      form: byId('auth-form'),
      email: /** @type {HTMLInputElement} */ (byId('auth-email')),
      password: byId('auth-password'),
      confirmRow: byId('auth-password-confirm-row'),
      confirmInput: /** @type {HTMLInputElement} */ (byId('auth-password-confirm')),
      standardPanel: byId('auth-standard-panel'),
      forgotPanel: byId('auth-forgot-panel'),
      verifyPanel: byId('auth-verify-panel'),
      submitRow: byId('auth-submit-row'),
      submitLabel: byId('auth-submit-label'),
      toggleLabel: byId('auth-toggle-label'),
      toggleBtn: byId('auth-mode-toggle'),
      termsNotice: byId('auth-terms-notice'),
      forgotLink: byId('auth-forgot-link'),
      forgotBack: byId('auth-forgot-back'),
      forgotSend: /** @type {HTMLButtonElement} */ (byId('auth-forgot-send')),
      forgotFeedback: byId('auth-forgot-feedback'),
      verifyCopy: byId('auth-verify-copy'),
      verifyCode: /** @type {HTMLInputElement} */ (byId('auth-verify-code')),
      verifyBack: byId('auth-verify-back'),
      verifyResend: /** @type {HTMLButtonElement} */ (byId('auth-verify-resend')),
      verifyFeedback: byId('auth-verify-feedback'),
      toggleRow: document.querySelector('#auth-modal .auth-toggle'),
    };
    return handles;
  }

  /** Clear a feedback line and its success/warn styling. */
  function clearFeedback(node) {
    if (!node) return;
    node.textContent = '';
    node.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
  }

  function refreshAuthModalLayout() {
    const e = els();
    if (!e || !e.standardPanel || !e.forgotPanel) return;

    if (authModeRegister && authFlowVerify) {
      e.standardPanel.classList.add('hidden');
      e.forgotPanel.classList.add('hidden');
      if (e.verifyPanel) e.verifyPanel.classList.remove('hidden');
      if (e.submitRow) e.submitRow.classList.remove('hidden');
      if (e.toggleRow) e.toggleRow.classList.add('hidden');
      if (e.sub) e.sub.classList.add('hidden');
      if (e.title) e.title.textContent = lang('auth.verifyTitle', 'Verify your email');
      if (e.email) e.email.readOnly = true;
      if (e.submitLabel) e.submitLabel.textContent = lang('auth.createAccount', 'Create account');
      if (e.verifyCopy) {
        e.verifyCopy.textContent = lang('auth.verifyCopy', 'Enter the 6-digit code we sent to {email}.', {
          email: authPendingEmail || lang('auth.yourEmail', 'your email'),
        });
      }
    } else if (authFlowForgot && !authModeRegister) {
      e.standardPanel.classList.add('hidden');
      e.forgotPanel.classList.remove('hidden');
      if (e.verifyPanel) e.verifyPanel.classList.add('hidden');
      if (e.submitRow) e.submitRow.classList.add('hidden');
      if (e.toggleRow) e.toggleRow.classList.add('hidden');
      if (e.sub) e.sub.classList.add('hidden');
      if (e.title) e.title.textContent = lang('auth.resetTitle', 'Reset password');
      if (e.email) e.email.readOnly = false;
    } else {
      e.forgotPanel.classList.add('hidden');
      e.standardPanel.classList.remove('hidden');
      if (e.verifyPanel) e.verifyPanel.classList.add('hidden');
      if (e.submitRow) e.submitRow.classList.remove('hidden');
      if (e.toggleRow) e.toggleRow.classList.remove('hidden');
      if (e.sub) e.sub.classList.remove('hidden');
      if (e.email) e.email.readOnly = false;
      clearFeedback(e.forgotFeedback);
      clearFeedback(e.verifyFeedback);
    }

    if (e.termsNotice) e.termsNotice.classList.toggle('hidden', !authModeRegister);
    gsi.updateGooglePanelVisibility();
  }

  function resetAuthVerificationFlow() {
    authFlowVerify = false;
    authPendingEmail = '';
    const e = els();
    if (!e) return;
    if (e.verifyCode) e.verifyCode.value = '';
    clearFeedback(e.verifyFeedback);
  }

  function syncAuthFormMode() {
    if (authModeRegister) {
      authFlowForgot = false;
    } else {
      resetAuthVerificationFlow();
    }
    const e = els();
    if (!e) return;

    if (authModeRegister) {
      if (e.title) e.title.textContent = lang('auth.registerTitle', 'Create your free account');
      if (e.sub) e.sub.textContent = lang('auth.registerSub', 'Sign up to upload and stage images.');
      if (e.submitLabel && !authFlowVerify) e.submitLabel.textContent = lang('auth.continue', 'Continue');
      if (e.toggleLabel) e.toggleLabel.textContent = lang('auth.alreadyHaveAccount', 'Already have an account?');
      if (e.toggleBtn) e.toggleBtn.textContent = lang('auth.signIn', 'Sign in');
      if (e.confirmRow) e.confirmRow.classList.remove('hidden');
      if (e.confirmInput) e.confirmInput.required = true;
      if (e.password) e.password.setAttribute('autocomplete', 'new-password');
    } else {
      if (e.title) e.title.textContent = lang('auth.signInTitle', 'Sign in');
      if (e.sub) e.sub.textContent = lang('auth.signInSub', 'Use your email and password to continue.');
      if (e.submitLabel) e.submitLabel.textContent = lang('auth.signIn', 'Sign in');
      if (e.toggleLabel) e.toggleLabel.textContent = lang('auth.newHere', 'New here?');
      if (e.toggleBtn) e.toggleBtn.textContent = lang('auth.createAccount', 'Create account');
      if (e.confirmRow) e.confirmRow.classList.add('hidden');
      if (e.confirmInput) {
        e.confirmInput.required = false;
        e.confirmInput.value = '';
      }
      if (e.password) e.password.setAttribute('autocomplete', 'current-password');
    }

    if (e.forgotLink) e.forgotLink.classList.toggle('hidden', authModeRegister);
    refreshAuthModalLayout();
  }

  function closeAuthModal() {
    const e = els();
    if (!e) return;
    e.modal.classList.add('hidden');
    e.modal.setAttribute('aria-hidden', 'true');
    window.__stagifyPendingStaging = false;
    window.__stagifyPendingPlusRedirect = false;
    resetAuthVerificationFlow();
    // Put focus back where it came from, guarded on isConnected: the opener can be
    // re-rendered while the modal is up, and focusing a detached node silently drops
    // focus to <body> — which is worse than leaving it alone.
    const opener = authModalOpener;
    authModalOpener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  }

  /**
   * Reveal the staging dialog the user was sent here from, if any.
   *
   * MUST be called with the flag read BEFORE closeAuthModal(), which clears both
   * pending flags. Reading `window.__stagifyPendingStaging` after the close — as
   * this did until 2026-07-28 — is always false, so signing in from "Stage this
   * photo" dropped the user back on the page with nothing open and no error. The
   * sibling `__stagifyPendingPlusRedirect` was already captured up-front for
   * exactly this reason; the staging flag just never got the same treatment.
   *
   * @param {boolean} wasPending Flag value captured before the modal was closed.
   */
  function resumePendingStaging(wasPending) {
    if (!wasPending) return;
    window.__stagifyPendingStaging = false;
    const stageModal = document.getElementById('stage-modal');
    if (stageModal) stageModal.classList.remove('hidden');
  }

  function openAuthModal(forStaging) {
    ensureAuthModal();
    bindAuthOnce();
    authFlowForgot = false;
    resetAuthVerificationFlow();
    if (forStaging) window.__stagifyPendingStaging = true;
    const e = els();
    if (!e) return;
    if (e.error) e.error.textContent = '';
    // Remember who opened it, so focus can go back there on close. Captured before
    // the modal is shown, while document.activeElement is still the trigger.
    authModalOpener = /** @type {HTMLElement|null} */ (document.activeElement);
    e.modal.classList.remove('hidden');
    e.modal.setAttribute('aria-hidden', 'false');
    syncAuthFormMode();
    gsi.tryInitGoogleSignIn();
    onCloseDropdown();
    // Move focus INTO the dialog, the same way ai-designer/mask-editor.js and the
    // Masking Studio's dialogs do. Without it, focus stayed on the button behind the
    // overlay: a screen reader never announced the dialog, and Tab walked the page
    // underneath it. This one is reached from "Upload image for free" while signed
    // out, so it is the first dialog many keyboard users meet.
    // The email field rather than the close button — it is what the user came to fill
    // in, and it is inside the dialog either way.
    const first = /** @type {HTMLElement|null} */ (e.email || e.closeBtn);
    if (first && typeof first.focus === 'function') first.focus();
  }

  /** Clear the modal-wide error line. */
  function clearError() {
    const e = els();
    if (e && e.error) e.error.textContent = '';
  }

  function bindAuthOnce() {
    if (AUTH_BOUND) return;
    if (!window.StagifyAuth) return;
    ensureAuthModal();
    AUTH_BOUND = true;

    const e = els();
    if (!e) return;

    if (e.backdrop) e.backdrop.addEventListener('click', closeAuthModal);
    if (e.closeBtn) e.closeBtn.addEventListener('click', closeAuthModal);

    // Escape closes it, like every other dialog in the app. Bound here (inside the
    // run-once guard) so it is attached exactly once for the page's lifetime, and it
    // checks the visible state rather than tracking its own flag — the modal is only
    // ever hidden via the `hidden` class.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const cur = els();
      if (!cur || cur.modal.classList.contains('hidden')) return;
      ev.preventDefault();
      closeAuthModal();
    });

    if (e.toggleBtn) {
      e.toggleBtn.addEventListener('click', () => {
        authModeRegister = !authModeRegister;
        authFlowForgot = false;
        resetAuthVerificationFlow();
        syncAuthFormMode();
        clearError();
      });
    }

    if (e.forgotLink) {
      e.forgotLink.addEventListener('click', () => {
        authFlowForgot = true;
        syncAuthFormMode();
        clearError();
      });
    }

    if (e.verifyBack) {
      e.verifyBack.addEventListener('click', () => {
        resetAuthVerificationFlow();
        syncAuthFormMode();
        clearError();
      });
    }

    if (e.verifyResend) {
      e.verifyResend.addEventListener('click', async () => {
        const fb = e.verifyFeedback;
        const email = authPendingEmail || (e.email ? e.email.value.trim() : '');
        clearFeedback(fb);
        if (!email) {
          if (fb) fb.textContent = lang('auth.enterEmail', 'Enter your email address.');
          return;
        }
        e.verifyResend.disabled = true;
        try {
          const r = await fetch('/api/auth/register/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = await r.json().catch(() => ({}));
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
        e.verifyResend.disabled = false;
      });
    }

    if (e.forgotBack) {
      e.forgotBack.addEventListener('click', () => {
        authFlowForgot = false;
        syncAuthFormMode();
        clearError();
      });
    }

    if (e.forgotSend) {
      e.forgotSend.addEventListener('click', async () => {
        const fb = e.forgotFeedback;
        const email = e.email ? e.email.value.trim() : '';
        if (fb) fb.textContent = '';
        if (!email) {
          if (fb) fb.textContent = lang('auth.enterEmail', 'Enter your email address.');
          return;
        }
        e.forgotSend.disabled = true;
        try {
          const r = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = await r.json().catch(() => ({}));
          if (fb) {
            fb.classList.remove('auth-forgot-feedback--success', 'auth-forgot-feedback--warn');
            if (!r.ok) {
              fb.textContent =
                data.error ||
                data.message ||
                lang('auth.resetSomethingWrong', 'Something went wrong. Please try again in a few minutes.');
              fb.classList.add('auth-forgot-feedback--warn');
            } else {
              // The server returns one neutral message whether or not the email
              // has an account (anti-enumeration), so we always show it as-is.
              fb.textContent =
                data.message ||
                lang('auth.resetLinkSent', 'If that email has an account, we sent a reset link. Check your inbox (and spam).');
              fb.classList.add('auth-forgot-feedback--success');
            }
          }
        } catch (err) {
          if (fb) fb.textContent = lang('auth.resetTryLater', 'Something went wrong. Try again later.');
        }
        e.forgotSend.disabled = false;
      });
    }

    if (e.form) e.form.addEventListener('submit', handleSubmit);

    gsi.tryInitGoogleSignIn();
  }

  /**
   * Finish a successful sign-in: store the session, refresh the UI, close the
   * modal, and resume whatever the user was doing when they were asked to sign in.
   *
   * Both pending flags are read BEFORE closeAuthModal() clears them.
   *
   * @param {string} token Session token from the auth endpoint.
   */
  async function completeSignIn(token) {
    window.StagifyAuth.setToken(token);
    await window.StagifyAuth.fetchMe();
    const goPlus = !!window.__stagifyPendingPlusRedirect;
    const wasPendingStaging = !!window.__stagifyPendingStaging;
    window.StagifyAuth.applyUserToUI();
    closeAuthModal();
    resumePendingStaging(wasPendingStaging);
    onRefresh();
    if (goPlus) window.location.href = localizedTarget('stagify-plus.html');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (authFlowForgot) return;

    const e = els();
    if (!e) return;
    const errEl = e.error;
    const email = e.email ? e.email.value.trim() : '';
    const password = /** @type {HTMLInputElement} */ (e.password)
      ? /** @type {HTMLInputElement} */ (e.password).value
      : '';
    if (errEl) errEl.textContent = '';

    if (authModeRegister && authFlowVerify) {
      const code = e.verifyCode ? e.verifyCode.value.trim() : '';
      if (!/^\d{6}$/.test(code)) {
        if (errEl) {
          errEl.textContent = lang('auth.enterVerificationCode', 'Enter the 6-digit verification code from your email.');
        }
        return;
      }
      try {
        const vr = await fetch('/api/auth/register/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code }),
        });
        const vdata = await vr.json();
        if (!vr.ok) {
          if (errEl) errEl.textContent = vdata.error || lang('auth.verificationFailed', 'Verification failed');
          return;
        }
        await completeSignIn(vdata.token);
      } catch (verr) {
        if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
      }
      return;
    }

    if (authModeRegister) {
      const confirmPass = e.confirmInput ? e.confirmInput.value : '';
      if (password !== confirmPass) {
        if (errEl) errEl.textContent = lang('auth.passwordsNoMatch', 'Passwords do not match.');
        return;
      }
    }

    const path = authModeRegister ? '/api/auth/register' : '/api/auth/login';
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (errEl) errEl.textContent = data.error || lang('auth.somethingWrong', 'Something went wrong');
        return;
      }
      if (authModeRegister && data.needsVerification) {
        authFlowVerify = true;
        authPendingEmail = email;
        refreshAuthModalLayout();
        if (e.verifyFeedback) {
          e.verifyFeedback.textContent =
            data.message || lang('auth.checkEmailForCode', 'Check your email for a verification code.');
          e.verifyFeedback.classList.add('auth-forgot-feedback--success');
        }
        return;
      }
      await completeSignIn(data.token);
    } catch (err) {
      if (errEl) errEl.textContent = lang('auth.networkError', 'Network error. Please try again.');
    }
  }

  return {
    openAuthModal,
    syncAuthFormMode,
    bindAuthOnce,
    // Set the register/sign-in toggle without re-syncing (caller syncs next).
    setAuthModeRegister(v) {
      authModeRegister = !!v;
    },
    // External entry points reset the forgot-password flow and re-sync in one step.
    selectMode(v) {
      authModeRegister = !!v;
      authFlowForgot = false;
      syncAuthFormMode();
    },
    openForStaging() {
      authModeRegister = true;
      authFlowForgot = false;
      syncAuthFormMode();
      openAuthModal(true);
    },
    // Read by the dropdown's refresh() to hide the Stripe help button on staging.
    isStagingMode: gsi.isStagingMode,
  };
}
