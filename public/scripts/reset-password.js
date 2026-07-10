      (function () {
        var params = new URLSearchParams(window.location.search);
        var token = params.get('token') || '';
        var form = document.getElementById('reset-form');
        var errEl = document.getElementById('reset-error');
        var okEl = document.getElementById('reset-success');
        var submitBtn = document.getElementById('reset-submit');
        if (!token) {
          if (errEl) errEl.textContent = 'Invalid or missing reset link. Request a new one from the sign-in screen.';
          if (form) form.style.display = 'none';
          return;
        }
        form.addEventListener('submit', async function (e) {
          e.preventDefault();
          var p1 = document.getElementById('reset-password').value;
          var p2 = document.getElementById('reset-password-confirm').value;
          if (errEl) errEl.textContent = '';
          if (okEl) okEl.textContent = '';
          if (p1 !== p2) {
            if (errEl) errEl.textContent = 'Passwords do not match.';
            return;
          }
          if (p1.length < 8) {
            if (errEl) errEl.textContent = 'Password must be at least 8 characters.';
            return;
          }
          submitBtn.disabled = true;
          try {
            var r = await fetch('/api/auth/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: token, password: p1 }),
            });
            var data = await r.json().catch(function () {
              return {};
            });
            if (!r.ok) {
              if (errEl) errEl.textContent = data.error || 'Could not reset password.';
              submitBtn.disabled = false;
              return;
            }
            if (okEl) okEl.textContent = 'Password updated. You can sign in now.';
            form.style.display = 'none';
          } catch (err) {
            if (errEl) errEl.textContent = 'Network error. Try again.';
            submitBtn.disabled = false;
          }
        });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
