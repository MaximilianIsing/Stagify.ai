// Main tool — the session expires between opening the stage dialog and pressing Process.
//
// This file was `stage-mobile-auth.spec.js`, and it existed to cover a branch that only
// a phone could reach. `public/scripts/app.js` used to read:
//
//     if (error && error.code === 'AUTH_REQUIRED' && isMobileStagingViewport()) {
//       …setAuthModeRegister(true); openAuthModal(true);…
//
// so a phone got the create-account prompt and a desktop got NOTHING — no message, no
// prompt, just a progress bar that disappeared. The mobile-chrome project is what made
// that asymmetry visible; the desktop half of this file used to be a negative control
// asserting the silence, with a note saying it was reported rather than papered over.
//
// It is fixed now: scripts/app/staging-failure.js handles AUTH_REQUIRED on any viewport,
// so this runs on BOTH projects and asserts the same outcome in each. The premise guard
// that pinned the media query is gone with the media query — the handler no longer
// consults one, which is the whole point.
//
// Everything is mocked (auth/me, validate-image, process-image) — no account, no Gemini,
// no cost.
import { test, expect } from '@playwright/test';
import { openStageModalViaUI, roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

/** Open the stage dialog through the real hero button and arm it with a photo. */
async function loadPhotoIntoStageDialog(page) {
  await openStageModalViaUI(page);
  await page.locator('#stage-file-input').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: await roomPngBuffer(),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();
}

test.describe('Main tool — session expires mid-staging', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, code: null, reason: '' }),
      }),
    );
    // The exact body routes/staging.js:56 sends when the bearer token no longer
    // resolves to a user (sendError → { error, code }).
    await page.route('**/api/process-image', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Please sign in to stage images', code: 'AUTH_REQUIRED' }),
      }),
    );
  });

  test('a 401 hands the visitor the create-account prompt, on any viewport', async ({ page }) => {
    // Deliberately NOT skipped per project: running identically under chromium and
    // mobile-chrome is the assertion. If someone reintroduces a viewport check, the
    // desktop run goes red — which is exactly what did not happen for years.
    await loadPhotoIntoStageDialog(page);
    const authModal = page.locator('#auth-modal');
    await expect(authModal).toHaveClass(/hidden/); // pre-condition: closed before Process

    await page.locator('#process-btn').click();

    // The handler's three observable effects, in the order it produces them.
    await expect(authModal).not.toHaveClass(/hidden/);
    // setAuthModeRegister(true) → the confirm-password row is what distinguishes
    // "create an account" from the plain sign-in form.
    await expect(page.locator('#auth-password-confirm-row')).toBeVisible();
    // openAuthModal(true) sets the staging hand-off flag, so signing in from here
    // returns the visitor to the dialog instead of an empty page.
    await expect.poll(() => page.evaluate(() => window.__stagifyPendingStaging === true)).toBe(true);

    // The dialog underneath is not torn down, and Process is usable again.
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
    await expect(page.locator('#process-btn')).toBeEnabled();
  });

  test('a failure with no prompt to offer still says something', async ({ page }) => {
    // The other half of the same bug: staging-pipeline.js throws FILE_TOO_LARGE, "no
    // image data received" and dropped connections BARE, and the old catch surfaced
    // none of them on any viewport. Anything that reaches the handler unmarked must
    // now produce a message rather than silence.
    await page.route('**/api/process-image', (route) =>
      route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'File is too large.', code: 'FILE_TOO_LARGE' }),
      }),
    );

    await loadPhotoIntoStageDialog(page);
    await page.locator('#process-btn').click();

    await expect(page.locator('#staging-error-viewer')).toBeVisible();
    await expect(page.locator('#auth-modal')).toHaveClass(/hidden/); // not an auth failure
    await expect(page.locator('#process-btn')).toBeEnabled();
  });
});
