      (function () {
        // ---- i18n helpers ------------------------------------------------------
        // Resolve a translation key via the shared language runtime, falling back
        // to the built-in English string until languages/<lang>.json has loaded.
        function t(key, fallback) {
          var ls = window.LanguageSystem;
          return (ls && typeof ls.getText === 'function') ? ls.getText(key, fallback) : fallback;
        }
        // Fill {name} placeholders in a template with values from `vars`.
        function interpolate(str, vars) {
          return String(str).replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m;
          });
        }

        var domainInput = /** @type {HTMLInputElement} */ (document.getElementById('ent-domain'));
        var hintEl = document.getElementById('ent-domain-hint');
        var form = document.getElementById('ent-form');
        var formCard = document.getElementById('ent-form-card');
        var successCard = document.getElementById('ent-success');
        var successLine = document.getElementById('ent-success-line');
        var errorEl = document.getElementById('ent-error');
        var submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('ent-submit-btn'));

        // Domain shown in the field hint — an example until the visitor types.
        function currentDomain() {
          var v = domainInput.value.trim().replace(/^@/, '').toLowerCase();
          return v || 'yourdomain.com';
        }
        function renderHint() {
          if (!hintEl) return;
          hintEl.textContent = interpolate(
            t('enterprise.form.domainHint', 'All emails ending in @{domain} will get Stagify+'),
            { domain: currentDomain() }
          );
        }

        // Success view (after the Stripe redirect) names the activated domain. The
        // {domain} token is split out so the styled span keeps working in any
        // language word order — and textContent keeps the URL param XSS-safe.
        var successDomainText = t('enterprise.success.yourDomain', 'your domain');
        function renderSuccessLine() {
          if (!successLine) return;
          var parts = String(
            t('enterprise.success.line', 'All accounts with emails ending in {domain} now have Stagify+ features.')
          ).split('{domain}');
          successLine.textContent = '';
          successLine.appendChild(document.createTextNode(parts[0]));
          var span = document.createElement('span');
          span.className = 'ent-success-domain';
          span.textContent = successDomainText;
          successLine.appendChild(span);
          successLine.appendChild(document.createTextNode(parts.length > 1 ? parts[1] : ''));
        }

        var params = new URLSearchParams(window.location.search);
        var isSuccess = params.get('success') === '1';
        var successDomainParam = params.get('domain');

        function refreshSuccessDomain() {
          successDomainText = successDomainParam
            ? '@' + decodeURIComponent(successDomainParam)
            : t('enterprise.success.yourDomain', 'your domain');
        }

        // Re-render the dynamic (JS-owned) copy whenever the visitor switches language.
        window.addEventListener('languagechange', function () {
          if (isSuccess) {
            refreshSuccessDomain();
            renderSuccessLine();
          } else {
            renderHint();
          }
        });

        if (isSuccess) {
          formCard.classList.add('hidden');
          successCard.classList.remove('hidden');
          refreshSuccessDomain();
          renderSuccessLine();
          return;
        }

        domainInput.addEventListener('input', renderHint);
        renderHint();

        function showError(msg) {
          errorEl.textContent = msg;
          errorEl.classList.remove('hidden');
        }
        function hideError() {
          errorEl.classList.add('hidden');
        }
        function resetSubmit() {
          submitBtn.disabled = false;
          submitBtn.textContent = t('enterprise.form.submit', 'Continue to payment');
        }

        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          hideError();

          var domain = domainInput.value.trim().replace(/^@/, '').toLowerCase();
          var company = /** @type {HTMLInputElement} */ (document.getElementById('ent-company')).value.trim();
          var email = /** @type {HTMLInputElement} */ (document.getElementById('ent-email')).value.trim();
          var phone = /** @type {HTMLInputElement} */ (document.getElementById('ent-phone')).value.trim();

          if (!domain || !domain.includes('.')) {
            showError(t('enterprise.errors.domain', 'Please enter a valid domain (e.g. company.com).'));
            return;
          }
          if (!company) {
            showError(t('enterprise.errors.company', 'Please enter your company name.'));
            return;
          }
          if (!email || !email.includes('@')) {
            showError(t('enterprise.errors.email', 'Please enter a valid contact email.'));
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = t('enterprise.form.redirecting', 'Redirecting to Stripe…');

          try {
            var res = await fetch('/api/enterprise/create-checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                domain: domain,
                companyName: company,
                contactEmail: email,
                contactPhone: phone,
              }),
            });
            var data = await res.json();
            if (!res.ok) {
              showError(data.error || t('enterprise.errors.generic', 'Something went wrong. Please try again.'));
              resetSubmit();
              return;
            }
            if (data.url) {
              window.location.href = data.url;
            } else {
              showError(t('enterprise.errors.unexpected', 'Unexpected response. Please try again.'));
              resetSubmit();
            }
          } catch (err) {
            showError(t('enterprise.errors.network', 'Network error. Please check your connection and try again.'));
            resetSubmit();
          }
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
