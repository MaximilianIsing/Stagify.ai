import { createAuthModal } from './profile-menu/auth-modal.js';
import { lang, esc } from './profile-menu/dom-utils.js';

(function () {
  var dropdownOpen = false;
  // Stripe Customer Portal login (Dashboard → Customer portal → link).
  var STRIPE_CUSTOMER_PORTAL_LOGIN =
    'https://billing.stripe.com/p/login/5kQ4gz35w3s42na1Jf7EQ00';
  var PORTAL_STRIPE_ICON =
    '<img src="media-webp/Stripe.webp" alt="" aria-hidden="true">';

  // The auth modal is its own island; it calls back here to refresh/close the
  // dropdown. Both callbacks are hoisted function declarations below.
  var auth = createAuthModal({ onRefresh: refresh, onCloseDropdown: closeDropdown });

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
      var planLine;
      if (u.plan === 'pro') {
        // The "Stripe help center" button is hidden on the staging site.
        var portalHelp = auth.isStagingMode()
          ? ''
          : '<a class="profile-menu__portal-help" href="' +
            STRIPE_CUSTOMER_PORTAL_LOGIN +
            '" target="_blank" rel="noopener noreferrer" title="' +
            esc(lang('profile.stripeHelp', 'Stripe help center')) +
            '" aria-label="' +
            esc(lang('profile.manageBillingAria', 'Manage billing in Stripe')) +
            '">' +
            PORTAL_STRIPE_ICON +
            '</a>';
        planLine =
          '<div class="profile-menu__plan-row">' +
          '<a href="stagify-plus.html" class="profile-menu__plan profile-menu__plan--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="18" height="18" aria-hidden="true"> Stagify+</a>' +
          portalHelp +
          '</div>';
      } else {
        planLine = '<div class="profile-menu__plan">' + lang('profile.freePlan', 'Free Plan') + '</div>';
      }
      var plusRow = '';
      if (u.plan !== 'pro') {
        plusRow =
          '<a href="stagify-plus.html" class="profile-menu__link profile-menu__link--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="20" height="20" aria-hidden="true"> ' +
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
      auth.setAuthModeRegister(false);
      auth.syncAuthFormMode();
      closeDropdown();
      auth.openAuthModal(false);
      return;
    }
    if (action === 'signup') {
      auth.setAuthModeRegister(true);
      auth.syncAuthFormMode();
      closeDropdown();
      auth.openAuthModal(false);
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
    auth.bindAuthOnce();
    if (document.getElementById('auth-modal')) {
      auth.syncAuthFormMode();
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
    openAuthModal: auth.openAuthModal,
    refresh: refresh,
    closeDropdown: closeDropdown,
    setAuthModeRegister: function (v) {
      auth.selectMode(v);
    },
  };

  window.__stagifyOpenAuthForStaging = function () {
    auth.openForStaging();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('languagechange', function () {
    auth.syncAuthFormMode();
    refresh();
  });
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
