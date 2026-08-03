// The "Report an issue" dialog's markup, kept beside the behaviour file the way
// auth-modal-template.js is. Injected once by ensureReportModal().
//
// Every string carries `data-lang` / `data-lang-attr` rather than being written by
// JS: language-loader.js re-applies translations to nodes added after load (its
// MutationObserver), so the dialog is localized the moment it is inserted AND on
// every later language change, with no re-render pass of its own. The English text
// in the markup is the fallback shown before a pack loads.
//
// Note which attribute each field uses. `data-lang` sets .placeholder on a TEXTAREA
// and on `<input type="text">`, but .textContent on anything else — so the email
// input, which is type="email", names its placeholder through data-lang-attr.
//
// Each element's opening tag is one unbroken string. Splitting one across a `+`
// would still work in the browser, but test/frontend/dialog-a11y.test.js reads the
// tags straight out of this source, and so would anyone auditing it by eye.
export const REPORT_ISSUE_HTML =
  '<div id="report-issue-modal" class="report-modal hidden" aria-hidden="true">' +
  '<div class="report-modal__backdrop" id="report-issue-backdrop"></div>' +
  '<div class="report-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="report-issue-title">' +
  '<button type="button" class="report-modal__close" id="report-issue-close" data-lang-attr="common.close|aria-label" aria-label="Close"><span aria-hidden="true">&times;</span></button>' +
  '<h2 id="report-issue-title" data-lang="profile.report.title">Report an issue</h2>' +
  '<p class="report-modal__sub" data-lang="profile.report.intro">Tell us what went wrong and we’ll take a look.</p>' +
  '<form id="report-issue-form" novalidate>' +
  '<div class="auth-field">' +
  '<label for="report-issue-description" data-lang="profile.report.descriptionLabel">What happened?</label>' +
  '<textarea id="report-issue-description" rows="4" required maxlength="4000" data-lang="profile.report.descriptionPlaceholder" placeholder="Describe the problem you ran into…"></textarea>' +
  '</div>' +
  '<div class="auth-field">' +
  '<label for="report-issue-steps" data-lang="profile.report.stepsLabel">Steps to reproduce (optional)</label>' +
  '<textarea id="report-issue-steps" rows="3" maxlength="4000" data-lang="profile.report.stepsPlaceholder" placeholder="1. Went to…&#10;2. Clicked…&#10;3. Instead of X, Y happened"></textarea>' +
  '</div>' +
  '<div class="auth-field">' +
  '<label for="report-issue-email" data-lang="profile.report.emailLabel">Email (optional)</label>' +
  '<input type="email" id="report-issue-email" autocomplete="email" maxlength="320" data-lang-attr="profile.report.emailPlaceholder|placeholder" placeholder="you@example.com">' +
  '</div>' +
  '<div id="report-issue-error" class="auth-error" role="alert"></div>' +
  '<div class="report-modal__actions">' +
  '<button type="button" class="report-modal__cancel" id="report-issue-cancel" data-lang="profile.report.cancel">Cancel</button>' +
  '<button type="submit" class="btn btn-primary" id="report-issue-submit"><strong id="report-issue-submit-label" data-lang="profile.report.submit">Send report</strong></button>' +
  '</div>' +
  '</form>' +
  // Swapped in for the form once the report is accepted, rather than a toast: not
  // every page carrying the account menu links styles/toast.css, and a dialog that
  // reports its own outcome cannot be missed behind its own overlay.
  '<div id="report-issue-success" class="report-modal__success hidden">' +
  '<p class="report-modal__success-title" data-lang="profile.report.successTitle">Thanks — we got it.</p>' +
  '<p class="report-modal__sub" data-lang="profile.report.successBody">Our team will look into this. If you left an email, we’ll follow up there.</p>' +
  '<div class="report-modal__actions">' +
  '<button type="button" class="btn btn-primary" id="report-issue-done" data-lang="profile.report.done">Done</button>' +
  '</div>' +
  '</div>' +
  '</div></div>';
