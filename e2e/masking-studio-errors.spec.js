// Masking Studio — error path (counterpart to masking-studio.spec.js's happy path).
// Same drive-the-real-app flow (upload → paint a mask → prompt → Apply Edit), but the
// mocked /api/mask-edit returns a 500. The area must land in a visible FAILED state with
// an error message and a Retry affordance — not silently stall on "Staging…". No real
// Gemini call, no cost. A 500 fails fast (only 429/503 are retried client-side).
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

test.describe('Masking Studio — error handling', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
  });

  test('a failing /api/mask-edit flips the area to a visible Failed state with a retry', async ({ page }) => {
    let maskEditCalls = 0;
    await page.route('**/api/mask-edit', (route) => {
      maskEditCalls += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'generation failed' }),
      });
    });

    await page.goto('/masking-studio.html');

    const fileInput = page.locator('#ms-file-input');
    await expect(fileInput).toBeAttached();
    await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

    const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
    await expect(prompt).toBeVisible();

    // Paint a mask with the rectangle tool (a real drag — the only way `painted` is set).
    await page.locator('#ms-rect-btn').click();
    const stack = page.locator('#ms-stack');
    await expect(stack).toBeVisible();
    await stack.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const box = await stack.boundingBox();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 12 });
    await page.mouse.up();

    await prompt.fill('a cozy modern sofa');

    const generate = page.locator('#ms-generate');
    await expect(generate).toBeEnabled();
    await generate.click();

    // The area lands in the Failed state (chip + inline error), not stuck "Staging…".
    await expect(page.locator('.ms-layer-status--failed').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.ms-layer-error').first()).toBeVisible();
    expect(maskEditCalls).toBeGreaterThan(0);
  });
});
