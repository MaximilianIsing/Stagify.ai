// AI Designer — the mask editor's reference photo and processing overlay.
//
// This side had no coverage for either: the only AI Designer mask spec was
// mask-fit. Both behaviours moved onto the shared slices in scripts/mask/ when
// the two editors were consolidated, and "the AI Designer still wires its own
// reference photo correctly" was exactly the kind of thing that would have
// broken silently, because its elements are resolved from a dialog this file
// builds at runtime rather than from static markup.
//
// Drag-and-drop was for a while the one asymmetry with the stage editor: this
// editor had never accepted a dragged file. Now that both go through the same
// slice, giving it the feature was one argument (`dropZones`) plus the matching
// `.is-drag-over` rule in ai-designer.css, so the two editors behave the same.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

/**
 * Drop a synthetic file on `selector`. Playwright cannot drive a real OS drag, so
 * the DataTransfer is built in-page and the events dispatched directly — which is
 * the path the listeners under test are attached to.
 */
async function dropFileOn(page, selector) {
  const buffer = await roomPngBuffer(64, 64);
  await page.evaluate(
    async ({ selector: sel, bytes }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'ref.png', { type: 'image/png' }));
      const el = document.querySelector(sel);
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        const ev = new DragEvent(kind, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        el.dispatchEvent(ev);
      }
    },
    { selector, bytes: [...buffer] },
  );
}

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

  test('dropping an image on "+ Add photo" attaches it', async ({ page }) => {
    await openMaskEditor(page);
    await dropFileOn(page, '#mask-editor-ref-add');
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('dropping on the thumbnail replaces the current reference', async ({ page }) => {
    await openMaskEditor(page);
    await dropFileOn(page, '#mask-editor-ref-add');
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);

    await dropFileOn(page, '#mask-editor-ref-preview');
    await expect(page.locator('#mask-editor-ref-preview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#mask-editor-ref-img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('a dragged file highlights the drop target, and the highlight clears on drop', async ({ page }) => {
    await openMaskEditor(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      Object.defineProperty(dt, 'types', { value: ['Files'] });
      const ev = new DragEvent('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      document.querySelector('#mask-editor-ref-add').dispatchEvent(ev);
    });
    await expect(page.locator('#mask-editor-ref-add')).toHaveClass(/is-drag-over/);

    await dropFileOn(page, '#mask-editor-ref-add');
    await expect(page.locator('#mask-editor-ref-add')).not.toHaveClass(/is-drag-over/);
  });

  // The highlight is only useful if it is actually styled — the class existed in
  // index.css for the stage editor but had no counterpart here.
  test('the drag-over highlight is visibly styled, not just a class', async ({ page }) => {
    await openMaskEditor(page);
    const before = await page.locator('#mask-editor-ref-add').evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    await page.locator('#mask-editor-ref-add').evaluate((el) => el.classList.add('is-drag-over'));
    const after = await page.locator('#mask-editor-ref-add').evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );

    expect(after).not.toBe(before);
    expect(after).not.toBe('none');
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
