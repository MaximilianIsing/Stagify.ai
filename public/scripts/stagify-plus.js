// Stripe-hosted Payment Link for the individual Stagify+ plan (no server-side
// Checkout Session — the webhook upgrades the account on checkout.session.completed).
// Its "After payment" redirect is configured in the Stripe dashboard to land the
// buyer on /plus-welcome.html, which is also the Google Ads conversion page. Keep
// that page in sync if this flow changes (guarded by test/frontend/plus-welcome.test.js).
//
// WHY THE SIGNED-OUT BUTTON DOES NOT REACH STRIPE
// The only thing that reliably maps a completed checkout onto an account is the
// `client_reference_id` appended below, and a signed-out visitor has no id to append.
// The button used to stay live anyway, so a checkout with no reference reached
// activateProFromStripeCheckout() with nothing but whatever email the buyer typed at
// Stripe — and if that address matched no account (the ordinary case for someone who
// found the pricing page before ever signing up) the result was `no_user`: money in,
// no plan, one logger.warn. So the signed-out CTA now opens the sign-up modal instead,
// and checkout is only reachable once there is an id to attach.
var PAYMENT_LINK = 'https://buy.stripe.com/9B6cN5bC24w8aTG1Jf7EQ03';
// On the staging site, block real Stripe checkout (set from /api/auth/config).
var IS_STAGING = false;
// Last user state applied, so a mid-session language switch can re-render the
// JS-managed checkout button + hint in the new language.
var currentUser = null;
// True while the button is standing in for checkout as a "create an account" CTA.
// The handler is bound once PER ELEMENT (see BOUND_FLAG) and reads this, so re-renders
// — language switch, auth refresh — cannot stack duplicate listeners, and the handler
// still no-ops if a later render hands the button back to Stripe.
var needsAccount = false;
var BOUND_FLAG = '__stagifyPlusCtaBound';

// Survives the sign-up page reload so we can put the buyer back on the button they
// came for. Only a focus cue — the Stripe link is deliberately NOT opened for them,
// because after a reload that is not a user gesture and popup blockers eat it.
var INTENT_KEY = 'stagify:plus-checkout-intent';

/** @param {string} key @returns {string | null} */
function readIntent(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch (_e) {
    return null;
  }
}

/** @param {string} key @param {string | null} value */
function writeIntent(key, value) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch (_e) {
    /* private mode / storage disabled — the cue is optional, the gate is not */
  }
}

// Resolve a translation key via the shared language runtime, falling back to
// the built-in English string until languages/<lang>.json has loaded.
function t(key, fallback) {
  var ls = window.LanguageSystem;
  return (ls && typeof ls.getText === 'function') ? ls.getText(key, fallback) : fallback;
}

/**
 * The profile-menu island, but only if it can actually raise the auth modal.
 * profile-menu.js injects the modal markup on every page that loads it, so this is
 * normally present — but if it failed to load, a button that can neither check out
 * nor sign anybody up is worse than an unmapped checkout, so callers fall back to
 * the plain payment link.
 * @returns {any | null}
 */
function authModalHost() {
  var pm = window.StagifyProfileMenu;
  return pm && typeof pm.openAuthModal === 'function' ? pm : null;
}

/**
 * Signed-out click on "Start free trial": ask for an account first.
 * Sets the same `__stagifyPendingPlusRedirect` flag public/scripts/plus-cta-auth.js
 * uses on the homepage, which both sign-in paths already resume by navigating to
 * stagify-plus.html (profile-menu/auth-modal.js, profile-menu/google-signin.js).
 * Here that is a same-URL reload, which re-runs applyStripeCheckout() with a real
 * user and renders the properly linked button.
 * @param {Event} e
 */
function onCheckoutActivate(e) {
  if (!needsAccount) return; // signed in / pro / staging — the anchor speaks for itself
  var pm = authModalHost();
  if (!pm) return;
  e.preventDefault();
  window.__stagifyPendingPlusRedirect = true;
  writeIntent(INTENT_KEY, '1');
  if (typeof pm.setAuthModeRegister === 'function') pm.setAuthModeRegister(true);
  pm.openAuthModal(false);
}

/** @param {KeyboardEvent} e */
function onCheckoutKeydown(e) {
  if (!needsAccount) return;
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  onCheckoutActivate(e);
}

/**
 * Render the checkout button + hint for the current viewer.
 * @param {any} user The signed-in user from StagifyAuth, or null when signed out.
 */
export function applyStripeCheckout(user) {
  currentUser = user;
  var hint = document.getElementById('plus-checkout-hint');
  var link = /** @type {HTMLAnchorElement} */ (document.getElementById('stagify-plus-checkout-link'));
  var manageWrap = document.getElementById('sp-manage-subscription-wrap');
  var manageBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sp-manage-subscription-btn'));
  if (!link) return;

  needsAccount = false;

  if (user && user.plan === 'pro') {
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.removeAttribute('role');
    link.setAttribute('tabindex', '-1');
    link.setAttribute('aria-disabled', 'true');
    link.classList.add('sp-gradient-checkout-btn--subscribed');
    link.innerHTML = '<strong>' + t('stagifyPlus.plan.subscribed', 'Subscribed ✓') + '</strong>';
    if (hint) {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
    if (manageWrap && manageBtn) {
      if (user.canManageSubscription) {
        manageWrap.classList.remove('hidden');
        manageBtn.disabled = false;
      } else {
        manageWrap.classList.add('hidden');
      }
    }
    return;
  }

  // Staging site: block the subscribe button — no real Stripe checkout.
  if (IS_STAGING) {
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.removeAttribute('role');
    link.setAttribute('tabindex', '-1');
    link.setAttribute('aria-disabled', 'true');
    link.classList.add('sp-gradient-checkout-btn--subscribed');
    link.innerHTML = '<strong>' + t('stagifyPlus.plan.unavailableStaging', 'Unavailable on staging') + '</strong>';
    if (hint) {
      hint.textContent = t('stagifyPlus.plan.hintStagingDisabled', 'Subscriptions are disabled on the staging site.');
      hint.classList.remove('hidden');
    }
    if (manageWrap) manageWrap.classList.add('hidden');
    return;
  }

  link.removeAttribute('tabindex');
  link.removeAttribute('aria-disabled');
  link.classList.remove('sp-gradient-checkout-btn--subscribed');
  link.innerHTML = '<strong>' + t('stagifyPlus.plan.startTrial', 'Start free trial') + '</strong>';

  var signedIn = !!(user && user.id);
  var pm = signedIn ? null : authModalHost();

  if (!signedIn && pm) {
    // No id to attach — send them to sign-up rather than to an unmappable checkout.
    // Deliberately NOT aria-disabled: the control still acts, it just acts on the
    // sign-up modal. (Same call as the locked Staging rows, which navigate.)
    needsAccount = true;
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.setAttribute('role', 'button');
    link.setAttribute('tabindex', '0');
    if (!link[BOUND_FLAG]) {
      link.addEventListener('click', onCheckoutActivate);
      link.addEventListener('keydown', /** @type {EventListener} */ (onCheckoutKeydown));
      link[BOUND_FLAG] = true;
    }
    if (hint) {
      hint.textContent = t(
        'stagifyPlus.plan.hintAccountFirst',
        "Create a free account first. That’s how your subscription gets linked to you."
      );
      hint.classList.remove('hidden');
    }
    if (manageWrap) manageWrap.classList.add('hidden');
    return;
  }

  link.setAttribute('rel', 'noopener noreferrer');
  link.setAttribute('target', '_blank');
  link.removeAttribute('role');

  var url = PAYMENT_LINK;
  if (signedIn) {
    if (hint) {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    if (user.email) {
      url += sep + 'prefilled_email=' + encodeURIComponent(user.email);
      sep = '&';
    }
    url += sep + 'client_reference_id=' + encodeURIComponent(user.id);
  } else if (hint) {
    // No profile menu to sign them up with — the plain payment link is the least-bad
    // fallback, so keep the old "sign in first" advice rather than a dead button.
    hint.textContent = t(
      'stagifyPlus.plan.hintTip',
      'Tip: sign in from the profile menu first so checkout can link payment to your Stagify account.'
    );
    hint.classList.remove('hidden');
  }
  link.href = url;
  if (manageWrap) manageWrap.classList.add('hidden');
}

/**
 * After the sign-up reload, put the buyer back on the button they came for.
 * @param {any} user
 */
function resumeCheckoutIntent(user) {
  if (!readIntent(INTENT_KEY)) return;
  writeIntent(INTENT_KEY, null);
  if (!user || !user.id) return; // they backed out of sign-up — leave them be
  var link = document.getElementById('stagify-plus-checkout-link');
  if (!link) return;
  if (typeof link.scrollIntoView === 'function') {
    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (typeof link.focus === 'function') link.focus();
}

// Re-render the JS-managed button + hint when the visitor switches language.
window.addEventListener('languagechange', function () {
  applyStripeCheckout(currentUser);
});

document.addEventListener('DOMContentLoaded', function () {
  var manageBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sp-manage-subscription-btn'));
  if (manageBtn && window.StagifyAuth && typeof window.StagifyAuth.openBillingPortal === 'function') {
    manageBtn.addEventListener('click', function () {
      manageBtn.disabled = true;
      window.StagifyAuth.openBillingPortal().finally(function () {
        manageBtn.disabled = false;
      });
    });
  }
  if (!window.StagifyAuth) {
    applyStripeCheckout(null);
    return;
  }
  var cfgP =
    typeof window.StagifyAuth.fetchConfig === 'function'
      ? window.StagifyAuth.fetchConfig()
      : Promise.resolve({});
  Promise.all([cfgP, window.StagifyAuth.fetchMe()]).then(function (res) {
    IS_STAGING = !!(res[0] && res[0].isStaging);
    applyStripeCheckout(window.StagifyAuth.user);
    resumeCheckoutIntent(window.StagifyAuth.user);
  });
});
