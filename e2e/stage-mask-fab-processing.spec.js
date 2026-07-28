// Main Stagify tool (index.html) — the mask FAB while a staging run is in flight.
//
// The photo blurs during generation (.viewer-image.processing), but the paint-brush
// FAB sitting on top of it used to stay sharp AND clickable, so you could open the
// mask editor on an image that was still being generated. It now blurs with the
// photo and stops taking clicks; the keyboard path is guarded in JS because
// pointer-events cannot cover it.
//
// /api/validate-image is mocked and /api/process-image is held open (never
// fulfilled) so the in-flight state can be inspected — no real generation, no cost.
import { test, expect } from '@playwright/test';
import { openStageModalViaUI, roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

async function startStaging(page) {
  await page.route('**/api/validate-image', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, code: null, reason: '' }),
    }),
  );
  // Held open on purpose: the request stays pending, so the page stays in its
  // processing state for as long as the assertions need.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/process-image', async (route) => {
    await held;
    await route.abort();
  });

  await openStageModalViaUI(page);

  await page.locator('#stage-file-input').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: await roomPngBuffer(),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();

  const fab = page.locator('#mask-edit-btn');
  await expect(fab).toBeVisible(); // pro user + an image loaded

  await page.locator('#process-btn').click();
  await expect(page.locator('#stage-preview')).toHaveClass(/processing/);

  return { fab, release };
}

test.describe('Main tool — mask FAB during staging', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('blurs with the photo and stops taking clicks while generating', async ({ page }) => {
    const { fab, release } = await startStaging(page);

    // Same treatment the photo gets (.viewer-image.processing → blur(3px)), and
    // it fades in over the same .3s, so poll for the settled value.
    await expect
      .poll(() => fab.evaluate((el) => getComputedStyle(el).filter))
      .toContain('blur(3px)');
    expect(await fab.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

    // The editor activates its modal from an async image onload, so a bare
    // negative assertion would pass before activation could even happen. Give
    // each attempt time to land before checking that it did not.
    const modal = page.locator('#stage-mask-modal');
    const settle = () => page.waitForTimeout(400);

    // A real click cannot reach it, so the mask modal never opens.
    await fab.click({ force: true, timeout: 5000 }).catch(() => {});
    await settle();
    await expect(modal).not.toHaveClass(/active/);

    // Keyboard/programmatic activation is guarded in JS too — .click() dispatches
    // straight to the handler, which `pointer-events: none` cannot prevent.
    await fab.evaluate((el) => /** @type {HTMLElement} */ (el).click());
    await settle();
    await expect(modal).not.toHaveClass(/active/);

    release();
  });

  test('is sharp and clickable again once the run ends', async ({ page }) => {
    const { fab, release } = await startStaging(page);
    release();

    // The aborted request drops the page out of its processing state.
    await expect(page.locator('#stage-preview')).not.toHaveClass(/processing/);

    // Fades back out over the same .3s.
    await expect
      .poll(() => fab.evaluate((el) => getComputedStyle(el).filter))
      .not.toContain('blur(3px)');
    expect(await fab.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe('none');

    await fab.click();
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
  });
});
