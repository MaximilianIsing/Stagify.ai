// The rotate-to-landscape view, in a real browser.
//
// WHY E2E AND NOT test/frontend/. The whole feature IS layout under a transform:
// whether a portaled node actually fills the viewport once it has left a 3D-transformed
// carousel panel, whether `position: fixed` escapes the `perspective` on .shw__stage,
// and whether the before/after wipe still tracks a finger after the stage has been
// turned 90deg. Every one of those is a computed box or a pointer hit-test; nothing
// below a real browser can see any of it. The unit spec
// (test/frontend/immersive-view.test.js) covers the portal/restore bookkeeping instead.
//
// THE REGRESSION THIS PINS. On a phone the fullscreen button was dead — iPhone Safari
// has no Element.requestFullscreen at all, and on guides the control stayed painted
// while doing nothing. The phone path now opens an overlay and rotates the content, so
// what has to hold is: the media really does fill the screen, the page behind really
// is locked, and every exit really does put things back where they were.
import { test, expect } from '@playwright/test';
import { stubAnalytics, hideStagingBanner } from './fixtures.js';

/** The overlay must be a child of <body>, not of the panel it came from. */
const OVERLAY = '.imv';

test.describe('Rotate to landscape — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'the rotate path is gated on (pointer: coarse) and a phone width');

  test.beforeEach(async ({ page }) => {
    await hideStagingBanner(page);
    await stubAnalytics(page);
    await page.route('**/api/prompt-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ promptCount: 1234 }) }),
    );
    await page.route('**/api/contact-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ usersServed: 567 }) }),
    );
  });

  test('the home showcase control opens a rotated, full-viewport view', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('[data-showcase].shw--ready')).toBeAttached({ timeout: 30000 });

    const btn = page.locator('.shw__panel[data-shw-state="front"] .shw__fs');
    await expect(btn).toBeVisible();
    // On a phone it is not a fullscreen toggle, and it must not claim to be.
    await expect(btn).toHaveClass(/is-mobile-rotate/);
    await expect(btn).toHaveAttribute('aria-label', /rotate/i);

    const scrolledTo = await page.evaluate(() => {
      window.scrollTo(0, 400);
      return window.scrollY;
    });
    await btn.tap();

    const overlay = page.locator(OVERLAY);
    await expect(overlay).toBeAttached();
    // THE important assertion. .shw__panel always carries a transform, .shw__stage has
    // `perspective` and .shw__panel-inner a `backdrop-filter` — each one alone makes an
    // ancestor the containing block for position:fixed. If the overlay were authored in
    // place it would be clipped to the ~520px panel box instead of the viewport.
    const parent = await overlay.evaluate((el) => el.parentElement.tagName);
    expect(parent).toBe('BODY');

    const box = await overlay.boundingBox();
    const vp = page.viewportSize();
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 2);
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 2);

    // Portrait device, landscape content: a quarter turn, i.e. matrix(0, 1, -1, 0, …).
    await expect(overlay).toHaveClass(/imv--rotated/);
    const m = await page.locator('.imv__stage').evaluate((el) => getComputedStyle(el).transform);
    expect(m).toMatch(/^matrix\(-?0?\.?0*\d*e?-?\d*,\s*1,/);

    // The media travelled with it, and is presented by the class-path twin of the
    // :fullscreen block rather than left at its in-page size.
    await expect(page.locator(`${OVERLAY} .shw__media.is-immersive`)).toBeVisible();

    // The page behind must not scroll under a thumb that runs off the content.
    await page.mouse.wheel(0, 500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0); // body is position:fixed

    await btn.tap();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    // Back where the reader was, in the panel they came from.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolledTo);
    await expect(page.locator('.shw__panel[data-shw-state="front"] .shw__media')).toBeVisible();
    expect(await page.evaluate(() => document.body.style.position)).toBe('');
  });

  test('Escape and the back gesture both close the view', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('[data-showcase].shw--ready')).toBeAttached({ timeout: 30000 });
    const btn = page.locator('.shw__panel[data-shw-state="front"] .shw__fs');

    // There is no native fullscreen here to consume Escape, so the module must.
    await btn.tap();
    await expect(page.locator(OVERLAY)).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    // And Android's back gesture, which is the first thing a phone user reaches for.
    await btn.tap();
    await expect(page.locator(OVERLAY)).toBeAttached();
    await page.goBack();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    // Still on the home page — the history entry the view pushed is what absorbed it.
    expect(new URL(page.url()).pathname).toMatch(/index\.html$|^\/$/);
  });

  test('the before/after wipe still tracks a finger once the stage is turned', async ({ page }) => {
    // getBoundingClientRect() reports the AXIS-ALIGNED box of a rotated element, so the
    // naive clientX mapping in staging-studio.js read the wrong axis entirely and the
    // wipe stopped responding. Under rotation the drag is a VERTICAL finger travel.
    await page.goto('/index.html');
    await expect(page.locator('[data-showcase].shw--ready')).toBeAttached({ timeout: 30000 });

    // Step the carousel to the exterior panel, the one with the .ba slider.
    const next = page.locator('[data-shw-arrow="1"]');
    for (let i = 0; i < 5; i += 1) {
      if (await page.locator('.shw__panel[data-shw-state="front"] .ba').count()) break;
      await next.tap();
      await page.waitForTimeout(450);
    }
    const ba = page.locator('.shw__panel[data-shw-state="front"] .ba');
    await expect(ba).toBeVisible();

    await page.locator('.shw__panel[data-shw-state="front"] .shw__fs').tap();
    await expect(page.locator(OVERLAY)).toHaveClass(/imv--rotated/);

    const before = await ba.evaluate((el) => getComputedStyle(el).getPropertyValue('--pos'));
    const box = await ba.boundingBox();
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height * 0.75, { steps: 8 });
    await page.mouse.up();
    const after = await ba.evaluate((el) => getComputedStyle(el).getPropertyValue('--pos'));
    expect(after).not.toBe(before);
  });

  test('the guides walkthrough control opens the same view', async ({ page }) => {
    await page.goto('/guides.html');
    const panel = page.locator('#guide-demo-free');
    await expect(panel).toBeVisible();
    // The player is injected after `load`; the control is hidden until it mounts.
    const btn = panel.locator('.guide-demo-fs');
    await expect(btn).toBeVisible({ timeout: 30000 });
    await expect(btn).toHaveClass(/is-mobile-rotate/);

    await btn.tap();
    const overlay = page.locator(OVERLAY);
    await expect(overlay).toBeAttached();
    expect(await overlay.evaluate((el) => el.parentElement.tagName)).toBe('BODY');
    // The PANEL is what travels, because it is the player's root — the frame, the
    // callout card and the step dots all have to move together.
    await expect(page.locator(`${OVERLAY} #guide-demo-free.is-immersive`)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    // Back inside the tabpanel stage, not stranded under <body>.
    await expect(page.locator('.guide-demo-stage #guide-demo-free')).toBeVisible();
  });
});

test.describe('Rotate to landscape — desktop is unchanged', () => {
  test.skip(({ isMobile }) => isMobile, 'this is the half that must NOT change');

  test('a desktop pointer still gets native fullscreen, not the overlay', async ({ page }) => {
    await hideStagingBanner(page);
    await stubAnalytics(page);
    await page.goto('/index.html');
    await expect(page.locator('[data-showcase].shw--ready')).toBeAttached({ timeout: 30000 });

    const btn = page.locator('.shw__panel[data-shw-state="front"] .shw__fs');
    await expect(btn).not.toHaveClass(/is-mobile-rotate/);
    await expect(btn).toHaveAttribute('aria-label', /fullscreen/i);

    await btn.click();
    // The media is promoted into the top layer; no overlay is built at all.
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    expect(await page.locator(OVERLAY).count()).toBe(0);
    await page.evaluate(() => document.exitFullscreen());
  });
});
