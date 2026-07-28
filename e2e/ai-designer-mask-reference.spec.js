// AI Designer — the mask editor's reference photo and processing overlay.
//
// This side had no coverage for either: the only AI Designer mask spec was
// mask-fit. Both behaviours moved onto the shared slices in scripts/mask/ when
// the two editors were consolidated, and "the AI Designer still wires its own
// reference photo correctly" was exactly the kind of thing that would have
// broken silently, because its elements are resolved from a dialog this file
// builds at runtime rather than from static markup.
//
// Note the deliberate asymmetry with the stage editor: that one accepts a
// dragged file, this one has never had drop zones and still doesn't. The shared
// slice only wires them when asked (see `dropZones`).
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

async function openMaskEditor(page) {
  const png = await roomPngBuffer(640, 420);
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  await page.route('**/api/chat', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ response: 'Here is your staged room.', stagedImage: dataUrl }),
    }),
  );
  await page.goto('/ai-designer.html');
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.locator('#chat-input').fill('stage this room');
  await page.locator('#send-btn').click();
  await page.locator('.message.assistant .ai-image-container .ai-image-mask-btn').last().click();
  await expect(page.locator('#mask-editor-modal.active')).toBeVisible();
}

test.describe('AI Designer — mask editor reference photo', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('starts with no reference attached', async ({ page }) => {
    await openMaskEditor(page);
    await expect(page.locator('#mask-editor-ref-add')).not.toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-preview')).toHaveClass(/hidden/);
  });

  test('picking a file shows the thumbnail and hides the add button', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#mask-editor-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-add')).toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('the remove button detaches it', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#mask-editor-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);

    await page.locator('#mask-editor-ref-remove').click();
    await expect(page.locator('#mask-editor-ref-preview')).toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-add')).not.toHaveClass(/hidden/);
  });

  test('an unsupported file type is rejected and nothing is attached', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#mask-editor-ref-file').setInputFiles({
      name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not an image'),
    });
    await expect(page.locator('#mask-editor-ref-preview')).toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-add')).not.toHaveClass(/hidden/);
  });

  test('reopening the editor starts without the previous reference', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#mask-editor-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);

    await page.locator('#mask-editor-cancel').click();
    await expect(page.locator('#mask-editor-modal')).not.toHaveClass(/active/);

    await page.locator('.message.assistant .ai-image-container .ai-image-mask-btn').last().click();
    await expect(page.locator('#mask-editor-modal.active')).toBeVisible();
    await expect(page.locator('#mask-editor-ref-preview')).toHaveClass(/hidden/);
  });

  test('the processing overlay covers the canvas while the model runs', async ({ page }) => {
    await openMaskEditor(page);
    // Hold /api/mask-edit open so the loading phase is observable.
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/api/mask-edit', async (route) => {
      await held;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ editedImage: 'data:image/png;base64,' + (await roomPngBuffer(640, 420)).toString('base64') }),
      });
    });

    await page.locator('#mask-editor-prompt').fill('repaint the wall white');
    const canvas = page.locator('#mask-editor-mask-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();

    await page.locator('#mask-editor-submit').click();

    // Spinner + rotating message, and the container marked busy.
    await expect(page.locator('.mask-editor-canvas-container .smask-overlay')).toBeVisible();
    await expect(page.locator('.smask-overlay__msg')).toHaveText(/\S/);
    await expect(page.locator('.mask-editor-canvas-container')).toHaveClass(/processing/);

    release();
    // Once the run finishes the overlay goes away and the refine controls appear.
    await expect(page.locator('.mask-editor-canvas-container .smask-overlay')).toBeHidden();
    await expect(page.locator('#mask-editor-done')).toBeVisible();
  });
});
