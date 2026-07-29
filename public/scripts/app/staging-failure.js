// What the main tool does when staging throws — extracted from stageImage()'s catch
// in app.js so it can be unit-tested, and so app.js stays under the max-lines ratchet.
//
// The contract with app/staging-pipeline.js: most of its failure paths paint their own
// message and then throw only to unwind the caller, and it marks those errors
// `stagingMessageShown`. The rest throw bare — AUTH_REQUIRED, FILE_TOO_LARGE, "no image
// data received", and any dropped connection — and are this module's to surface.
//
// Before this existed the catch handled exactly one of them (AUTH_REQUIRED, and only on
// a mobile viewport), so the other three, plus AUTH_REQUIRED on a desktop, failed in
// total silence: the progress bar vanished and nothing replaced it. Testing by code
// meant every code nobody thought to list defaulted to silence; testing the mark means
// the default is a message.

/**
 * Build the staging-failure handler.
 * @param {{
 *   showStagingError: (message: string) => void,
 *   getProfileMenu?: () => ({ setAuthModeRegister?: (v: boolean) => void,
 *                             openAuthModal?: (forStaging: boolean) => void } | null | undefined),
 *   openAuthForStaging?: () => void,
 *   getText?: (key: string) => (string | undefined),
 * }} deps - Collaborators. The auth ones are optional: a page can embed the staging
 *   dialog without the profile menu, and then the message is all we have.
 * @returns {{ handleStagingFailure: (error: any) => 'auth' | 'message' }} The handler,
 *   returning which branch it took (for tests and callers that care).
 */
export function createStagingFailure({ showStagingError, getProfileMenu, openAuthForStaging, getText }) {
  /**
   * Surface a staging failure to the user. Never throws.
   * @param {any} error - Whatever stageImage() caught.
   * @returns {'auth' | 'message'} `auth` when the sign-in prompt was opened.
   */
  function handleStagingFailure(error) {
    // A session that expired between opening the dialog and pressing Process. The
    // prompt is deliberately NOT mobile-only: it was gated on a viewport check with no
    // rationale anywhere in the history, and this is the same modal the signed-out
    // entry flow already opens on desktop.
    if (error && error.code === 'AUTH_REQUIRED') {
      const menu = typeof getProfileMenu === 'function' ? getProfileMenu() : null;
      if (menu && typeof menu.setAuthModeRegister === 'function') {
        menu.setAuthModeRegister(true);
      }
      if (menu && typeof menu.openAuthModal === 'function') {
        menu.openAuthModal(true);
        return 'auth';
      }
      if (typeof openAuthForStaging === 'function') {
        openAuthForStaging();
        return 'auth';
      }
      // No auth UI on this page — fall through and at least say why it failed.
    }
    // Only speak when the pipeline has not already. Double-painting is the failure
    // mode on the other side of this: DAILY_LIMIT and NO_IMAGE_GENERATED put their
    // own copy on screen and would otherwise get a generic one stacked on top.
    if (!error || !error.stagingMessageShown) {
      const fallback = (typeof getText === 'function' && getText('errors.processingFailed')) || 'Processing failed';
      showStagingError((error && error.message) || fallback);
    }
    return 'message';
  }

  return { handleStagingFailure };
}
