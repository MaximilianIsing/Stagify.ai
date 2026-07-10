      (function () {
        var domainInput = /** @type {HTMLInputElement} */ (document.getElementById('ent-domain'));
        var preview = document.getElementById('ent-domain-preview');
        var form = document.getElementById('ent-form');
        var formCard = document.getElementById('ent-form-card');
        var successCard = document.getElementById('ent-success');
        var successDomain = document.getElementById('ent-success-domain');
        var errorEl = document.getElementById('ent-error');
        var submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('ent-submit-btn'));

        var params = new URLSearchParams(window.location.search);
        if (params.get('success') === '1') {
          formCard.classList.add('hidden');
          successCard.classList.remove('hidden');
          var d = params.get('domain');
          if (d) successDomain.textContent = '@' + decodeURIComponent(d);
          return;
        }

        domainInput.addEventListener('input', function () {
          var v = domainInput.value.trim().replace(/^@/, '').toLowerCase();
          preview.textContent = v || 'yourdomain.com';
        });

        function showError(msg) {
          errorEl.textContent = msg;
          errorEl.classList.remove('hidden');
        }
        function hideError() {
          errorEl.classList.add('hidden');
        }

        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          hideError();

          var domain = domainInput.value.trim().replace(/^@/, '').toLowerCase();
          var company = /** @type {HTMLInputElement} */ (document.getElementById('ent-company')).value.trim();
          var email = /** @type {HTMLInputElement} */ (document.getElementById('ent-email')).value.trim();
          var phone = /** @type {HTMLInputElement} */ (document.getElementById('ent-phone')).value.trim();

          if (!domain || !domain.includes('.')) {
            showError('Please enter a valid domain (e.g. company.com).');
            return;
          }
          if (!company) {
            showError('Please enter your company name.');
            return;
          }
          if (!email || !email.includes('@')) {
            showError('Please enter a valid contact email.');
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = 'Redirecting to Stripe…';

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
              showError(data.error || 'Something went wrong. Please try again.');
              submitBtn.disabled = false;
              submitBtn.textContent = 'Continue to payment';
              return;
            }
            if (data.url) {
              window.location.href = data.url;
            } else {
              showError('Unexpected response. Please try again.');
              submitBtn.disabled = false;
              submitBtn.textContent = 'Continue to payment';
            }
          } catch (err) {
            showError('Network error. Please check your connection and try again.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Continue to payment';
          }
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
