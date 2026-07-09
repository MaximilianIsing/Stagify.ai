// Home page — load smoke. Drives the real /index.html (NOT auth-gated, so no
// seedProSession) in Chromium and asserts the page boots cleanly: no uncaught
// errors, the hero stats line renders, a custom select opens on click, and the
// before/after carousel controls exist. The two hero-stat count endpoints are
// mocked so the numbers are deterministic; everything else is the real app.
import { test, expect } from '@playwright/test';

test.describe('Home page — load smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Same staging-banner neutralisation as fixtures.seedProSession (the
    // IS_STAGING banner is a max-z-index sticky bar that overlays the page and
    // intercepts pointer events) — without the auth seeding, which index.html
    // doesn't need.
    await page.addInitScript(() => {
      try {
        const s = document.createElement('style');
        s.textContent = '#stagify-staging-banner{display:none !important}';
        document.documentElement.appendChild(s);
      } catch { /* ignore */ }
    });

    await page.route('**/api/prompt-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ promptCount: 1234 }) }),
    );
    await page.route('**/api/contact-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ usersServed: 567 }) }),
    );
  });

  test('loads cleanly with hero stats, working custom select, and before/after controls', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/index.html');

    // Hero stats line renders (stat pills are populated from the mocked counts).
    await expect(page.locator('#hero-stats')).toBeVisible();
    await expect(page.locator('.stat-pill-number[data-stat="roomsStaged"]')).toBeAttached();
    await expect(page.locator('.stat-pill-number[data-stat="usersServed"]')).toBeAttached();

    // Before/After toggle and version-carousel arrows exist. They live inside
    // the (initially hidden) image viewer, so assert presence, not visibility.
    await expect(page.locator('#toggle-before')).toBeAttached();
    await expect(page.locator('#toggle-after')).toBeAttached();
    await expect(page.locator('#carousel-prev')).toBeAttached();
    await expect(page.locator('#carousel-next')).toBeAttached();

    // Custom select opens on click. The stage modal starts hidden (and opening
    // it through the UI requires sign-in), so lift the .hidden class exactly
    // like the app's own openModal() does, then drive the real select wiring.
    await page.evaluate(() => {
      const modal = document.getElementById('stage-modal');
      if (modal) modal.classList.remove('hidden');
    });
    const roomSelect = page.locator('#room-type-select');
    await expect(roomSelect).toBeVisible();
    const menu = roomSelect.locator('.select-menu');
    await expect(menu).toHaveClass(/hidden/);
    await roomSelect.locator('.select-trigger').click();
    await expect(menu).not.toHaveClass(/hidden/);

    // No uncaught exceptions; no console errors beyond resource-load noise
    // (e.g. an aborted media fetch logs "Failed to load resource").
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((t) => !/Failed to load resource/i.test(t))).toEqual([]);
  });
});
