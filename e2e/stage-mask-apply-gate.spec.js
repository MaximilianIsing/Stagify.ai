// Main Stagify tool (index.html) — the mask editor's "Apply Edit" readiness gate.
//
// Regression: opening the editor showed "Apply Edit" as clickable with nothing
// painted and no prompt. showInEditor() disabled it correctly, but the very next
// call — setPhase('draw') → setControlsDisabled(false) — re-enabled every control
// unconditionally, blowing the gate away. The draw phase now re-applies it.
//
// /api/validate-image is mocked; no generation is ever started, so this costs
// nothing.
import { test, expect } from '@playwright/test';
import { openStageModalViaUI, roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

async function openMaskEditor(page) {
  await page.route('**/api/validate-image', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, code: null, reason: '' }),
    }),
  );

  await openStageModalViaUI(page);

  await page.locator('#stage-file-input').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: await roomPngBuffer(),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();

  await page.locator('#mask-edit-btn').click();
  await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
}

// One stroke across the middle of the draw canvas.
async function paintStroke(page) {
  const canvas = page.locator('#stage-mask-draw-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
}

test.describe('Main tool — mask editor Apply Edit gate', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('starts disabled and needs both a mask and a prompt', async ({ page }) => {
    await openMaskEditor(page);
    const submit = page.locator('#stage-mask-submit');

    // Nothing painted, no prompt — the bug made this enabled.
    await expect(submit).toBeDisabled();

    // A prompt alone is not enough.
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await expect(submit).toBeDisabled();

    // Prompt + strokes → ready.
    await paintStroke(page);
    await expect(submit).toBeEnabled();

    // Clearing the mask takes it back out of the ready state.
    await page.locator('#stage-mask-clear').click();
    await expect(submit).toBeDisabled();
  });

  test('is disabled again on a fresh open after a previous session', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await paintStroke(page);
    await expect(page.locator('#stage-mask-submit')).toBeEnabled();

    await page.locator('#stage-mask-cancel').click();
    await expect(page.locator('#stage-mask-modal')).not.toHaveClass(/active/);

    await page.locator('#mask-edit-btn').click();
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-submit')).toBeDisabled();
  });

  // The header X had no click listener at all — only Cancel, the backdrop and
  // Escape closed the editor. Cover every dismissal path so a dead control is
  // caught here rather than by a user.
  for (const [name, dismiss] of [
    ['the X button', (page) => page.locator('#stage-mask-close').click()],
    ['Cancel', (page) => page.locator('#stage-mask-cancel').click()],
    ['Escape', (page) => page.keyboard.press('Escape')],
  ]) {
    test(`closes on ${name}`, async ({ page }) => {
      await openMaskEditor(page);
      await dismiss(page);
      await expect(page.locator('#stage-mask-modal')).not.toHaveClass(/active/);
    });
  }
});
