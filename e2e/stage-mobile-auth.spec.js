// Main tool — the ONE branch in the staging flow that only exists on a phone.
//
// `public/scripts/app.js:505`:
//
//     } catch (error) {
//       processBtn.disabled = false;
//       if (error && error.code === 'AUTH_REQUIRED' && isMobileStagingViewport()) {
//         …setAuthModeRegister(true); openAuthModal(true);…
//
// and `isMobileStagingViewport()` (app.js:149) is literally
// `matchMedia('(max-width: 768px)').matches`. So when /api/process-image answers
// 401 AUTH_REQUIRED — a session that expired between opening the dialog and
// pressing Process — a phone gets the create-account prompt and a desktop gets
// nothing at all. Desktop Chromium can never reach that `if`, which is why this
// path had zero browser coverage until the mobile-chrome project existed.
//
// Both halves live in this file on purpose: the desktop test is the negative
// control. "The register prompt appeared on mobile" only means something if the
// same script on a wide viewport leaves it closed.
//
// Everything is mocked (auth/me, validate-image, process-image) — no account, no
// Gemini, no cost.
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

  test('the media query the branch keys on matches this project, and only this project', async ({
    page,
    isMobile,
  }) => {
    // Guards the premise of the two tests below rather than the app: if a future
    // device descriptor lands outside `(max-width: 768px)` the branch silently
    // stops being exercised and everything still goes green. Assert the viewport
    // really is on the side of the boundary the project name claims.
    await page.goto('/index.html');
    const matches = await page.evaluate(() => window.matchMedia('(max-width: 768px)').matches);
    expect(matches).toBe(!!isMobile);
  });

  test('mobile: a 401 hands the visitor the create-account prompt', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'app.js:505 gates this on matchMedia(max-width: 768px) — unreachable on desktop.');

    await loadPhotoIntoStageDialog(page);
    const authModal = page.locator('#auth-modal');
    await expect(authModal).toHaveClass(/hidden/); // pre-condition: closed before Process

    await page.locator('#process-btn').click();

    // The branch's three observable effects, in the order app.js produces them.
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

  test('desktop: the same 401 leaves the auth modal closed', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'negative control for the mobile branch — asserts the desktop side of the same if.');

    await loadPhotoIntoStageDialog(page);
    const authModal = page.locator('#auth-modal');
    await expect(authModal).toHaveClass(/hidden/);

    await page.locator('#process-btn').click();

    // Process re-enabling is the only thing the desktop catch does, so waiting on
    // it proves the rejection has been handled — the modal assertions below are
    // then about the end state, not about having looked too early.
    await expect(page.locator('#process-btn')).toBeEnabled();
    await expect(authModal).toHaveClass(/hidden/);
    await expect.poll(() => page.evaluate(() => window.__stagifyPendingStaging === true)).toBe(false);

    // NOTE: this pins current behaviour, and current behaviour is that a desktop
    // user whose session expired sees NOTHING — the catch swallows AUTH_REQUIRED
    // with no message. That asymmetry is app.js's, not this spec's; it is reported
    // rather than papered over here.
  });
});
