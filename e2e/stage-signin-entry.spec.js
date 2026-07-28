// Main tool — the signed-out entry path: "Upload image for free" → sign in → the
// stage dialog opens with the visitor's intent intact.
//
// This is the app's highest-value flow and nothing drove it end to end: every stage
// spec lifted `.hidden` off `#stage-modal` with a `page.evaluate`, which starts the
// story *after* the only gate that decides whether the dialog opens at all
// (`openFilePicker()` in app.js → `openAuthModal(true)` → `completeSignIn()` →
// `resumePendingStaging()`).
//
// That gap was not theoretical. The hand-off was DEAD in all three sign-in paths
// until 2026-07-28: `closeAuthModal()` clears `window.__stagifyPendingStaging`, and
// every success path read the flag *after* the close, so the modal shut and nothing
// opened — no error, no clue, the user just clicked Upload again. Unit tests
// (test/frontend/profile-menu/auth-modal.test.js) pin the flag handling against a DOM
// shim; these prove the same thing through the real page, where the flag has to
// survive two modules (`profile-menu/auth-modal.js` and `app.js`) and reach the real
// `#stage-modal`.
//
// Every backend call is mocked — no account, no mail, no Gemini, no cost.
import { test, expect } from '@playwright/test';
import { openStageModalViaUI, roomPngBuffer, stubAnonymousAuth, waitForHomeReady } from './fixtures.js';

const EMAIL = 'e2e@example.com';
const PASSWORD = 'correct-horse-battery';

/** Click the hero upload button while signed out and wait for the auth modal. */
async function clickUploadAnonymously(page) {
  await page.goto('/index.html');
  await waitForHomeReady(page);
  await page.locator('#hero-upload').click();
  const authModal = page.locator('#auth-modal');
  await expect(authModal).not.toHaveClass(/hidden/);
  return authModal;
}

/** Switch the modal from its default create-account mode to sign-in and submit. */
async function signIn(page, { email = EMAIL, password = PASSWORD } = {}) {
  await page.locator('#auth-mode-toggle').click();
  await expect(page.locator('#auth-password-confirm-row')).toBeHidden();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
}

test.describe('Main tool — signed-out entry flow', () => {
  test.beforeEach(async ({ page }) => {
    await stubAnonymousAuth(page);
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, code: null, reason: '' }),
      }),
    );
  });

  test('upload → sign in → stage: the dialog opens and the photo reaches the API', async ({ page }) => {
    let loginBody = null;
    await page.route('**/api/auth/login', async (route) => {
      loginBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'e2e-token' }),
      });
    });
    let submitted = null;
    await page.route('**/api/process-image', async (route) => {
      const body = route.request().postData() || '';
      const grab = (f) => (body.match(new RegExp(`name="${f}"\\r?\\n\\r?\\n([^\\r\\n]*)`)) || [])[1];
      submitted = { roomType: grab('roomType'), hasImage: /name="image"/.test(body) };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stopped by e2e' }),
      });
    });

    const stageModal = page.locator('#stage-modal');
    const authModal = await clickUploadAnonymously(page);

    // An anonymous visitor is asked to sign up, NOT handed the uploader — the gate
    // exists because mobile used to fall through and stage for free.
    await expect(stageModal).toHaveClass(/hidden/);
    await expect(page.locator('#auth-password-confirm-row')).toBeVisible(); // create-account mode

    await signIn(page);

    // The credentials really went through the form, not a shortcut.
    await expect.poll(() => loginBody).toEqual({ email: EMAIL, password: PASSWORD });

    // The hand-off: auth modal closes AND the staging dialog the visitor was
    // reaching for takes its place. Both halves matter — the regression this
    // guards was a clean close with nothing behind it.
    await expect(authModal).toHaveClass(/hidden/);
    await expect(stageModal).not.toHaveClass(/hidden/);

    // …and the dialog is live, not just visible: upload and stage from it.
    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });
    await expect(page.locator('#stage-preview')).toBeVisible();
    await page.locator('#process-btn').click();

    await expect.poll(() => submitted, { timeout: 15_000 }).toEqual({ roomType: 'Bedroom', hasImage: true });
  });

  test('creating an account and verifying the emailed code lands in the same place', async ({ page }) => {
    // The second caller of completeSignIn(). It reads the pending flag through the
    // same helper, but from a different branch of handleSubmit — and the first one
    // to be fixed was not automatically the other.
    await page.route('**/api/auth/register', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsVerification: true, message: 'Check your email for a code.' }),
      }),
    );
    await page.route('**/api/auth/register/verify', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'e2e-token' }),
      }),
    );

    const authModal = await clickUploadAnonymously(page);

    await page.locator('#auth-email').fill(EMAIL);
    await page.locator('#auth-password').fill(PASSWORD);
    await page.locator('#auth-password-confirm').fill(PASSWORD);
    await page.locator('#auth-submit').click();

    // Registration parks the visitor on the code panel rather than signing them in.
    await expect(page.locator('#auth-verify-panel')).toBeVisible();
    await expect(page.locator('#stage-modal')).toHaveClass(/hidden/);

    await page.locator('#auth-verify-code').fill('123456');
    await page.locator('#auth-submit').click();

    await expect(authModal).toHaveClass(/hidden/);
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
  });

  test('a rejected sign-in keeps the visitor in the modal with the reason', async ({ page }) => {
    // Negative control for the two above: "the stage dialog opened" only means
    // something if a failed sign-in does not open it.
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid email or password' }),
      }),
    );

    const authModal = await clickUploadAnonymously(page);
    await signIn(page, { password: 'wrong-password' });

    await expect(page.locator('#auth-error')).toHaveText('Invalid email or password');
    await expect(authModal).not.toHaveClass(/hidden/);
    await expect(page.locator('#stage-modal')).toHaveClass(/hidden/);
  });
});

test.describe('Main tool — signed-in entry flow', () => {
  test('a session opens the stage dialog straight from the upload button', async ({ page }) => {
    // The other branch of the same gate, and the one the sibling stage specs lean on
    // via openStageModalViaUI: with a token present the auth modal is skipped
    // entirely. Asserted here so a regression names itself instead of showing up as
    // a timeout in five unrelated specs.
    const { token } = await stubAnonymousAuth(page);
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('stagifyAuthToken', t);
      } catch { /* ignore private-mode storage errors */ }
    }, token);

    await openStageModalViaUI(page);
    // The modal is mounted on every page by profile-menu's init(); the point is
    // that the upload button never opened it.
    await expect(page.locator('#auth-modal')).toHaveClass(/hidden/);
  });
});
