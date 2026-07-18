import { lang } from './dom-utils.js';
import { localizedTarget } from '../i18n-routing.js';

/* global google */ // Google Identity Services, loaded from accounts.google.com

/**
 * Google Identity Services sign-in for the auth modal: owns the GIS config/script
 * lifecycle and the "or continue with Google" panel. Reads the modal's live form
 * mode via getAuthFlow (to hide the panel during forgot-password / verify), and
 * closes the modal + refreshes the dropdown on a successful sign-in.
 *
 * @param {object} deps
 * @param {() => {authModeRegister: boolean, authFlowForgot: boolean, authFlowVerify: boolean}} deps.getAuthFlow
 * @param {() => void} deps.closeAuthModal Close the auth modal after a successful Google sign-in.
 * @param {() => void} deps.onRefresh      Re-render the profile dropdown.
 */
export function createGoogleSignIn({ getAuthFlow, closeAuthModal, onRefresh }) {
  var GOOGLE_AUTH_INITIALIZED = false;
  var googleOAuthConfig = { loaded: false, clientId: '' };
  var googleSignInFetchInFlight = false;
  // Staging site: hide the "Stripe help center" button in the pro menu. Set from
  // /api/auth/config when it loads; the dropdown re-renders so it takes effect.
  var isStagingMode = false;

  function updateGooglePanelVisibility() {
    var flow = getAuthFlow();
    var gp = document.getElementById('auth-google-panel');
    if (!gp) return;
    var show =
      googleOAuthConfig.loaded &&
      googleOAuthConfig.clientId &&
      !(flow.authFlowForgot && !flow.authModeRegister) &&
      !(flow.authModeRegister && flow.authFlowVerify);
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
        var goPlus = !!window.__stagifyPendingPlusRedirect;
        window.StagifyAuth.applyUserToUI();
        closeAuthModal();
        if (window.__stagifyPendingStaging) {
          window.__stagifyPendingStaging = false;
          var stageModal = document.getElementById('stage-modal');
          if (stageModal) stageModal.classList.remove('hidden');
        }
        onRefresh();
        if (goPlus) {
          window.location.href = localizedTarget('stagify-plus.html');
          return;
        }
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
    var cfgPromise =
      window.StagifyAuth && typeof window.StagifyAuth.fetchConfig === 'function'
        ? window.StagifyAuth.fetchConfig()
        : fetch('/api/auth/config').then(function (r) {
            return r.json();
          });
    cfgPromise
      .then(function (cfg) {
        googleOAuthConfig.loaded = true;
        // Staging: hide the "Stripe help center" button by re-rendering the menu.
        isStagingMode = !!(cfg && cfg.isStaging);
        if (isStagingMode) onRefresh();
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

  return {
    updateGooglePanelVisibility: updateGooglePanelVisibility,
    tryInitGoogleSignIn: tryInitGoogleSignIn,
    // Read by the dropdown's refresh() to hide the Stripe help button on staging.
    isStagingMode: function () {
      return isStagingMode;
    },
  };
}
