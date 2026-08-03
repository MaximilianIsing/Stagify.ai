// Copying a gallery share link, in a real browser.
//
// Every entry arrives with its link, so there is no mint to drive here — what a browser
// can check that a unit spec cannot is that the URL is USABLE (absolute, not a bare
// `/s/<token>` path — it shipped that way, because routes/gallery.js read an APP_ORIGIN
// that is set nowhere) and that pressing copy really puts it on the clipboard.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

const LINK = 'https://stagify.ai/s/vfbNvr17oViBGBBY0i8a7Ku4Z1fNLravcKb4w8PjUM4';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 6, 27),
  width: 1024,
  height: 683,
  roomType: 'Living room',
  removeFurniture: false,
  urls: {
    after: '/media-webp/Homepage/BeforeAfter/After1.webp',
    before: '/media-webp/Homepage/BeforeAfter/Before1.webp',
    thumb: '/media-webp/Homepage/BeforeAfter/After1.webp',
  },
  references: [],
  share: { url: LINK, viewCount: 0 },
};

test.describe('Gallery — share link', () => {
  test.skip(({ isMobile }) => isMobile, 'the gallery is a PC-only page');

  test.beforeEach(async ({ page, context, browserName }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await seedProSession(page);
  });

  /** Serve the listing, which is the only call the share panel depends on. */
  async function stubListing(page, entry) {
    await page.route('**/api/gallery?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [entry], total: 1, enabled: true }),
    }));
  }

  test('opening a render shows a usable link, and copying it really copies it', async ({ page, browserName }) => {
    await stubListing(page, ENTRY);
    await page.goto('/gallery.html');
    await page.locator('.gal-card').first().click();

    const field = page.locator('#gal-share-url');
    await expect(field).toBeVisible();

    const value = await field.inputValue();
    expect(value).not.toMatch(/^\/s\//);
    expect(() => new URL(value)).not.toThrow();
    expect(new URL(value).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);

    await page.locator('#gal-share-copy').click();
    await expect(page.locator('#gal-share-status')).toContainText(/copied/i);

    if (browserName === 'chromium') {
      const onClipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(onClipboard).toBe(value);
    }
  });

  test('there is nothing to press first, and nothing that would replace the link', async ({ page }) => {
    // The model: a link is not created and cannot be turned off. Both buttons are gone,
    // and reopening the render a week later has to show the URL already sent.
    await stubListing(page, { ...ENTRY, share: { url: LINK, viewCount: 4 } });
    await page.goto('/gallery.html');
    await page.locator('.gal-card').first().click();

    await expect(page.locator('#gal-share-url')).toHaveValue(LINK);
    await expect(page.locator('#gal-share-status')).toContainText(/opened 4 times/i);
    await expect(page.locator('#gal-share-create')).toHaveCount(0);
    await expect(page.locator('#gal-share-revoke')).toHaveCount(0);
  });

  test('no card claims a link is on, because they all have one', async ({ page }) => {
    await stubListing(page, ENTRY);
    await page.goto('/gallery.html');
    const card = page.locator('.gal-card').first();
    await expect(card).toBeVisible();
    await expect(card).not.toContainText(/link on/i);
  });
});
