// Searching the gallery, in a real browser.
//
// What a browser can check that the unit specs cannot is the half that is CSS: the box is
// revealed by an attribute gallery-app.js sets from the listing, and a free account must
// end up with it genuinely not on screen rather than merely marked off. A stylesheet rule
// that never matched would leave a paid feature visible to everyone, and no assertion
// against the document stand-in would notice.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

const ROOMS = [
  { id: 'r1', roomType: 'Bedroom', furnitureStyle: 'luxury' },
  { id: 'r2', roomType: 'Kitchen', furnitureStyle: 'coastal' },
];

const entryFor = (room) => ({
  createdAt: Date.UTC(2026, 6, 27),
  width: 1024,
  height: 683,
  name: '',
  additionalPrompt: '',
  removeFurniture: false,
  urls: {
    after: '/media-webp/Homepage/BeforeAfter/After1.webp',
    before: '/media-webp/Homepage/BeforeAfter/Before1.webp',
    thumb: '/media-webp/Homepage/BeforeAfter/After1.webp',
  },
  references: [],
  share: { url: 'https://stagify.ai/s/TOKEN', viewCount: 0 },
  ...room,
});

test.describe('Gallery — search', () => {
  test.skip(({ isMobile }) => isMobile, 'the gallery is a PC-only page');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  /** Serve the listing, filtering the way routes/gallery.js does. */
  async function stubListing(page, { pro = true } = {}) {
    await page.route('**/api/gallery?**', (route) => {
      const q = pro ? (new URL(route.request().url()).searchParams.get('q') ?? '') : '';
      const terms = q.trim().split(/\s+/).filter(Boolean);
      const matches = ROOMS.filter((room) => {
        const hay = `${room.furnitureStyle} ${room.roomType}`.toLowerCase();
        return terms.every((term) => hay.includes(term.toLowerCase()));
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: matches.map(entryFor),
          total: matches.length,
          enabled: true,
          search: { enabled: pro, q },
        }),
      });
    });
  }

  test('a Stagify+ account can narrow the grid to one room', async ({ page }) => {
    await stubListing(page);
    await page.goto('/gallery.html');

    const box = page.locator('#gal-search-input');
    await expect(box).toBeVisible();
    await expect(page.locator('.gal-card')).toHaveCount(2);

    await box.fill('kitchen');
    // The grid settles after the debounce; Playwright retries until it does.
    await expect(page.locator('.gal-card')).toHaveCount(1);
    await expect(page.locator('.gal-card').first()).toContainText('Coastal Kitchen');
    await expect(page.locator('#gal-count')).toHaveText('1 match');
  });

  test('the derived name is searchable, so typing what is on the card works', async ({ page }) => {
    await stubListing(page);
    await page.goto('/gallery.html');

    await page.locator('#gal-search-input').fill('luxury bedroom');
    await expect(page.locator('.gal-card')).toHaveCount(1);
    await expect(page.locator('.gal-card').first()).toContainText('Luxury Bedroom');
  });

  test('no matches gets its own panel, not "nothing staged yet"', async ({ page }) => {
    await stubListing(page);
    await page.goto('/gallery.html');

    await page.locator('#gal-search-input').fill('conservatory');
    await expect(page.locator('.gal-state--no-results')).toBeVisible();
    await expect(page.locator('.gal-state--empty')).toBeHidden();
    await expect(page.locator('#gal-no-results-detail')).toContainText('conservatory');
    // The box has to stay on screen, or there is no way back from the query that emptied it.
    await expect(page.locator('#gal-search-input')).toBeVisible();

    await page.locator('#gal-search-reset').click();
    await expect(page.locator('.gal-card')).toHaveCount(2);
    await expect(page.locator('#gal-search-input')).toHaveValue('');
  });

  test('the × clears the query and comes back only when there is text', async ({ page }) => {
    await stubListing(page);
    await page.goto('/gallery.html');

    const clear = page.locator('#gal-search-clear');
    await expect(clear).toBeHidden();

    await page.locator('#gal-search-input').fill('kitchen');
    await expect(clear).toBeVisible();
    await expect(page.locator('.gal-card')).toHaveCount(1);

    await clear.click();
    await expect(clear).toBeHidden();
    await expect(page.locator('.gal-card')).toHaveCount(2);
  });

  test('a FREE account never sees the box — the CSS rule is what enforces it', async ({ page }) => {
    // The unit spec pins the attribute; only a browser proves the stylesheet acts on it.
    await stubListing(page, { pro: false });
    await page.goto('/gallery.html');

    await expect(page.locator('.gal-card')).toHaveCount(2);
    await expect(page.locator('.gal-search')).toBeHidden();
    await expect(page.locator('#gal-search-input')).toBeHidden();
  });
});
