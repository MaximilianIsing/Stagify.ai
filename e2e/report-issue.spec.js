// The bug channel, both entrances, in a real browser.
//
// /api/bug-report used to be reachable from ONE control in the app — the AI Designer's
// bug button — so nothing outside the studio could be reported at all. The account
// menu's "Report an issue" row is the site-wide entrance; this spec covers what the
// unit tests structurally cannot:
//
//   1. the row is really in the live dropdown, and clicking it really opens a dialog
//      that really POSTs (the unit suite drives a hand-rolled DOM, not a browser);
//   2. the AI Designer's own bug form STILL WORKS after its transcript summariser
//      moved into a shared ES module. That form is a classic <script> and names the
//      summariser as a bare identifier, so it now depends on the
//      `window.summariseBugReportHistory` bridge in ai-designer-app.js. Drop that one
//      line and the call throws a ReferenceError from inside the submit handler and
//      the whole report is lost — silently, with the dialog still open. A source guard
//      cannot see that; this can.
import { test, expect } from '@playwright/test';
import { seedProSession, seedFreeSession, stubAnalytics, hideStagingBanner } from './fixtures.js';

/** Capture every /api/bug-report body, and answer as the real route does. */
async function captureBugReports(page, { status = 200 } = {}) {
  const bodies = [];
  await page.route('**/api/bug-report', async (route) => {
    bodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status === 200 ? { success: true } : { error: 'nope' }),
    });
  });
  return bodies;
}

/** Open the account menu and click its report row. */
async function openReportDialog(page) {
  await page.locator('#profile-menu-btn').click();
  await page.locator('[data-profile-action="report-issue"]').click();
  await expect(page.locator('#report-issue-modal')).toBeVisible();
}

test.describe('Report an issue — the account menu', () => {
  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page);
    await hideStagingBanner(page);
    await seedFreeSession(page);
  });

  test('a signed-in visitor can file a report from a page that is not the studio', async ({ page }) => {
    const reports = await captureBugReports(page);
    await page.goto('/index.html');
    await openReportDialog(page);

    // The dialog announces itself, opens on its first field, and knows who is filing.
    const dialog = page.locator('#report-issue-modal [role="dialog"]');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'report-issue-title');
    await expect(page.locator('#report-issue-title')).not.toBeEmpty();
    await expect(page.locator('#report-issue-description')).toBeFocused();
    await expect(page.locator('#report-issue-email')).toHaveValue(/@/);

    await page.locator('#report-issue-description').fill('the carousel skips the third photo');
    await page.locator('#report-issue-steps').fill('1. load the home page\n2. wait');
    await page.locator('#report-issue-submit').click();

    // The confirmation replaces the form — the dialog IS the feedback here, because
    // several pages carrying this menu do not link styles/toast.css.
    await expect(page.locator('#report-issue-success')).toBeVisible();
    await expect(page.locator('#report-issue-form')).toBeHidden();

    expect(reports).toHaveLength(1);
    expect(reports[0].description).toBe('the carousel skips the third photo');
    expect(reports[0].steps).toContain('load the home page');
    expect(reports[0].url).toContain('/index.html');
    expect(reports[0].userAgent).toBeTruthy();
    expect(reports[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('a rejected report says so and keeps what was typed', async ({ page }) => {
    const reports = await captureBugReports(page, { status: 503 });
    await page.goto('/index.html');
    await openReportDialog(page);

    await page.locator('#report-issue-description').fill('uploads hang at 90%');
    await page.locator('#report-issue-submit').click();

    await expect(page.locator('#report-issue-error')).not.toBeEmpty();
    await expect(page.locator('#report-issue-success')).toBeHidden();
    // Retyping a report is how a report gets abandoned.
    await expect(page.locator('#report-issue-description')).toHaveValue('uploads hang at 90%');
    await expect(page.locator('#report-issue-submit')).toBeEnabled();
    expect(reports).toHaveLength(1);
  });

  test('an empty report is refused in the browser, before the request', async ({ page }) => {
    const reports = await captureBugReports(page);
    await page.goto('/index.html');
    await openReportDialog(page);

    await page.locator('#report-issue-submit').click();

    await expect(page.locator('#report-issue-error')).not.toBeEmpty();
    await expect(page.locator('#report-issue-description')).toBeFocused();
    expect(reports, 'a blank report costs a support round trip').toHaveLength(0);
  });

  test('Escape closes it and hands focus back to the account button', async ({ page }) => {
    await page.goto('/index.html');
    await openReportDialog(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('#report-issue-modal')).toBeHidden();
    // The row that opened it is gone with the dropdown, so focus goes to its owner.
    await expect(page.locator('#profile-menu-btn')).toBeFocused();
  });
});

test.describe('Report an issue — the AI Designer keeps its own form', () => {
  // PC-only, like the studio itself: a phone-sized viewport is redirected home.
  test.skip(({ isMobile }) => isMobile, 'the AI Designer is desktop-only by design');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('the studio bug form still posts, with the transcript and without image bytes', async ({ page }) => {
    const reports = await captureBugReports(page);
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(4096);
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'Here is your staged room.', stagedImage: dataUrl }),
      }),
    );

    await page.goto('/ai-designer.html');
    await expect(page.locator('#chat-input')).toBeVisible();
    await page.locator('#chat-input').fill('stage this room');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant .ai-image-container').last()).toBeVisible();

    await page.locator('#bug-report-btn').click();
    await page.locator('#bug-report-description').fill('the render came back sideways');
    await page.locator('#bug-report-submit').click();

    // The dialog closes only on a successful POST, so this alone would fail if the
    // bridged summariser threw.
    await expect(page.locator('#bug-report-popup')).not.toHaveClass(/active/);

    expect(reports).toHaveLength(1);
    expect(reports[0].description).toBe('the render came back sideways');
    const history = reports[0].conversationHistory;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    // The transcript is there, the megabytes are not: the server stores only a
    // per-message image count, and the raw bytes 413'd on the 1MB JSON limit.
    expect(JSON.stringify(history)).not.toContain('base64');
    expect(JSON.stringify(history)).toContain('stage this room');
    expect(JSON.stringify(history)).toContain('"image_url"');
  });
});
