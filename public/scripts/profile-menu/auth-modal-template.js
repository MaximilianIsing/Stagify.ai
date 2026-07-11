// The auth modal's markup, lifted out of auth-modal.js so the behaviour file
// isn't dominated by a wall of HTML. Injected once by ensureAuthModal().
export const AUTH_MODAL_HTML =
  '<div id="auth-modal" class="auth-modal hidden" aria-hidden="true">' +
  '<div class="auth-modal__backdrop" id="auth-modal-backdrop"></div>' +
  '<div class="auth-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">' +
  '<button type="button" class="auth-modal__close" id="auth-modal-close" aria-label="Close">×</button>' +
  '<h2 id="auth-modal-title">Welcome to Stagify</h2>' +
  '<p class="auth-modal__sub" id="auth-modal-sub">Create a free account to upload and stage your photos.</p>' +
  '<div id="auth-error" class="auth-error" role="alert"></div>' +
  '<form id="auth-form" novalidate>' +
  '<div class="auth-field"><label for="auth-email">Email</label>' +
  '<input type="email" id="auth-email" name="email" autocomplete="email" required placeholder="you@example.com"></div>' +
  '<div id="auth-standard-panel">' +
  '<div class="auth-field"><label for="auth-password">Password</label>' +
  '<input type="password" id="auth-password" name="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters"></div>' +
  '<div class="auth-field" id="auth-password-confirm-row"><label for="auth-password-confirm">Confirm password</label>' +
  '<input type="password" id="auth-password-confirm" name="passwordConfirm" autocomplete="new-password" minlength="8" placeholder="Re-enter password"></div>' +
  '<div id="auth-google-panel" class="auth-google-panel hidden" aria-hidden="true">' +
  '<p class="auth-divider"><span>or</span></p>' +
  '<div id="auth-google-btn-container" class="auth-google-btn-container"></div>' +
  '</div>' +
  '<button type="button" class="auth-forgot-link" id="auth-forgot-link">Forgot your password?</button>' +
  '</div>' +
  '<div id="auth-verify-panel" class="hidden">' +
  '<p class="auth-modal__sub auth-forgot-copy" id="auth-verify-copy">Enter the 6-digit code we sent to your email.</p>' +
  '<div class="auth-field"><label for="auth-verify-code">Verification code</label>' +
  '<input type="text" id="auth-verify-code" name="verificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456"></div>' +
  '<button type="button" class="auth-forgot-back" id="auth-verify-back">Back</button>' +
  '<button type="button" class="auth-forgot-back" id="auth-verify-resend">Resend code</button>' +
  '<div id="auth-verify-feedback" class="auth-error" role="status"></div>' +
  '</div>' +
  '<div id="auth-submit-row" class="auth-actions"><button type="submit" class="btn btn-primary btn-lg" id="auth-submit"><strong id="auth-submit-label">Create account</strong></button></div>' +
  '<p id="auth-terms-notice" class="auth-terms-notice" data-lang-html="auth.agreeTerms">By creating an account, you agree to <a href="terms.html">Terms</a> &amp; <a href="privacy.html">Privacy</a></p>' +
  '<div id="auth-forgot-panel" class="hidden">' +
  '<p class="auth-modal__sub auth-forgot-copy">We’ll email you a one-time link to set a new password. The link expires in one hour.</p>' +
  '<div class="auth-actions"><button type="button" class="btn btn-primary btn-lg" id="auth-forgot-send"><strong>Send reset link</strong></button></div>' +
  '<button type="button" class="auth-forgot-back" id="auth-forgot-back">Back to sign in</button>' +
  '<div id="auth-forgot-feedback" class="auth-error" role="status"></div>' +
  '</div>' +
  '</form>' +
  '<div class="auth-toggle"><span id="auth-toggle-label">Already have an account?</span> ' +
  '<button type="button" id="auth-mode-toggle">Sign in</button></div>' +
  '</div></div>';
