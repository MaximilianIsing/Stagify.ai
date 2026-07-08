// Masking Studio — happy-path smoke. Drives the real /masking-studio.html in Chromium:
// upload a room photo, paint a mask region with the rectangle tool (a real mouse drag,
// the only way the app records a painted mask), enter a prompt, and Apply Edit. The
// /api/mask-edit call is intercepted with a canned decodable image, so there is no real
// Gemini call and no cost; we assert the result actually renders in the UI.
import { test, expect } from '@playwright/test';
import { TINY_PNG_DATA_URL, roomPngBuffer, seedProSession } from './fixtures.js';

test.describe('Masking Studio — happy path', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    // Fires on upload; fails open on non-200 but stub it to stay fully offline/deterministic.
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
  });

  test('upload → paint a mask → prompt → Apply Edit renders a result (mocked /api/mask-edit)', async ({ page }) => {
    let maskEditCalls = 0;
    await page.route('**/api/mask-edit', (route) => {
      maskEditCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, editedImage: TINY_PNG_DATA_URL }),
      });
    });

    await page.goto('/masking-studio.html');

    // Gate passed once the hidden file input is present.
    const fileInput = page.locator('#ms-file-input');
    await expect(fileInput).toBeAttached();

    await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

    // Uploading auto-adds an active layer; its prompt textarea appearing means the base
    // image finished loading and the studio is in the draw phase.
    const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
    await expect(prompt).toBeVisible();

    // Rectangle tool gives a large, reliable paint gesture (avoids the wand tool, which
    // would hit /api/segment). A real drag is required — the app sets `painted` only from
    // pointer events, there is no programmatic mask setter.
    await page.locator('#ms-rect-btn').click();
    const stack = page.locator('#ms-stack');
    await expect(stack).toBeVisible();
    // The canvas can sit under the sticky site header / partly off-screen; centre it so
    // the paint drag lands on the canvas (page.mouse uses absolute coords, no auto-scroll).
    await stack.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await stack.boundingBox();
    // Drag a marquee across the lower-middle of the canvas (clear of the header).
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 12 });
    await page.mouse.up();

    await prompt.fill('a cozy modern sofa and a soft rug');

    // Submit enables only with a base image + a painted, prompted layer.
    const generate = page.locator('#ms-generate');
    await expect(generate).toBeEnabled();
    await generate.click();

    // Happy path rendered: the layer flips to done and the result becomes viewable.
    await expect(page.locator('.ms-layer-status--done').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#ms-view-result')).toBeVisible();
    expect(maskEditCalls).toBeGreaterThan(0);
  });
});
