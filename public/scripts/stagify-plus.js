      (function () {
        var PAYMENT_LINK = 'https://buy.stripe.com/9B6cN5bC24w8aTG1Jf7EQ03';
        // On the staging site, block real Stripe checkout (set from /api/auth/config).
        var IS_STAGING = false;
        function applyStripeCheckout(user) {
          var hint = document.getElementById('plus-checkout-hint');
          var link = /** @type {HTMLAnchorElement} */ (document.getElementById('stagify-plus-checkout-link'));
          var manageWrap = document.getElementById('sp-manage-subscription-wrap');
          var manageBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sp-manage-subscription-btn'));
          if (!link) return;

          if (user && user.plan === 'pro') {
            link.removeAttribute('href');
            link.removeAttribute('target');
            link.removeAttribute('rel');
            link.setAttribute('tabindex', '-1');
            link.setAttribute('aria-disabled', 'true');
            link.classList.add('sp-gradient-checkout-btn--subscribed');
            link.innerHTML = '<strong>Subscribed ✓</strong>';
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
            link.setAttribute('tabindex', '-1');
            link.setAttribute('aria-disabled', 'true');
            link.classList.add('sp-gradient-checkout-btn--subscribed');
            link.innerHTML = '<strong>Unavailable on staging</strong>';
            if (hint) {
              hint.textContent = 'Subscriptions are disabled on the staging site.';
              hint.classList.remove('hidden');
            }
            if (manageWrap) manageWrap.classList.add('hidden');
            return;
          }

          link.removeAttribute('tabindex');
          link.removeAttribute('aria-disabled');
          link.classList.remove('sp-gradient-checkout-btn--subscribed');
          link.setAttribute('rel', 'noopener noreferrer');
          link.setAttribute('target', '_blank');
          link.innerHTML = '<strong>Start free trial</strong>';

          var url = PAYMENT_LINK;
          if (user && user.id) {
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
          } else {
            if (hint) {
              hint.textContent =
                'Tip: sign in from the profile menu first so checkout can link payment to your Stagify account.';
              hint.classList.remove('hidden');
            }
          }
          link.href = url;
          if (manageWrap) manageWrap.classList.add('hidden');
        }
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
          });
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
