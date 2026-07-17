// Masking Studio — refine "Snap to object" smoke. Drives the real studio through
// a run whose mocked /api/mask-edit returns an object that overhangs the painted
// mask, then asserts the refine step surfaces a Snap-to-object suggestion and that
// accepting it grows the mask (the suggestion is consumed) without error. The
// pixel math itself is unit-tested (test/masking-studio-spill.test.js); this locks
// in the wiring: run → detect spill → button → apply → recomposite.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession, spilloverEditedDataUrl } from './fixtures.js';

test.describe('Masking Studio — snap to object', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
  });

  test('an edit that spills past the highlight offers Snap to object, and accepting it consumes the suggestion', async ({ page }) => {
    const editedImage = await spilloverEditedDataUrl();
    await page.route('**/api/mask-edit', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, editedImage }),
      }),
    );

    await page.goto('/masking-studio.html');
    const fileInput = page.locator('#ms-file-input');
    await expect(fileInput).toBeAttached();
    await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

    const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
    await expect(prompt).toBeVisible();

    // Paint a rectangle mask over the middle of the canvas (same reliable gesture as
    // the happy-path smoke). The mocked object overlaps this and pokes out to the right.
    await page.locator('#ms-rect-btn').click();
    const stack = page.locator('#ms-stack');
    await stack.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await stack.boundingBox();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 12 });
    await page.mouse.up();

    await prompt.fill('a cozy modern sofa');
    const generate = page.locator('#ms-generate');
    await expect(generate).toBeEnabled();
    await generate.click();

    // Run finished → the refine step detected the overhang and offered the snap.
    await expect(page.locator('.ms-layer-status--done').first()).toBeVisible({ timeout: 20000 });
    const snapBtn = page.locator('.ms-snap-btn');
    await expect(snapBtn).toBeVisible();
    await expect(page.locator('.ms-layer-spill-flag').first()).toBeVisible();

    // Accepting the snap grows the mask and consumes the suggestion (button retires),
    // and the area stays staged (no error, still done).
    await snapBtn.click();
    await expect(page.locator('.ms-snap-btn')).toHaveCount(0);
    await expect(page.locator('.ms-layer-status--done').first()).toBeVisible();
  });
});
