// Admin "Emails" tab — a gallery that previews every email a user can receive, plus
// a per-template "Send test" button that mails a live copy to the operator's own
// address. Kept out of renderers.js so that file stays under its line cap.
//
// Data comes from GET /api/admin/email-previews (built server-side from the SAME
// renderers the real senders use, so a preview is faithful). Each preview HTML is
// shown inside a sandboxed <iframe srcdoc> so the email's own styles are isolated
// from the dashboard and no script in the markup can run. Test sends go to
// POST /api/admin/email-test-send.

import { qs, el } from './helpers.js';

/**
 * Build the Emails-tab controller.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 *   Mutating/JSON request helper from the entry (holds the session key). Used for
 *   both the GET preview fetch and the POST test-send.
 */
export function createEmailsPanel({ apiSend }) {
  var _loaded = false;
  var _loading = false;
  var _recipient = '';
  /** @type {HTMLButtonElement[]} */
  var _sendButtons = [];

  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
  }

  // Enable/disable every card's Send button based on the shared recipient input.
  function refreshSendButtons() {
    var ok = validEmail(_recipient);
    _sendButtons.forEach(function (b) { b.disabled = !ok; });
    var hint = qs('#adm-email-test-hint');
    if (hint) {
      hint.textContent = ok
        ? 'Test sends will go to ' + _recipient.trim() + '.'
        : 'Enter your email above to enable test sends.';
    }
  }

  // Wrap the raw email HTML in a minimal white-background document so bare-markup
  // emails (the account emails) don't show the dark dashboard through the iframe,
  // and so emoji render with an explicit charset. Preview-only chrome.
  function frameDoc(html) {
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
      // flow-root, so a first child with a top margin cannot collapse it through
      // <body> — that collapse is what made the measured height come up short.
      '<body style="margin:0;background:#ffffff;display:flow-root">' + html + '</body></html>';
  }

  function card(email) {
    var c = el('div', { className: 'adm-email-card' });

    var head = el('div', { className: 'adm-email-card__head' });
    head.appendChild(el('span', { className: 'adm-email-cat', textContent: email.category || 'Email' }));
    head.appendChild(el('h3', { className: 'adm-email-card__title', textContent: email.label || email.id }));
    if (email.description) {
      head.appendChild(el('p', { className: 'adm-email-card__desc', textContent: email.description }));
    }
    head.appendChild(el('p', {
      className: 'adm-email-card__subject',
      textContent: 'Subject: ' + (email.subject || ''),
    }));
    c.appendChild(head);

    // Sandboxed preview. allow-same-origin (WITHOUT allow-scripts) lets us auto-size
    // to the content while still preventing any script in the markup from running.
    var frame = /** @type {HTMLIFrameElement} */ (el('iframe', {
      className: 'adm-email-frame',
      sandbox: 'allow-same-origin',
      loading: 'lazy',
      title: 'Preview: ' + (email.label || email.id),
    }));
    frame.setAttribute('srcdoc', frameDoc(email.html || ''));
    frame.addEventListener('load', function () {
      try {
        var doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        var fit = function () {
          // body, not documentElement: documentElement.scrollHeight is floored at
          // the iframe's own height, so measuring it lets the frame grow and never
          // shrink — every preview then sits at the CSS default with dead space
          // under a two-line email. frameDoc's `display:flow-root` is what makes
          // the body measurement trustworthy.
          var h = Math.min(900, Math.max(120, doc.body.scrollHeight + 8));
          frame.style.height = h + 'px';
        };
        fit();
        // A first measurement can only see what has loaded. Logos and webfont
        // metrics land after it, so re-fit as the document settles rather than
        // freezing the height at whatever the first frame happened to be.
        if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(doc.body);
        var imgs = doc.images || [];
        for (var i = 0; i < imgs.length; i++) {
          if (!imgs[i].complete) imgs[i].addEventListener('load', fit, { once: true });
        }
      } catch (e) { /* opaque frame — keep the CSS default height */ }
    });
    c.appendChild(frame);

    var foot = el('div', { className: 'adm-email-card__foot' });
    var btn = /** @type {HTMLButtonElement} */ (el('button', {
      className: 'adm-email-send-btn', type: 'button', textContent: 'Send test',
    }));
    btn.disabled = !validEmail(_recipient);
    var msg = el('span', { className: 'adm-email-send-msg' });
    btn.addEventListener('click', function () {
      var to = _recipient.trim();
      if (!validEmail(to)) return;
      btn.disabled = true; btn.textContent = 'Sending…';
      msg.textContent = ''; msg.className = 'adm-email-send-msg';
      apiSend('/api/admin/email-test-send', 'POST', { id: email.id, email: to }).then(function () {
        btn.textContent = 'Send test';
        msg.className = 'adm-email-send-msg adm-email-send-msg--ok';
        msg.textContent = '✓ Sent to ' + to;
        refreshSendButtons();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Send test';
        msg.className = 'adm-email-send-msg adm-email-send-msg--err';
        msg.textContent = 'Failed: ' + (e && e.message ? e.message : 'send error');
      });
    });
    _sendButtons.push(btn);
    foot.appendChild(btn);
    foot.appendChild(msg);
    c.appendChild(foot);

    return c;
  }

  function render(emails) {
    var gallery = qs('#adm-email-gallery');
    if (!gallery) return;
    gallery.innerHTML = '';
    _sendButtons = [];
    if (!emails || !emails.length) {
      gallery.appendChild(el('div', { className: 'adm-detail-empty', textContent: 'No email templates found.' }));
      return;
    }
    emails.forEach(function (email) { gallery.appendChild(card(email)); });
    refreshSendButtons();
  }

  // Lazy load: the gallery is only fetched the first time the tab is opened.
  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var gallery = qs('#adm-email-gallery');
    if (gallery) gallery.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    apiSend('/api/admin/email-previews', 'GET').then(function (j) {
      _loaded = true; _loading = false;
      render((j && j.emails) || []);
    }).catch(function (e) {
      _loading = false;
      if (gallery) {
        gallery.innerHTML = '';
        gallery.appendChild(el('div', { className: 'adm-host-err', textContent: 'Could not load email previews: ' + (e && e.message ? e.message : 'error') }));
      }
    });
  }

  // Reset on sign-out so a later re-login refetches with the new session key.
  function reset() {
    _loaded = false; _loading = false; _sendButtons = [];
    var gallery = qs('#adm-email-gallery');
    if (gallery) gallery.innerHTML = '';
  }

  function init() {
    var input = /** @type {HTMLInputElement} */ (qs('#adm-email-test-to'));
    if (input) {
      input.addEventListener('input', function () {
        _recipient = input.value || '';
        refreshSendButtons();
      });
    }
  }

  return { init: init, ensureLoaded: ensureLoaded, reset: reset };
}
