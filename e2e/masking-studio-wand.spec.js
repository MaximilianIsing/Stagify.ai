// Masking Studio — magic wand (segmentation) coverage. Drives the real wand flow in
// Chromium with /api/segment intercepted: selecting the wand prefetches the room's
// object masks (busy strip while Gemini "works"), a click paints the hit object into
// the active layer exactly like a brush stroke (undo snapshot, generate unlocks), a
// click that hits nothing shows the miss toast, and a failing analysis shows an error
// toast without corrupting the layer. Mocked items use box-only selections (mask: null)
// — the shape the server sends when it nulls out unusable pixel masks — so the mock
// needs no probability-map PNG and the box→rounded-rect decode path is what's tested.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

// Upload a room and wait for the draw phase (active layer's prompt visible) — same
// entry ritual as the happy-path spec.
async function uploadRoom(page) {
  await page.goto('/masking-studio.html');
  const fileInput = page.locator('#ms-file-input');
  await expect(fileInput).toBeAttached();
  await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });
  await expect(page.locator('.ms-layer.is-active textarea.ms-layer-prompt')).toBeVisible();
}

// Centre the canvas stack (it can sit under the sticky header; page.mouse uses
// absolute coords with no auto-scroll) and click at a fraction of its box.
async function clickStackAt(page, fx, fy) {
  const stack = page.locator('#ms-stack');
  await stack.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await stack.boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.describe('Masking Studio — magic wand', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
  });

  test('selecting the wand prefetches /api/segment with a busy strip; a click paints the hit object from the cache', async ({ page }) => {
    let segmentCalls = 0;
    let releaseSeg;
    const segGate = new Promise((resolve) => { releaseSeg = resolve; });
    await page.route('**/api/segment', async (route) => {
      segmentCalls += 1;
      await segGate; // hold the response so the busy strip is observable
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // One box-only object covering the middle half of the photo (box_2d is
        // [y0, x0, y1, x1] normalized to 0-1000).
        body: JSON.stringify({ success: true, items: [{ box_2d: [250, 250, 750, 750], label: 'sofa' }] }),
      });
    });

    await uploadRoom(page);

    // Picking the wand starts the analysis immediately (prefetch) and shows the
    // busy strip until the segmentation lands.
    await page.locator('#ms-wand-btn').click();
    await expect(page.locator('#ms-wand-busy')).toBeVisible();
    await expect(page.locator('#ms-stack')).toHaveClass(/is-analyzing/);
    expect(segmentCalls).toBe(1);

    releaseSeg();
    await expect(page.locator('#ms-wand-busy')).toBeHidden();
    await expect(page.locator('#ms-stack')).not.toHaveClass(/is-analyzing/);

    // Nothing painted yet, so there is no undo snapshot to return to.
    const undoBtn = page.locator('#ms-undo-btn');
    await expect(undoBtn).toBeDisabled();

    // Click the centre of the photo — inside the mocked box — and the selection is
    // painted into the active layer like a brush stroke: an undo snapshot appears
    // and, once prompted, the layer is generate-ready.
    await clickStackAt(page, 0.5, 0.5);
    await expect(undoBtn).toBeEnabled();
    await page.locator('.ms-layer.is-active textarea.ms-layer-prompt').fill('replace the sofa');
    await expect(page.locator('#ms-generate')).toBeEnabled();

    // The click resolved from the prefetched cache — no second fetch.
    expect(segmentCalls).toBe(1);
  });

  test('a wand click that hits no object shows the miss toast and paints nothing', async ({ page }) => {
    await page.route('**/api/segment', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Only object: a small box in the top-left fifth of the photo.
        body: JSON.stringify({ success: true, items: [{ box_2d: [0, 0, 180, 180], label: 'lamp' }] }),
      }),
    );

    await uploadRoom(page);
    await page.locator('#ms-wand-btn').click();
    await expect(page.locator('#ms-wand-busy')).toBeHidden();

    // Click well outside the lamp's box (centre-right of the canvas).
    await clickStackAt(page, 0.7, 0.5);

    const toast = page.locator('#toast-host .toast--error');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/no object/i);
    // Nothing was painted: no undo snapshot, and a prompt alone must not unlock generate.
    await expect(page.locator('#ms-undo-btn')).toBeDisabled();
    await page.locator('.ms-layer.is-active textarea.ms-layer-prompt').fill('replace the lamp');
    await expect(page.locator('#ms-generate')).toBeDisabled();
  });

  test('a failing /api/segment surfaces an error toast on click and is not cached as a result', async ({ page }) => {
    let segmentCalls = 0;
    await page.route('**/api/segment', (route) => {
      segmentCalls += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Segmentation failed' }),
      });
    });

    await uploadRoom(page);

    // Prefetch on tool select fails silently by design (errors are swallowed so
    // picking the tool never toasts) — the busy strip still cycles.
    await page.locator('#ms-wand-btn').click();
    await expect(page.locator('#ms-wand-busy')).toBeVisible();
    await expect(page.locator('#ms-wand-busy')).toBeHidden();
    expect(segmentCalls).toBe(1);

    // The click retries (failures are never cached) and this time the error is shown.
    await clickStackAt(page, 0.5, 0.5);
    await expect(page.locator('#toast-host .toast--error')).toBeVisible();
    expect(segmentCalls).toBe(2);

    // The layer is untouched by the failure.
    await expect(page.locator('#ms-undo-btn')).toBeDisabled();
  });
});
