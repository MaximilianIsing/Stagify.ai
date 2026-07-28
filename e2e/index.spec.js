// Home page — load smoke. Drives the real /index.html (NOT auth-gated, so no
// seedProSession) in Chromium and asserts the page boots cleanly: no uncaught
// errors, the hero stats line renders, a custom select opens on click, and the
// before/after carousel controls exist. The two hero-stat count endpoints are
// mocked so the numbers are deterministic; everything else is the real app.
import { test, expect } from '@playwright/test';
import { stubAnalytics } from './fixtures.js';

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

    // Keep the Google Ads tag (gtag.js) from making real external calls.
    await stubAnalytics(page);

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

  test('the deferred Google Ads tag still initializes', async ({ page }) => {
    // scripts/gtag.js is `defer` so it stops blocking the parser ahead of every
    // stylesheet. The risk of that change is silent: the tag would simply stop
    // setting up, and nobody would notice until conversions dried up. So assert the
    // two things the tag actually has to leave behind — a callable `gtag` and the
    // config queued on dataLayer. Neither depends on the external loader, which
    // stubAnalytics aborts.
    await page.goto('/');
    await expect(page.locator('#room-type-select')).toBeAttached();

    const state = await page.evaluate(() => ({
      gtagType: typeof window.gtag,
      configured: window.__gtagConfigured === true,
      entries: (window.dataLayer || []).map((args) => Array.from(args).join(':')),
    }));

    expect(state.gtagType).toBe('function');
    expect(state.configured).toBe(true);
    expect(state.entries.some((e) => e.startsWith('js:'))).toBe(true);
    expect(state.entries.some((e) => e === 'config:AW-18274233484')).toBe(true);
  });
});
