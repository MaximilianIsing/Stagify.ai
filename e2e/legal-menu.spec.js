// The footer's "Legal" disclosure, in a real browser.
//
// Privacy Policy and Terms of Service used to be two bare footer links; they now live
// in a menu alongside Subprocessors and the Enterprise MSA. The markup side is pinned
// by test/frontend/site-footer-parity.test.js across all eleven hand-copied footers —
// what only a browser can prove is that the thing actually opens, that the rows are
// hidden until it does, that it lands centred on the trigger without running off the
// screen, and that public/scripts/legal-menu.js adds what a native <details> does not
// have: Escape, outside click, arrow keys, and an exit that fades instead of vanishing.
//
// Run on about.html rather than the home page: it carries the identical footer with
// none of the home page's boot work, so nothing here can fail for an unrelated reason.

import { test, expect } from '@playwright/test';
import { stubAnalytics } from './fixtures.js';

const MENU = 'footer [data-legal-menu]';
const TRIGGER = `${MENU} .legal-menu__trigger`;
const ITEM = `${MENU} .legal-menu__item`;

/** The four documents, in the order the panel lists them. */
const DOCS = [
  'privacy.html',
  'terms.html',
  'legal/subprocessors.html',
  'legal/enterprise-msa.html',
];

test.beforeEach(async ({ page }) => {
  await stubAnalytics(page);
  await page.goto('/about.html');
});

/**
 * Wait until legal-menu.js has wired itself up.
 *
 * Everything below the first two tests is behaviour that module ADDS, and the menu
 * is fully usable before it lands — so "press Escape, expect closed" is a race
 * against the script's own arrival, not a test of anything. The module flips
 * data-legal-menu to "ready" when it has bound; that is the signal.
 */
function enhanced(page) {
  return expect(page.locator(MENU)).toHaveAttribute('data-legal-menu', 'ready');
}

test('the trigger is visible and the documents are not, until it is opened', async ({ page }) => {
  await expect(page.locator(TRIGGER)).toBeVisible();
  await expect(page.locator(ITEM).first()).toBeHidden();

  await page.locator(TRIGGER).click();

  const items = page.locator(ITEM);
  await expect(items).toHaveCount(DOCS.length);
  for (let i = 0; i < DOCS.length; i++) {
    await expect(items.nth(i)).toBeVisible();
    await expect(items.nth(i)).toHaveAttribute('href', DOCS[i]);
  }
});

test('a row navigates to its document', async ({ page }) => {
  await page.locator(TRIGGER).click();
  await page.locator(`${ITEM}[href="terms.html"]`).click();
  await expect(page).toHaveURL(/\/terms\.html$/);
});

test('Escape closes it and puts focus back on the trigger', async ({ page }) => {
  await enhanced(page);
  await page.locator(TRIGGER).click();
  await expect(page.locator(ITEM).first()).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.locator(ITEM).first()).toBeHidden();
  await expect(page.locator(TRIGGER)).toBeFocused();
});

test('a click outside closes it', async ({ page }) => {
  await enhanced(page);
  await page.locator(TRIGGER).click();
  await expect(page.locator(ITEM).first()).toBeVisible();

  // The copyright line, i.e. inside the same footer but outside the menu — a weaker
  // click target than the page body, and the one a stray tap actually lands on.
  await page.locator('footer .footer-year').click();

  await expect(page.locator(ITEM).first()).toBeHidden();
});

test('the arrow keys walk the rows', async ({ page }) => {
  await enhanced(page);
  await page.locator(TRIGGER).click();
  const items = page.locator(ITEM);

  // Focus starts on the trigger, so the first ArrowDown lands on row one.
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.nth(0)).toBeFocused();
  // Up from the first row wraps to the last rather than trapping focus at the top.
  await page.keyboard.press('ArrowUp');
  await expect(items.nth(DOCS.length - 1)).toBeFocused();
});

test('the panel is centred on the trigger, and stays on screen when it cannot be', async ({ page, isMobile }) => {
  await enhanced(page);
  await page.locator(TRIGGER).click();
  await expect(page.locator(ITEM).first()).toBeVisible();
  // Let the entry transition settle: the panel is scaled to .96 while it runs, so a
  // rect read too early is a few px narrow and its centre is fine but its edges are not.
  await page.waitForTimeout(300);

  const { panel, trigger, viewport } = await page.evaluate(() => {
    const p = document.querySelector('.legal-menu__list').getBoundingClientRect();
    const t = document.querySelector('.legal-menu__trigger').getBoundingClientRect();
    return {
      panel: { left: p.left, right: p.right, centre: p.left + p.width / 2 },
      trigger: { centre: t.left + t.width / 2 },
      viewport: window.innerWidth,
    };
  });

  // Never off the edge — this is what the shift legal-menu.js measures is for.
  expect(panel.left).toBeGreaterThanOrEqual(0);
  expect(panel.right).toBeLessThanOrEqual(viewport);

  if (isMobile) {
    // The trigger is the first item in a centre-aligned footer line, so on a phone it
    // sits far enough left that a centred panel cannot fit. Being on screen wins.
    return;
  }
  expect(Math.abs(panel.centre - trigger.centre)).toBeLessThan(2);
});

test('the panel fades in and out rather than popping', async ({ page }) => {
  await enhanced(page);

  // Ask the browser what is actually animating, rather than sampling opacity frame by
  // frame: requestAnimationFrame is throttled in a headless run, and a sampler that
  // gets two frames in 300ms reports a fade as a pop. The panel only — the rows carry a
  // stagger, so whether a given one has started by the time this reads is a race, and
  // if the panel is animating they are too.
  const running = () => page.evaluate(() => document.querySelector('.legal-menu__list')
    .getAnimations().map((a) => a.transitionProperty));

  // Both directions had to be made to work, for different reasons. The entry needs
  // @starting-style, because a closed <details> does not render its content and so has
  // no style to transition FROM. The exit needs legal-menu.js to hold `open` on until
  // the fade is done, because dropping it un-renders the content immediately.
  await page.locator(TRIGGER).click();
  const opening = await running();
  expect(opening).toEqual(expect.arrayContaining(['opacity', 'transform']));
  await expect(page.locator(ITEM).first()).toBeVisible();

  await page.waitForTimeout(400);
  await page.locator(TRIGGER).click();
  const closing = await running();
  expect(closing).toEqual(expect.arrayContaining(['opacity', 'transform']));
  await expect(page.locator(ITEM).first()).toBeHidden();
});

test('it still works with the enhancement script blocked', async ({ page }) => {
  // The whole reason this is a <details> and not a button+panel: the footer is copied
  // by hand into eleven files, so the fewer of them that depend on a module loading,
  // the better. Opening and closing must survive legal-menu.js failing to arrive.
  await page.route('**/scripts/legal-menu.js', (route) => route.abort());
  await page.goto('/about.html');

  await page.locator(TRIGGER).click();
  await expect(page.locator(ITEM).first()).toBeVisible();
  await page.locator(TRIGGER).click();
  await expect(page.locator(ITEM).first()).toBeHidden();
});
