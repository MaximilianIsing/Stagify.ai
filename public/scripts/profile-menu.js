import { createAuthModal } from './profile-menu/auth-modal.js';
import { createReportIssueModal } from './profile-menu/report-issue-modal.js';
import { lang, esc } from './profile-menu/dom-utils.js';
import { stagifyApiRowHtml } from './profile-menu/api-keys-row.js';

(function () {
  let dropdownOpen = false;
  // Stripe Customer Portal login (Dashboard → Customer portal → link).
  const STRIPE_CUSTOMER_PORTAL_LOGIN =
    'https://billing.stripe.com/p/login/5kQ4gz35w3s42na1Jf7EQ00';
  const PORTAL_STRIPE_ICON =
    '<img src="media-webp/Stripe.webp" alt="" aria-hidden="true">';

  // The auth modal is its own island; it calls back here to refresh/close the
  // dropdown. Both callbacks are hoisted function declarations below.
  const auth = createAuthModal({ onRefresh: refresh, onCloseDropdown: closeDropdown });

  // The bug channel's site-wide entry point. It used to exist only inside the AI
  // Designer, so a problem anywhere else — the home page's staging flow, checkout,
  // the Masking Studio — had nowhere to go. Its own island; this file only opens it.
  const reportIssue = createReportIssueModal({ onCloseDropdown: closeDropdown });

  // The API row used to be gated on an answer only the server has (does this account
  // actually have a key or credits?), fetched lazily on first open. That gating is gone:
  // the single "Stagify API" row below goes to the dashboard for every signed-in visitor,
  // so there is nothing left for the summary to decide and the request would be spent
  // per menu-open on an answer nobody reads. createApiSummary is still exported from
  // api-keys-row.js — see the note there.

  function closeDropdown() {
    const dd = document.getElementById('profile-menu-dropdown');
    const btn = document.getElementById('profile-menu-btn');
    dropdownOpen = false;
    if (dd) {
      dd.classList.add('hidden');
      dd.setAttribute('aria-hidden', 'true');
    }
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function openDropdown() {
    const dd = document.getElementById('profile-menu-dropdown');
    const btn = document.getElementById('profile-menu-btn');
    if (!dd || !btn) return;
    // One synchronous render, and no second pass: every row the menu builds is decided
    // from state already in hand. The API row used to force a re-render here once
    // /api/api-credits answered, which is why this used to be two steps.
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
    const dd = document.getElementById('profile-menu-dropdown');
    if (!dd || !window.StagifyAuth) return;

    const u = window.StagifyAuth.user;
    const tok = window.StagifyAuth.getToken();

    if (!tok || !u) {
      dd.classList.add('profile-menu-dropdown--guest');
      dd.innerHTML =
        '<div class="profile-menu__section">' +
        '<button type="button" class="profile-menu__item" data-profile-action="signin">' +
        esc(lang('profile.signIn', 'Sign in')) +
        '</button>' +
        '<button type="button" class="profile-menu__item" data-profile-action="signup">' +
        esc(lang('profile.createAccount', 'Create account')) +
        '</button>' +
        '</div>';
    } else {
      dd.classList.remove('profile-menu-dropdown--guest');
      let planLine;
      if (u.plan === 'pro') {
        // The "Stripe help center" button is hidden on the staging site, and from
        // enterprise seats: their access is billed to the org's domain, so the portal
        // login would only ever tell them their email is unknown. (`manageRow` below
        // gates on canManageSubscription instead, which is a stricter test — it also
        // requires a stripeCustomerId — so it can legitimately still appear for a seat
        // whose own past subscription left a customer behind.)
        const portalHelp = auth.isStagingMode() || u.enterprise
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
        // Enterprise seats are pro accounts granted by their email domain, so the
        // badge keeps saying "Stagify+" — same plan, same entitlements — and only
        // swaps the mark for the Enterprise one. `u.enterprise` rides along on the
        // /api/auth/me payload (lib/data/auth-store.js publicUser).
        const planMark = u.enterprise
          ? 'media-webp/logo/Enterprise32x32.webp'
          : 'media-webp/logo/Pro32x32.webp';
        planLine =
          '<div class="profile-menu__plan-row">' +
          '<a href="stagify-plus.html" class="profile-menu__plan profile-menu__plan--plus">' +
          '<img src="' + planMark + '" alt="" width="18" height="18" aria-hidden="true"> Stagify+</a>' +
          portalHelp +
          '</div>';
      } else {
        planLine = '<div class="profile-menu__plan">' + esc(lang('profile.freePlan', 'Free Plan')) + '</div>';
      }
      let plusRow = '';
      if (u.plan !== 'pro') {
        plusRow =
          '<a href="stagify-plus.html" class="profile-menu__link profile-menu__link--plus">' +
          '<img src="media-webp/logo/Pro32x32.webp" alt="" width="20" height="20" aria-hidden="true"> ' +
          esc(lang('profile.upgradeToPlus', 'Upgrade to Stagify+')) +
          '</a>';
      }
      // NOTE: the gallery is deliberately NOT listed here. It has its own top-level nav
      // tab (between Staging and Guides, on every nav-bearing page), and an account-menu
      // entry pointing at the same page one row away from that tab is noise. If it ever
      // moves back, the string was `profile.yourGallery`, removed from the eleven packs
      // in the same commit.
      let manageRow = '';
      if (u.plan === 'pro' && u.canManageSubscription) {
        manageRow =
          '<button type="button" class="profile-menu__item" data-profile-action="manage-subscription">' +
          esc(lang('profile.manageSubscription', 'Manage subscription')) +
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
        // Directly above Sign out: the last thing in the menu that is not leaving it.
        '<button type="button" class="profile-menu__item" data-profile-action="report-issue">' +
        esc(lang('profile.reportIssue', 'Report an issue')) +
        '</button>' +
        // The ONE API row, and it goes to the dashboard (api-keys.html) for every
        // signed-in visitor. There used to be a second, use-gated "API keys & credits"
        // row above; both would now point at the same page, so it is no longer rendered.
        stagifyApiRowHtml(lang, esc) +
        '<button type="button" class="profile-menu__item profile-menu__item--danger" data-profile-action="signout">' +
        esc(lang('profile.signOut', 'Sign out')) +
        '</button>' +
        '</div>';
    }
  }

  function onDropdownClick(e) {
    const t = e.target.closest('[data-profile-action]');
    if (!t) return;
    const action = t.getAttribute('data-profile-action');
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
    if (action === 'report-issue') {
      e.preventDefault();
      // Focus comes back to the account button, not to `t`: opening the dialog closes
      // this dropdown, and a hidden row cannot take focus — it would land on <body>.
      reportIssue.open(document.getElementById('profile-menu-btn'));
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
      const tok = window.StagifyAuth.getToken();
      if (tok) {
        fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authToken: tok }),
        }).catch(() => {});
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

  let docBound = false;

  function init() {
    if (!document.getElementById('profile-menu-btn')) return;
    auth.bindAuthOnce();
    if (document.getElementById('auth-modal')) {
      auth.syncAuthFormMode();
    }
    const btn = document.getElementById('profile-menu-btn');
    const dd = document.getElementById('profile-menu-dropdown');
    btn.addEventListener('click', toggleDropdown);
    if (dd) dd.addEventListener('click', onDropdownClick);
    if (!docBound) {
      docBound = true;
      document.addEventListener('click', onDocClick);
    }

    if (window.StagifyAuth) {
      window.StagifyAuth.fetchMe().then(() => {
        window.StagifyAuth.applyUserToUI();
        refresh();
      });
    }
  }

  window.StagifyProfileMenu = {
    openAuthModal: auth.openAuthModal,
    refresh,
    closeDropdown,
    setAuthModeRegister(v) {
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

  window.addEventListener('languagechange', () => {
    auth.syncAuthFormMode();
    refresh();
  });
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
