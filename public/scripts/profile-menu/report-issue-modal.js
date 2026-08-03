import { lang } from './dom-utils.js';
import { REPORT_ISSUE_HTML } from './report-issue-template.js';
import { readBugReportHistory } from '../bug-report-history.js';

/**
 * The account menu's "Report an issue" dialog — the site-wide half of the bug
 * channel. `/api/bug-report` used to be reachable from exactly one place, the AI
 * Designer's bug button next to Send, so anything that went wrong on the home page,
 * the Masking Studio, checkout or the gallery had no route to it at all.
 *
 * It posts the same body that form does, to the same unauthenticated endpoint (the
 * per-field clamps and the file ceiling live server-side, in lib/http/bug-report-row.js),
 * and it attaches the AI Designer transcript when there is one — readBugReportHistory
 * returns an empty transcript on every other page rather than failing the report.
 *
 * Outcome is reported INSIDE the dialog, not through toast.js: four of the ten pages
 * carrying the account menu do not link styles/toast.css, so a toast would have been
 * an invisible confirmation on exactly the pages this was added for.
 *
 * @param {object} deps
 * @param {() => void} deps.onCloseDropdown Close the profile dropdown before the dialog opens.
 * @returns {{ open: (returnFocusTo?: HTMLElement | null) => void, close: () => void }}
 *   Controls for the profile dropdown.
 */
export function createReportIssueModal({ onCloseDropdown }) {
  let BOUND = false;

  /**
   * Where focus goes when the dialog closes. NOT simply whatever had focus when it
   * opened: that is the menu row the user clicked, and the dropdown is closed on the
   * way in, so by then the row is inside a `display: none` subtree. Focusing a hidden
   * element silently does nothing and focus drops to <body> — the caller therefore
   * names a durable element (the account button), and the element that happened to
   * have focus is only the fallback for an opener that is still on screen.
   */
  /** @type {HTMLElement | null} */
  let opener = null;

  function ensureReportModal() {
    if (document.getElementById('report-issue-modal')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = REPORT_ISSUE_HTML;
    if (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);
  }

  /**
   * The dialog's elements, re-resolved whenever the root node changes — same cache
   * strategy as auth-modal.js, for the same reason: if anything ever replaces the
   * dialog, the handles rebuild instead of silently writing to a detached tree.
   */
  /** @type {Record<string, any> | null} */
  let handles = null;

  function els() {
    const modal = document.getElementById('report-issue-modal');
    if (!modal) return null;
    if (handles && handles.modal === modal) return handles;
    const byId = (id) => document.getElementById(id);
    handles = {
      modal,
      backdrop: byId('report-issue-backdrop'),
      closeBtn: byId('report-issue-close'),
      form: /** @type {HTMLFormElement} */ (byId('report-issue-form')),
      description: /** @type {HTMLTextAreaElement} */ (byId('report-issue-description')),
      steps: /** @type {HTMLTextAreaElement} */ (byId('report-issue-steps')),
      email: /** @type {HTMLInputElement} */ (byId('report-issue-email')),
      error: byId('report-issue-error'),
      cancelBtn: byId('report-issue-cancel'),
      submitBtn: /** @type {HTMLButtonElement} */ (byId('report-issue-submit')),
      submitLabel: byId('report-issue-submit-label'),
      success: byId('report-issue-success'),
      doneBtn: byId('report-issue-done'),
    };
    return handles;
  }

  /** @param {string} message Empty clears the line. */
  function showError(message) {
    const e = els();
    if (e && e.error) e.error.textContent = message;
  }

  /** @param {HTMLElement | null} [returnFocusTo] */
  function openReportModal(returnFocusTo) {
    ensureReportModal();
    bindOnce();
    const e = els();
    if (!e) return;
    opener = returnFocusTo || /** @type {HTMLElement | null} */ (document.activeElement);
    // Cleared field by field rather than through form.reset(): the email below is
    // then written after the clear, not before it, whatever order the browser's
    // reset would have used.
    if (e.description) e.description.value = '';
    if (e.steps) e.steps.value = '';
    showError('');
    if (e.form) e.form.classList.remove('hidden');
    if (e.success) e.success.classList.add('hidden');
    // Signed in? Then we already know where to reply, and asking again is friction.
    // Still editable — a shared account may want the reply somewhere else.
    const user = window.StagifyAuth && window.StagifyAuth.user;
    if (e.email) e.email.value = user && user.email ? user.email : '';
    e.modal.classList.remove('hidden');
    e.modal.setAttribute('aria-hidden', 'false');
    // Focus follows the dialog. Without this it stays on the account button behind
    // the overlay, so the dialog is never announced and Tab walks the page under it.
    if (e.description) e.description.focus();
  }

  function closeReportModal() {
    const e = els();
    if (!e) return;
    e.modal.classList.add('hidden');
    e.modal.setAttribute('aria-hidden', 'true');
    // Focusing a detached node drops focus to <body>, which is worse than leaving
    // it where it is — so the restore is guarded, as every other dialog's is.
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  /**
   * The report body. Identical in shape to the AI Designer bug form's, so both
   * paths land in bug_reports.csv as the same row.
   * @param {{ description: string, steps: string, email: string }} fields
   * @returns {Record<string, unknown>} JSON body for POST /api/bug-report.
   */
  function buildBody(fields) {
    const user = window.StagifyAuth && window.StagifyAuth.user;
    let anonymousId = null;
    try {
      anonymousId = localStorage.getItem('userId');
    } catch {
      // Private-mode / blocked storage. The report is worth more than the id.
    }
    return {
      description: fields.description,
      steps: fields.steps,
      email: fields.email,
      // The account id when we have one; the studio's anonymous device id otherwise.
      userId: (user && user.id) || anonymousId || 'unknown',
      userAgent: navigator.userAgent,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      conversationHistory: readBugReportHistory(),
    };
  }

  async function onSubmit(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const e = els();
    if (!e) return;

    const description = (e.description ? e.description.value : '').trim();
    if (!description) {
      showError(lang('profile.report.needDescription', 'Please describe the problem before sending.'));
      if (e.description) e.description.focus();
      return;
    }

    showError('');
    e.submitBtn.disabled = true;
    if (e.submitLabel) e.submitLabel.textContent = lang('profile.report.submitting', 'Sending…');

    try {
      const response = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildBody({
            description,
            steps: (e.steps ? e.steps.value : '').trim(),
            email: (e.email ? e.email.value : '').trim(),
          })
        ),
      });
      if (!response.ok) throw new Error('bug report rejected: ' + response.status);
      if (e.form) e.form.classList.add('hidden');
      if (e.success) e.success.classList.remove('hidden');
      // Focus moves with the content, or it is left on a button that is now hidden.
      if (e.doneBtn) e.doneBtn.focus();
    } catch {
      // Deliberately no detail from the response: the user can only retry, and the
      // server's own log already carries the reason.
      showError(lang('profile.report.failed', 'We couldn’t send your report. Please try again.'));
    } finally {
      e.submitBtn.disabled = false;
      if (e.submitLabel) e.submitLabel.textContent = lang('profile.report.submit', 'Send report');
    }
  }

  function bindOnce() {
    if (BOUND) return;
    const e = els();
    if (!e) return;
    BOUND = true;

    if (e.backdrop) e.backdrop.addEventListener('click', closeReportModal);
    if (e.closeBtn) e.closeBtn.addEventListener('click', closeReportModal);
    if (e.cancelBtn) e.cancelBtn.addEventListener('click', closeReportModal);
    if (e.doneBtn) e.doneBtn.addEventListener('click', closeReportModal);
    if (e.form) e.form.addEventListener('submit', onSubmit);

    // Escape closes it, like every other dialog in the app. Bound inside the
    // run-once guard, and it reads the visible state rather than tracking a flag of
    // its own — the dialog is only ever hidden via the `hidden` class.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      const cur = els();
      if (!cur || cur.modal.classList.contains('hidden')) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      closeReportModal();
    });
  }

  return {
    /**
     * @param {HTMLElement | null} [returnFocusTo] Element to focus on close. Pass the
     *   control that owns the trigger, not the trigger itself, when the trigger is
     *   inside something this closes.
     */
    open(returnFocusTo) {
      // The dropdown is a click-outside popover; leaving it open behind the overlay
      // means it is still there when the dialog closes.
      if (typeof onCloseDropdown === 'function') onCloseDropdown();
      openReportModal(returnFocusTo);
    },
    close: closeReportModal,
  };
}
