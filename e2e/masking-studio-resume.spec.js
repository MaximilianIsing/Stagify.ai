// Masking Studio — session resume across a reload. Exercises the IndexedDB
// persistence path end-to-end in a real Chromium: upload a photo, paint a mask
// and type a prompt (which the studio debounce-saves to IndexedDB), reload the
// tab, then accept the "Resume your last session?" dialog and assert the photo,
// the layer, its prompt, and the painted mask all come back.
//
// This is the browser-side proof for the pure shape helpers in
// public/scripts/masking-studio/session.js: serializeLayer/serializeSession run
// on save, deserializeLayer/isRestorableSession run on restore. No AI calls —
// nothing here hits /api/mask-edit; the studio only touches IndexedDB + canvas.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

// Read the raw session record the studio persists, projected to the fields we
// assert on. Mirrors the app's own IDB schema (name + version + store) so that
// if this reader ever opens the DB first, it still creates the store the app
// expects. Any failure (missing store, private mode) resolves to null so the
// poll below simply retries.
function storedSession(page) {
  return page.evaluate(() => new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('stagify-masking-studio', 1); }
    catch { resolve(null); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('session'); } catch { /* exists */ } };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      try {
        const g = req.result.transaction('session', 'readonly').objectStore('session').get('current');
        g.onsuccess = () => resolve(g.result ? {
          hasBase: !!g.result.baseBlob,
          layers: (g.result.layers || []).map((l) => ({
            prompt: l.prompt, name: l.name, mode: l.mode, painted: l.painted, hasMask: !!l.mask,
          })),
        } : null);
        g.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
  }));
}

test.describe('Masking Studio — session resume', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
  });

  test('paint + prompt persists to IndexedDB and restores after a reload', async ({ page }) => {
    await page.goto('/masking-studio.html');

    const fileInput = page.locator('#ms-file-input');
    await expect(fileInput).toBeAttached();
    await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

    // Draw phase reached once the auto-added active layer's prompt box appears.
    const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
    await expect(prompt).toBeVisible();

    // Paint a rectangle mask — a real mouse drag, the only thing that sets `painted`.
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

    // The debounced save (1.5s) writes the base photo + the painted, prompted layer.
    // Poll rides out the intermediate saves (upload → paint → prompt) until it settles.
    await expect
      .poll(() => storedSession(page), { timeout: 15000, message: 'session should persist to IndexedDB' })
      .toEqual({
        hasBase: true,
        layers: [{ prompt: 'a cozy modern sofa', name: '', mode: 'stage', painted: true, hasMask: true }],
      });

    // Reload — IndexedDB survives the same-origin reload, so the studio offers to resume.
    await page.reload();

    const resume = page.locator('#ms-resume');
    await expect(resume).toHaveClass(/active/);
    await page.locator('#ms-resume-yes').click();
    await expect(resume).not.toHaveClass(/active/);

    // Restored via deserializeLayer: the layer + its prompt are rebuilt…
    const restoredPrompt = page.locator('.ms-layer textarea.ms-layer-prompt').first();
    await expect(restoredPrompt).toHaveValue('a cozy modern sofa');
    // …and the mask decoded back onto the canvas — Generate only enables with a base
    // image plus a painted, prompted layer, so this proves the mask restored `painted`.
    await expect(page.locator('#ms-generate')).toBeEnabled();
  });
});
