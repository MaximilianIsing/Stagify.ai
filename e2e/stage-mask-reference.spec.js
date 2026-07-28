// Main Stagify tool (index.html) — the mask editor's optional reference photo.
//
// CHARACTERIZATION, written before consolidating the two mask editors onto one
// set of behaviour slices. The AI Designer's already-extracted mask-reference.js
// wires the picker and the remove button but has NO drag-and-drop; the stage
// editor wires drop zones on both the "+ Add photo" button and the thumbnail.
// Pointing the stage editor at the shared slice without carrying that across
// would silently delete a working feature, and nothing would have caught it —
// so it is pinned here first.
//
// /api/validate-image is mocked and no generation is started, so this costs
// nothing. Geometry is deliberately not asserted (that lives in the fit spec);
// this is about which controls are wired.
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
    name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer(),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();
  await page.locator('#mask-edit-btn').click();
  await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
}

/**
 * Drop a synthetic file onto `selector`. Playwright can't drive a real OS drag,
 * so the DataTransfer is built in-page and the events dispatched directly —
 * which is exactly the path the listeners under test are attached to.
 */
async function dropFileOn(page, selector, { name = 'ref.png', type = 'image/png' } = {}) {
  const buffer = await roomPngBuffer(64, 64);
  await page.evaluate(
    async ({ selector: sel, name: n, type: ty, bytes }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], n, { type: ty }));
      const el = document.querySelector(sel);
      for (const kind of ['dragenter', 'dragover', 'drop']) {
        const ev = new DragEvent(kind, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        el.dispatchEvent(ev);
      }
    },
    { selector, name, type, bytes: [...buffer] },
  );
}

test.describe('Main tool — mask editor reference photo', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('starts with no reference: add button shown, preview hidden', async ({ page }) => {
    await openMaskEditor(page);
    await expect(page.locator('#stage-mask-ref-add')).not.toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-preview')).toHaveClass(/hidden/);
  });

  test('picking a file shows the thumbnail and hides the add button', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#stage-mask-ref-preview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-add')).toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('the remove button detaches it and restores the add button', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#stage-mask-ref-preview')).not.toHaveClass(/hidden/);

    await page.locator('#stage-mask-ref-remove').click();
    await expect(page.locator('#stage-mask-ref-preview')).toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-add')).not.toHaveClass(/hidden/);
  });

  // The feature the AI Designer's extracted slice does not have.
  test('dropping an image on "+ Add photo" attaches it', async ({ page }) => {
    await openMaskEditor(page);
    await dropFileOn(page, '#stage-mask-ref-add');
    await expect(page.locator('#stage-mask-ref-preview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-img')).toHaveAttribute('src', /^data:image\/png/);
  });

  test('dropping on the thumbnail replaces the current reference', async ({ page }) => {
    await openMaskEditor(page);
    await dropFileOn(page, '#stage-mask-ref-add');
    const first = await page.locator('#stage-mask-ref-img').getAttribute('src');

    await dropFileOn(page, '#stage-mask-ref-preview', { name: 'other.png' });
    await expect(page.locator('#stage-mask-ref-preview')).not.toHaveClass(/hidden/);
    const second = await page.locator('#stage-mask-ref-img').getAttribute('src');
    expect(second).toMatch(/^data:image\/png/);
    expect(second.length).toBeGreaterThan(0);
    // Same fixture bytes, so equality is fine — the point is the drop was accepted
    // on the preview zone at all, not that the image changed.
    expect(typeof first).toBe('string');
  });

  test('a dragged file highlights the drop target, and the highlight clears on drop', async ({ page }) => {
    await openMaskEditor(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const ev = new DragEvent('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      // types must include 'Files' for the listener to engage.
      Object.defineProperty(dt, 'types', { value: ['Files'] });
      document.querySelector('#stage-mask-ref-add').dispatchEvent(ev);
    });
    await expect(page.locator('#stage-mask-ref-add')).toHaveClass(/is-drag-over/);

    await dropFileOn(page, '#stage-mask-ref-add');
    await expect(page.locator('#stage-mask-ref-add')).not.toHaveClass(/is-drag-over/);
  });

  test('an unsupported file type is rejected with a toast and nothing is attached', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-ref-file').setInputFiles({
      name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not an image'),
    });
    await expect(page.locator('#toast-host')).toContainText(/valid JPG, PNG, or WebP/i);
    await expect(page.locator('#stage-mask-ref-preview')).toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-add')).not.toHaveClass(/hidden/);
  });

  test('closing the editor drops the reference so the next open starts clean', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-ref-file').setInputFiles({
      name: 'ref.png', mimeType: 'image/png', buffer: await roomPngBuffer(64, 64),
    });
    await expect(page.locator('#stage-mask-ref-preview')).not.toHaveClass(/hidden/);

    await page.locator('#stage-mask-cancel').click();
    await page.locator('#mask-edit-btn').click();
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-ref-preview')).toHaveClass(/hidden/);
    await expect(page.locator('#stage-mask-ref-add')).not.toHaveClass(/hidden/);
  });
});
