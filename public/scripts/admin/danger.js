// The two irreversible-ish account actions, rendered at the BOTTOM of the
// expanded user row: sign out everywhere, and delete the account outright.
//
// Kept out of renderers.js so that file stays under the 650-line lint cap, the
// same reason grant.js exists — and kept out of grant.js because the two sections
// answer opposite questions and must not sit in one box. Granting is routine;
// erasure is not.
//
// ── Why a typed confirmation and not confirm() ──
// grant.js uses confirm() and that is right for a reversible act: the worst case
// is a month of Stagify+ given away and revoked a minute later. Erasure has no
// undo, no tombstone, and no backup path short of restoring the database — one
// misplaced click on the wrong row and a customer's account and every render they
// made are gone. So the operator has to TYPE the address, which cannot be done by
// accident and cannot be done to the wrong row: the confirmation names the target
// and the button stays disabled until the two match.
//
// ── Why the force step is separate ──
// The server refuses an account with a live Stripe subscription unless `force` is
// passed. Retrying automatically with force:true would make that guard decorative,
// so the refusal is surfaced as its own step with its own sentence — deleting a
// paying customer's account leaves a subscription billing against nothing, and the
// operator should go and cancel it in Stripe first.

import { el } from './helpers.js';

/**
 * Build the section renderer.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend Mutating request helper (holds the session token).
 * @param {(u: any) => void} deps.onDeleted Called after a successful erasure so the caller can drop the row.
 * @returns {(u: any) => HTMLElement} Renderer for one user's danger section.
 */
export function createDangerSection({ apiSend, onDeleted }) {
  /**
   * @param {any} u User record from /authstore.
   * @returns {HTMLElement}
   */
  return function dangerSection(u) {
    const sec = el('div', { className: 'adm-detail-section adm-danger' });
    sec.appendChild(el('h3', { textContent: 'Danger zone' }));

    const msg = el('p', { className: 'adm-danger-msg' });

    // ── Sign out everywhere ────────────────────────────────────────────────
    // Reversible (they sign in again), so a plain confirm is proportionate.
    const outRow = el('div', { className: 'adm-danger-row' });
    outRow.appendChild(el('p', {
      className: 'adm-danger-copy',
      textContent: 'Drops every live session for this account. The password is unchanged and any reset link they are holding still works.',
    }));
    const outBtn = /** @type {HTMLButtonElement} */ (el('button', {
      className: 'adm-grant-btn adm-grant-btn--danger', type: 'button', textContent: 'Sign out everywhere',
    }));
    outBtn.addEventListener('click', () => {
      if (!confirm('Sign ' + u.email + ' out on every device?\n\nTheir password is not changed — they can sign straight back in.')) return;
      outBtn.disabled = true;
      outBtn.textContent = 'Signing out…';
      apiSend('/api/admin/revoke-sessions', 'POST', { userId: u.id }).then((j) => {
        outBtn.textContent = 'Sign out everywhere';
        outBtn.disabled = false;
        const n = Number(j && j.revoked) || 0;
        // Zero is a real answer, not a failure — say so rather than reporting a
        // success that did nothing.
        msg.className = 'adm-danger-msg adm-danger-msg--ok';
        msg.textContent = n === 0
          ? 'No live sessions — nothing to revoke.'
          : 'Revoked ' + n + ' session' + (n === 1 ? '' : 's') + '.';
      }).catch((e) => {
        outBtn.disabled = false;
        outBtn.textContent = 'Sign out everywhere';
        msg.className = 'adm-danger-msg adm-danger-msg--err';
        msg.textContent = 'Could not sign them out: ' + e.message;
      });
    });
    outRow.appendChild(outBtn);
    sec.appendChild(outRow);

    // ── Delete the account ─────────────────────────────────────────────────
    const delRow = el('div', { className: 'adm-danger-row' });
    delRow.appendChild(el('p', {
      className: 'adm-danger-copy',
      textContent: 'Erases the account, its sessions, its memories and its renders, and redacts this person from the CSV logs. There is no undo.',
    }));

    const confirmInput = /** @type {HTMLInputElement} */ (el('input', {
      className: 'adm-danger-input', type: 'text', placeholder: u.email || 'type the email',
    }));
    confirmInput.setAttribute('aria-label', 'Type ' + (u.email || 'the account email') + ' to confirm deletion');
    confirmInput.setAttribute('autocomplete', 'off');

    const delBtn = /** @type {HTMLButtonElement} */ (el('button', {
      className: 'adm-grant-btn adm-grant-btn--danger', type: 'button', textContent: 'Delete account',
    }));
    delBtn.disabled = true;

    // The button is inert until the typed address matches the row's. Compared
    // case-insensitively and trimmed, because the operator is copying an address
    // out of a table, not proving they can type.
    const target = String(u.email || '').trim().toLowerCase();
    const matches = () => confirmInput.value.trim().toLowerCase() === target && target !== '';
    confirmInput.addEventListener('input', () => { delBtn.disabled = !matches(); });

    /**
     * @param {boolean} force Second pass, after the server refused a subscriber.
     */
    function doDelete(force) {
      delBtn.disabled = true;
      delBtn.textContent = 'Deleting…';
      apiSend('/api/admin/delete-user', 'POST', { userId: u.id, email: u.email, force }).then(() => {
        msg.className = 'adm-danger-msg adm-danger-msg--ok';
        msg.textContent = 'Account deleted.';
        onDeleted(u);
      }).catch((e) => {
        delBtn.textContent = 'Delete account';
        delBtn.disabled = !matches();
        msg.className = 'adm-danger-msg adm-danger-msg--err';
        if (e.code === 'ACTIVE_SUBSCRIPTION' && !force) {
          // Never auto-retry — the guard exists so someone reads this sentence.
          msg.textContent = e.message;
          delRow.appendChild(forceStep());
          return;
        }
        msg.textContent = 'Delete failed: ' + e.message;
      });
    }

    /** The escalation, built only once the server has actually refused. */
    function forceStep() {
      const wrap = el('div', { className: 'adm-danger-force' });
      wrap.appendChild(el('p', {
        className: 'adm-danger-copy',
        textContent: 'This account still has a live Stripe subscription. Cancel it in Stripe first — deleting the account here leaves the subscription billing a customer who no longer exists.',
      }));
      const forceBtn = /** @type {HTMLButtonElement} */ (el('button', {
        className: 'adm-grant-btn adm-grant-btn--danger', type: 'button', textContent: 'Delete anyway, leaving the subscription',
      }));
      forceBtn.addEventListener('click', () => {
        forceBtn.disabled = true;
        doDelete(true);
      });
      wrap.appendChild(forceBtn);
      return wrap;
    }

    delBtn.addEventListener('click', () => {
      if (!matches()) return;
      doDelete(false);
    });

    delRow.appendChild(el('div', { className: 'adm-danger-confirm' }, [
      el('label', { className: 'adm-danger-label', textContent: 'Type the account email to enable deletion' }),
      confirmInput,
      delBtn,
    ]));
    sec.appendChild(delRow);
    sec.appendChild(msg);
    return sec;
  };
}
