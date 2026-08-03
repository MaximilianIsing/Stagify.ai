// Minting and copying a gallery share link, in a real browser.
//
// The token comes back exactly once and has no read-back, so the two things that must
// hold are that the link is USABLE (absolute, not a bare `/s/<token>` path — it shipped
// that way, because routes/gallery.js read an APP_ORIGIN that is set nowhere) and that
// it can actually be taken off the screen. A unit spec can check the wiring; only a
// browser can check that the clipboard really received it.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

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
  share: { active: false },
};

test.describe('Gallery — share link', () => {
  test.skip(({ isMobile }) => isMobile, 'the gallery is a PC-only page');

  test.beforeEach(async ({ page, context, browserName }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await seedProSession(page);
    await page.route('**/api/gallery?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [ENTRY], total: 1, enabled: true }),
    }));
  });

  /** Mint a link whose URL the SERVER decided, so the shape is what the route returns. */
  async function stubMint(page, url) {
    await page.route('**/api/gallery/r1/share', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, url, token: 'TOKEN', share: { active: true, viewCount: 0 } }),
    }));
  }

  test('a freshly minted link is absolute, and copying it really copies it', async ({ page, browserName }) => {
    await stubMint(page, 'https://stagify.ai/s/vfbNvr17oViBGBBY0i8a7Ku4Z1fNLravcKb4w8PjUM4');
    await page.goto('/gallery.html');
    await page.locator('.gal-card').first().click();

    // Nothing to copy before there is a link.
    await expect(page.locator('#gal-share-copy')).toBeHidden();

    await page.locator('#gal-share-create').click();
    const field = page.locator('#gal-share-url');
    await expect(field).toBeVisible();

    const value = await field.inputValue();
    expect(value).not.toMatch(/^\/s\//);
    expect(() => new URL(value)).not.toThrow();
    expect(new URL(value).pathname).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);

    await expect(page.locator('#gal-share-copy')).toBeVisible();
    await page.locator('#gal-share-copy').click();
    await expect(page.locator('#gal-share-status')).toContainText(/copied/i);

    if (browserName === 'chromium') {
      const onClipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(onClipboard).toBe(value);
    }
  });

  test('reopening a shared render shows the SAME link, with nothing offering to replace it', async ({ page }) => {
    // A render has one link for its lifetime. Coming back to it a week later has to show
    // the URL already sent — and must not offer a button that would invalidate it.
    const live = 'https://stagify.ai/s/LIVEtoken0000000000000000000000000000000000';
    await page.route('**/api/gallery?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{ ...ENTRY, share: { active: true, viewCount: 4, url: live } }],
        total: 1,
        enabled: true,
      }),
    }));
    await page.goto('/gallery.html');
    await page.locator('.gal-card').first().click();

    await expect(page.locator('#gal-share-status')).toContainText(/opened 4 times/i);
    await expect(page.locator('#gal-share-url')).toHaveValue(live);
    await expect(page.locator('#gal-share-copy')).toBeVisible();
    await expect(page.locator('#gal-share-create')).toBeHidden();
  });

  test('a link from before tokens were stored cannot be shown, so a replacement is offered', async ({ page }) => {
    await page.route('**/api/gallery?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{ ...ENTRY, share: { active: true, viewCount: 1, url: '' } }],
        total: 1,
        enabled: true,
      }),
    }));
    await page.goto('/gallery.html');
    await page.locator('.gal-card').first().click();

    await expect(page.locator('#gal-share-status')).toContainText(/before links could be reopened/i);
    await expect(page.locator('#gal-share-url')).toBeHidden();
    await expect(page.locator('#gal-share-copy')).toBeHidden();
    await expect(page.locator('#gal-share-create')).toBeVisible();
  });
});
