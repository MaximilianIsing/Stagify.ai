      (function () {
        'use strict';
        var TOKEN_KEY = 'stagifyAuthToken';
        var statusEl = document.getElementById('gp-status');
        var form = document.getElementById('gp-form');
        var keyInput = document.getElementById('gp-key');
        var links = document.getElementById('gp-links');

        function getToken() {
          try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
        }

        // Read the admin key from the URL fragment (#key=...). Fragments are never
        // sent to the server, so they don't appear in access logs or Referer headers.
        function keyFromHash() {
          var h = location.hash || '';
          var m = /(?:^#|&)key=([^&]+)/.exec(h);
          return m ? decodeURIComponent(m[1]) : '';
        }

        // Drop the fragment so the secret doesn't linger in the address bar / history.
        function clearHash() {
          try { history.replaceState(null, '', location.pathname); } catch (e) {}
        }

        function setStatus(msg, cls) {
          statusEl.textContent = msg;
          statusEl.className = cls || '';
        }

        function grant(key) {
          var token = getToken();
          if (!token) {
            setStatus('Sign in on this site first, then reopen this link.', 'err');
            return;
          }
          setStatus('Activating…');
          fetch('/api/getpro', {
            method: 'POST',
            headers: {
              'X-Stagify-Endpoint-Key': key,
              Authorization: 'Bearer ' + token,
            },
          })
            .then(function (r) {
              return r.json().then(function (j) { return { ok: r.ok, body: j }; });
            })
            .then(function (res) {
              if (res.ok && res.body && res.body.ok) {
                setStatus('Your account now has Stagify+.', 'ok');
                form.style.display = 'none';
                links.style.display = 'block';
              } else {
                setStatus((res.body && res.body.error) || 'Activation failed.', 'err');
                form.style.display = 'flex';
              }
            })
            .catch(function () {
              setStatus('Network error. Please try again.', 'err');
              form.style.display = 'flex';
            });
        }

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var k = keyInput.value.trim();
          if (k) grant(k);
        });

        var hashKey = keyFromHash();
        clearHash();

        if (!getToken()) {
          setStatus('Sign in on this site first, then reopen this link.', 'err');
          return;
        }
        if (hashKey) {
          grant(hashKey);
        } else {
          setStatus('Enter your access key to activate Stagify+.');
          form.style.display = 'flex';
        }
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
