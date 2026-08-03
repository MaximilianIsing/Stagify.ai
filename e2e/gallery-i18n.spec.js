// Switching language on the gallery, in a real browser.
//
// The gallery is the only page with a language switcher and NO localized URL. The shared
// switcher normally navigates to the localized URL of the current page; here that would
// resolve to the locale HOME (i18n-routing.js:59) and throw the visitor off their own
// gallery onto the marketing page. It opts out with [data-lang-inplace] instead.
//
// Both halves are asserted, because a change that simply broke navigation everywhere
// would pass the first test on its own: the gallery must STAY, and a localized page must
// still GO.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 6, 27),
  width: 1024,
  height: 683,
  roomType: 'Living room',
  furnitureStyle: 'modern',
  removeFurniture: false,
  urls: {
    after: '/media-webp/Homepage/BeforeAfter/After1.webp',
    before: '/media-webp/Homepage/BeforeAfter/Before1.webp',
    thumb: '/media-webp/Homepage/BeforeAfter/After1.webp',
  },
  references: [],
  share: { active: false },
};

/** Pick a language through the custom switcher, the way a visitor does. */
async function choose(page, value) {
  await page.locator('.lang-switch__trigger').click();
  await page.locator(`.lang-switch__option[data-value="${value}"]`).click();
}

test.describe('Gallery — language switching', () => {
  test.skip(({ isMobile }) => isMobile, 'the gallery is a PC-only page');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await page.route('**/api/gallery**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [ENTRY], total: 1, enabled: true }),
    }));
  });

  test('picking a language translates the page without leaving it', async ({ page }) => {
    await page.goto('/gallery.html');
    await expect(page.locator('.gal-title')).toHaveText('Your gallery');
    await expect(page.locator('#gal-count')).toHaveText('1 staged room');

    await choose(page, 'spanish');

    // The whole point: still on the gallery.
    await expect(page).toHaveURL(/\/gallery\.html$/);
    await expect(page.locator('.gal-main')).toBeVisible();

    // Markup strings come from [data-lang]…
    await expect(page.locator('.gal-title')).toHaveText('Tu galería');
    // …and the count is built in JS, which is the half applyLanguageToElements() cannot
    // reach — it only repaints because gallery-app.js listens for "languagechange".
    await expect(page.locator('#gal-count')).toHaveText('1 estancia amueblada');
  });

  test('the choice survives a reload, since there is no localized URL to carry it', async ({ page }) => {
    await page.goto('/gallery.html');
    await choose(page, 'german');
    await expect(page.locator('.gal-title')).toHaveText('Ihre Galerie');

    await page.reload();
    await expect(page).toHaveURL(/\/gallery\.html$/);
    await expect(page.locator('.gal-title')).toHaveText('Ihre Galerie');
  });

  test('the detail panel opens in the chosen language', async ({ page }) => {
    await page.goto('/gallery.html');
    await choose(page, 'french');

    await page.locator('.gal-card').first().click();
    await expect(page.locator('#gal-detail')).toBeVisible();
    await expect(page.locator('.gal-share__title')).toHaveText('Partager');
    // #gal-meta is built by renderMeta() at open time, so it comes from the pack in JS
    // rather than from a [data-lang] sweep over the markup.
    await expect(page.locator('#gal-meta')).toContainText('Pièce');
    await expect(page.locator('#gal-share-status')).toHaveText('Pas encore de lien.');
  });

  test('the language pill is hidden behind the detail panel, not dimmed under it', async ({ page }) => {
    // Same treatment .modal and the stage mask editor already get (styles.css:1903).
    // The pill lives in <main>, so without this it sits under the overlay still looking
    // like a control — and it is not reachable while the dialog traps focus.
    // Asserted on the pill itself: .language-picker-container is a height:0 hook and
    // never has a box of its own, so toBeVisible() reads it as hidden either way.
    const pill = page.locator('.lang-switch__trigger');
    await page.goto('/gallery.html');
    await expect(pill).toBeVisible();

    await page.locator('.gal-card').first().click();
    await expect(page.locator('#gal-detail')).toBeVisible();
    await expect(pill).toBeHidden();

    await page.locator('#gal-detail-close').click();
    await expect(pill).toBeVisible();
  });

  test('a page that HAS a localized URL still navigates to it', async ({ page }) => {
    // The paired positive. Without it, breaking the switcher outright would look green.
    await page.goto('/guides.html');
    await choose(page, 'spanish');
    await expect(page).toHaveURL(/\/es\/guides\.html$/);
  });
});
