// Admin "give this account a free month of Stagify+" control, rendered inside the
// expanded user row. Kept out of renderers.js so that file stays under the
// 650-line lint cap. Talks to /api/admin/grant-plus + /api/admin/revoke-plus; the
// grant itself is Stripe-free (see lib/data/pro-grants.js).

import { el, fmtDateTime } from './helpers.js';

/**
 * True while a comp grant is still running. The server downgrades a lapsed grant
 * to free before it ever reaches this dashboard, so an expiry in the future
 * always means the grant is live.
 *
 * @param {any} u A user record from /authstore.
 */
export function grantActive(u) {
  if (!u || !u.proGrantExpiresAt) return false;
  var t = Date.parse(u.proGrantExpiresAt);
  return isFinite(t) && t > Date.now();
}

/**
 * Build the section renderer.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend Mutating request helper (holds the session key).
 * @param {() => void} deps.onChanged Called after a successful grant/revoke so the caller can re-render.
 */
export function createGrantSection({ apiSend, onChanged }) {
  /**
   * @param {any} u User record; mutated in place on success so the table
   *   reflects the new plan without a full reload.
   * @param {string} plan The plan the dashboard shows for this user (own pro,
   *   enterprise coverage, or free).
   */
  return function grantSection(u, plan) {
    var sec = el('div', { className: 'adm-detail-section' });
    sec.appendChild(el('h3', { textContent: 'Stagify+ Grant' }));

    if (u.stripeSubscriptionId) {
      sec.appendChild(el('p', { className: 'adm-detail-empty', textContent: 'Paying subscriber — manage this account in Stripe.' }));
      return sec;
    }

    var msg = el('p', { className: 'adm-grant-msg' });

    if (grantActive(u)) {
      sec.appendChild(el('p', {
        className: 'adm-grant-status',
        textContent: 'Free month active — reverts to free on ' + fmtDateTime(u.proGrantExpiresAt) + '.',
      }));
      var rev = /** @type {HTMLButtonElement} */ (el('button', {
        className: 'adm-grant-btn adm-grant-btn--danger', type: 'button', textContent: 'Revoke now',
      }));
      rev.addEventListener('click', function () {
        if (!confirm('Revoke ' + u.email + "'s free month?\n\nThey drop back to the free plan immediately.")) return;
        rev.disabled = true; rev.textContent = 'Revoking…';
        apiSend('/api/admin/revoke-plus', 'POST', { userId: u.id }).then(function () {
          u.plan = 'free'; u.proGrantExpiresAt = null;
          onChanged();
        }).catch(function (e) {
          rev.disabled = false; rev.textContent = 'Revoke now';
          msg.style.color = '#dc2626'; msg.textContent = 'Revoke failed: ' + e.message;
        });
      });
      sec.appendChild(rev);
      sec.appendChild(msg);
      return sec;
    }

    if (plan !== 'free') {
      sec.appendChild(el('p', { className: 'adm-detail-empty', textContent: 'Already on ' + plan + ' — nothing to grant.' }));
      return sec;
    }

    var btn = /** @type {HTMLButtonElement} */ (el('button', {
      className: 'adm-grant-btn', type: 'button', textContent: 'Grant 1 month of Stagify+',
    }));
    btn.addEventListener('click', function () {
      if (!confirm('Give ' + u.email + ' one month of Stagify+?\n\nNo card and no Stripe subscription — access reverts to free automatically in a month.')) return;
      btn.disabled = true; btn.textContent = 'Granting…';
      apiSend('/api/admin/grant-plus', 'POST', { userId: u.id }).then(function (j) {
        u.plan = 'pro';
        u.proGrantedAt = new Date().toISOString();
        u.proGrantExpiresAt = j && j.expiresAt;
        onChanged();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Grant 1 month of Stagify+';
        msg.style.color = '#dc2626'; msg.textContent = 'Grant failed: ' + e.message;
      });
    });
    sec.appendChild(btn);
    sec.appendChild(msg);
    return sec;
  };
}
