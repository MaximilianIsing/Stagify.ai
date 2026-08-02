// The top nav's "Staging" dropdown, in a real browser.
//
// It replaced two bare links that were hidden from free users, so the two things
// worth proving here are the ones a DOM-stubbed unit test cannot:
//
//   - a free user SEES all four tools and can only use one of them. The lock is
//     now presentational (a class + aria-disabled), so this drives the click and
//     checks where the browser actually ends up;
//   - "Image Staging" and "Basic Mask" open the home page's screens both in place
//     (window hook) and after a navigation (URL fragment) — two different code
//     paths to the same dialog, and only one of them is exercised if you always
//     start on the home page.
//
// Every /api/* call is mocked (see fixtures.js) — no model calls, no cost.

import { test, expect } from '@playwright/test';
import { seedProSession, seedFreeSession, waitForHomeReady } from './fixtures.js';

const MENU = '[data-staging-menu]';
const TRIGGER = '.staging-menu__trigger';
const ITEM = '.staging-menu__item';

/** Open the dropdown the way a user does, and hand back its rows. */
async function openMenu(page) {
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU)).toHaveAttribute('data-open', '');
  return page.locator(`${MENU} ${ITEM}`);
}

test.describe('Staging dropdown — desktop', () => {
  // The menu carries `desktop-only` on purpose (see the mobile test at the end),
  // so there is nothing to click below 768px.
  test.skip(({ isMobile }) => isMobile, 'the Staging menu is desktop-only by design');

  test('lists the four tools in order and opens on click', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    // Closed until asked: the panel is pointer-inert without [data-open].
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');

    const items = await openMenu(page);
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('Image Staging');
    await expect(items.nth(1)).toContainText('Basic Mask');
    await expect(items.nth(2)).toContainText('AI Designer');
    await expect(items.nth(3)).toContainText('Masking Studio');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape and an outside click both close it', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');

    await openMenu(page);
    await page.locator('.brand').click({ trial: true });
    await page.mouse.click(5, 400); // well away from the nav
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
  });

  // The sliding pill lends itself to the trigger while the menu is open, then
  // goes back. Regression: nav-pill.js locks `active` to any clicked link so the
  // pill survives a slow navigation — but the trigger does not navigate, so that
  // lock stranded the pill on "Staging" for the rest of the page's life.
  // `.is-lit` is the class moveTo() puts on whatever the pill is currently under.
  test('the pill returns to the current page when the menu closes', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const home = page.locator('.nav-center .nav-link', { hasText: 'Home' });
    const trigger = page.locator(TRIGGER);
    await expect(home).toHaveClass(/is-lit/);

    await openMenu(page);
    await expect(trigger).toHaveClass(/is-lit/, { timeout: 5000 });
    await expect(home).not.toHaveClass(/is-lit/);

    // Dismiss by clicking away — the path that had no click on the trigger at
    // all, so nothing else would have prompted a re-settle.
    await page.mouse.click(5, 400);
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(home).toHaveClass(/is-lit/);
    await expect(trigger).not.toHaveClass(/is-lit/);
  });

  test('the pill returns after the menu is dismissed with Escape', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const home = page.locator('.nav-center .nav-link', { hasText: 'Home' });
    await openMenu(page);
    await expect(page.locator(TRIGGER)).toHaveClass(/is-lit/, { timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(home).toHaveClass(/is-lit/);
  });

  test('the pill rests on Staging while on one of its own pages', async ({ page }) => {
    // The other half: the trigger stands for the pages its rows link to, so the
    // pill should sit on it on ai-designer.html — that is what the two links it
    // replaced used to do for themselves.
    await seedProSession(page);
    await page.goto('/ai-designer.html');
    await expect(page.locator(TRIGGER)).toHaveClass(/is-lit/, { timeout: 5000 });
  });

  test('a Pro user gets all four unlocked', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    for (let i = 0; i < 4; i += 1) {
      await expect(items.nth(i)).not.toHaveClass(/is-locked/);
      // The chip is what carries "this is Stagify+" into the a11y tree, so an
      // unlocked row must not still be announcing it. Asserted as visibility,
      // not text: the chip is display:none rather than absent, and textContent
      // (what toContainText reads) includes hidden descendants.
      await expect(items.nth(i).locator('.staging-menu__badge')).toBeHidden();
    }
  });

  test('Image Staging opens the stage dialog in place on the home page', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const modal = page.locator('#stage-modal');
    await expect(modal).toHaveClass(/hidden/);

    const items = await openMenu(page);
    await items.nth(0).click();

    await expect(modal).not.toHaveClass(/hidden/);
    // Opened in place: the hook ran instead of the href, so no fragment is left
    // behind to reopen the dialog on the next refresh.
    expect(new URL(page.url()).hash).toBe('');
  });

  test('Image Staging from another page navigates home and opens the dialog', async ({ page }) => {
    // The other half of the entry: off the home page the hooks do not exist, so
    // the row is a plain link and app/staging-entry.js consumes the fragment.
    await seedProSession(page);
    await page.goto('/guides.html');

    const items = await openMenu(page);
    await items.nth(0).click();

    await page.waitForURL(/\/(index\.html)?(\?.*)?$/);
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
    expect(new URL(page.url()).hash).toBe('', 'the fragment is consumed, not left in the URL');
  });

  test('Basic Mask opens the mask editor standalone, with its own uploader', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const maskModal = page.locator('#stage-mask-modal');
    await expect(maskModal).not.toHaveClass(/active/);

    const items = await openMenu(page);
    await items.nth(1).click();

    await expect(maskModal).toHaveClass(/active/);
    // Standalone: no staging job behind it, so the dialog shows the dropzone
    // rather than a canvas of an image it does not have.
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await expect(page.locator('.stage-mask-canvas-container')).toBeHidden();
    await expect(page.locator('#stage-mask-modal .stage-mask-title')).toContainText('Basic Mask');
    // Reached without ever opening the staging flow.
    await expect(page.locator('#stage-modal')).toHaveClass(/hidden/);
  });

  test('a free user sees all four but only Image Staging is live', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    await expect(items).toHaveCount(4, 'the studios stay visible — that is the upsell');
    await expect(items.nth(0)).not.toHaveClass(/is-locked/);
    for (const i of [1, 2, 3]) {
      await expect(items.nth(i)).toHaveClass(/is-locked/);
      // A locked row stays an operable link (it goes to Stagify+), so the state
      // is announced by the visible chip rather than by aria-disabled.
      await expect(items.nth(i).locator('.staging-menu__badge')).toBeVisible();
      await expect(items.nth(i).locator('.staging-menu__lock')).toBeVisible();
    }
  });

  test('a free user clicking a locked tool lands on Stagify+', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    await items.nth(1).click(); // Basic Mask

    await page.waitForURL(/stagify-plus\.html/);
    // And emphatically NOT into the tool.
    await expect(page.locator('#stage-mask-modal')).toHaveCount(0);
  });

  test('a free user typing the Basic Mask URL is still turned away', async ({ page }) => {
    // The locked row is presentation, not a gate — the fragment is typeable and
    // survives a middle-click, so the entry re-checks the plan itself.
    await seedFreeSession(page);
    await page.goto('/index.html#basic-mask');
    await page.waitForURL(/stagify-plus\.html/);
  });

  test('a Pro user typing the Basic Mask URL gets the editor', async ({ page }) => {
    // The mirror of the test above — without it, "always redirect" would pass.
    await seedProSession(page);
    await page.goto('/index.html#basic-mask');
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
  });
});

test.describe('Staging dropdown — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is the mobile half of the nav');

  // The dropdown is the ONLY nav entry to Image Staging, Basic Mask, the AI Designer
  // and the Masking Studio. It used to be `desktop-only`, so a phone had no nav path
  // to any staging tool at all — including the two features Stagify+ is sold on, for
  // someone already paying. These two tests are why it can be shown again.

  test('a paying user can reach every staging tool from a phone', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await expect(page.locator(TRIGGER)).toBeVisible();
    const items = await openMenu(page);
    await expect(items).toHaveCount(4);
    for (const name of ['Image Staging', 'Basic Mask', 'AI Designer', 'Masking Studio']) {
      await expect(page.locator(ITEM).filter({ hasText: name })).toBeVisible();
    }
  });

  test('the open panel is anchored to the clipping box, so it can never be cut off', async ({ page }) => {
    // The reason the menu was hidden on phones: .nav-center clips the X axis, and a
    // panel anchored to its own trigger is a fixed 224px centred on that trigger —
    // so wherever the wrapping nav happens to put the trigger, the panel can run past
    // the clip and lose a row.
    //
    // Asserting only "the panel is on screen" is NOT enough: at this particular
    // viewport the trigger lands near the middle and 224px fits anyway, so that
    // assertion passes with the fix reverted. What the fix actually guarantees is
    // that the panel spans .nav-center — the very box doing the clipping — leaving
    // nothing to clip at ANY trigger position or viewport width. Pin that.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await openMenu(page);

    // Compare LAYOUT geometry (offsetWidth/clientWidth), not boundingBox(): the panel
    // animates in with a scale(.98)→scale(1) transition, and a transformed bounding
    // box is a few px narrower until it settles — which is measurement noise, not the
    // property under test. offsetWidth ignores transforms entirely.
    const geom = await page.evaluate(() => {
      const panel = document.querySelector('.staging-menu__panel');
      const clip = document.querySelector('.nav-center');
      return { panelWidth: panel.offsetWidth, clipWidth: clip.clientWidth };
    });

    // `left:0; right:0` against .nav-center makes the panel's border box exactly its
    // padding box. Anchored to the trigger instead, it is a fixed 224px.
    expect(geom.clipWidth).toBeGreaterThan(240);
    expect(Math.abs(geom.panelWidth - geom.clipWidth)).toBeLessThanOrEqual(2);

    // And it is genuinely usable, not merely laid out somewhere plausible.
    await expect(page.locator(ITEM).filter({ hasText: 'Masking Studio' })).toBeInViewport();
  });
});
