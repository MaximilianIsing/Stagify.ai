// The guides walkthrough tablist, in a real browser.
//
// The unit spec (test/frontend/guides/guides.test.js) drives initGuides() against a
// stand-in document. What only a real browser shows is that the page actually DELIVERS
// the hash to it: guides.js is a module, so it runs after parse, and the browser has
// already tried — and failed — to scroll to a `hidden` panel by then. If the hash were
// consumed or normalised before the script ran, every unit assertion would stay green
// while the published links kept landing on the wrong walkthrough.
import { test, expect } from '@playwright/test';
import { stubAnalytics } from './fixtures.js';

const PANEL = (key) => `#guide-demo-${key}`;
const TAB = (key) => `.guide-demo-picker__btn[data-demo="${key}"]`;

test.describe('Guides — walkthroughs', () => {
  test.skip(({ isMobile }) => isMobile, 'the picker is a desktop layout; the deep link is the same code');

  test.beforeEach(async ({ page }) => {
    await stubAnalytics(page);
  });

  test('a published HowTo deep link opens that walkthrough', async ({ page }) => {
    // This exact URL shape is what the JSON-LD on the page advertises to search engines.
    await page.goto('/guides.html#guide-demo-masking');

    await expect(page.locator(PANEL('masking'))).toBeVisible();
    await expect(page.locator(PANEL('free'))).toBeHidden();
    await expect(page.locator(TAB('masking'))).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(TAB('free'))).toHaveAttribute('aria-selected', 'false');
  });

  test('every walkthrough the structured data publishes is reachable by its own link', async ({ page }) => {
    // Read the advertised ids out of the shipped page rather than restating them, so a
    // renamed panel fails here instead of quietly breaking a live search result.
    await page.goto('/guides.html');
    const advertised = await page.evaluate(() => {
      const found = new Set();
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        for (const m of (el.textContent || '').matchAll(/guides\.html#(guide-demo-[a-z]+)/g)) found.add(m[1]);
      }
      return [...found];
    });
    expect(advertised.length).toBeGreaterThanOrEqual(5);

    for (const id of advertised) {
      await page.goto(`/guides.html#${id}`);
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test('the deep-linked walkthrough is scrolled into view, not left off-screen', async ({ page }) => {
    // The browser resolved the hash while the panel was still `hidden`, so it scrolled
    // nowhere; guides.js has to finish the job once the panel exists on screen.
    await page.goto('/guides.html#guide-demo-furniture');
    const panel = page.locator(PANEL('furniture'));
    await expect(panel).toBeVisible();

    await expect.poll(async () => panel.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.top < window.innerHeight && box.bottom > 0;
    })).toBe(true);
  });

  test('picking a walkthrough makes the URL shareable without piling up history', async ({ page }) => {
    await page.goto('/guides.html');
    const startLength = await page.evaluate(() => history.length);

    await page.locator(TAB('prompt')).click();
    await expect(page).toHaveURL(/#guide-demo-prompt$/);
    await page.locator(TAB('designer')).click();
    await expect(page).toHaveURL(/#guide-demo-designer$/);

    // replaceState, so two selections did not become two Back presses.
    expect(await page.evaluate(() => history.length)).toBe(startLength);
  });

  test('the tablist is one tab stop, and arrows move within it', async ({ page }) => {
    await page.goto('/guides.html');
    await page.locator(TAB('free')).focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.locator(TAB('plus'))).toBeFocused();
    await expect(page.locator(PANEL('plus'))).toBeVisible();

    await page.keyboard.press('End');
    await expect(page.locator(TAB('furniture'))).toBeFocused();
    await expect(page.locator(PANEL('furniture'))).toBeVisible();

    // Tab leaves the tablist entirely rather than walking the other five buttons.
    await page.keyboard.press('Tab');
    await expect(page.locator('.guide-demo-picker__btn')).toHaveCount(6);
    await expect(page.locator(TAB('free'))).not.toBeFocused();
    await expect(page.locator(TAB('plus'))).not.toBeFocused();
  });
});
