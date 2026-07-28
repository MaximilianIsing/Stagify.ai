// Main Stagify tool — what the mask editor looks like while the model runs.
//
// Covers two things that were inconsistent with the AI Designer's editor until
// the two were consolidated:
//
//   1. The cursor. The AI Designer showed `not-allowed` over the canvas during a
//      run; the stage editor left a crosshair on a canvas you could not paint on.
//   2. The busy state. The stage editor tracked it with TWO classes — `processing`
//      set by the phase machine and `smask-busy` set by the overlay — each with
//      its own blur rule at a different radius. Both matched during a run, so the
//      2px rule in the stylesheet was never what you actually saw; the injected
//      6px one won on source order. There is one class and one rule now, and the
//      value kept is the one that was really in effect.
//
// /api/mask-edit is held open so the loading phase is observable, then released.
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
    name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();
  await page.locator('#mask-edit-btn').click();
  await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
}

/** Paint a stroke and fill the prompt so Apply is enabled. */
async function readyToSubmit(page) {
  const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.locator('#stage-mask-prompt').fill('repaint the wall white');
  await expect(page.locator('#stage-mask-submit')).toBeEnabled();
}

/** Route /api/mask-edit so it hangs until the returned release() is called. */
async function holdGenerate(page) {
  let release;
  const held = new Promise((r) => { release = r; });
  const png = await roomPngBuffer(640, 420);
  await page.route('**/api/mask-edit', async (route) => {
    await held;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ editedImage: 'data:image/png;base64,' + png.toString('base64') }),
    });
  });
  return () => release();
}

test.describe('Main tool — mask editor loading state', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('marks the canvas busy, blurs it, and blocks painting', async ({ page }) => {
    await openMaskEditor(page);
    await readyToSubmit(page);
    const release = await holdGenerate(page);
    await page.locator('#stage-mask-submit').click();

    const container = page.locator('.stage-mask-canvas-container');
    await expect(container).toHaveClass(/processing/);
    await expect(page.locator('.stage-mask-canvas-container .smask-overlay')).toBeVisible();

    const state = await page.evaluate(() => {
      const draw = document.getElementById('stage-mask-draw-canvas');
      return {
        cursor: draw.style.cursor,
        pointerEvents: draw.style.pointerEvents,
        blur: getComputedStyle(draw).filter,
      };
    });

    // The canvas cannot be painted on, and now says so.
    expect(state.pointerEvents).toBe('none');
    expect(state.cursor).toBe('not-allowed');
    // One blur, and it is the 6px one that was always really in effect.
    expect(state.blur).toContain('blur(6px)');

    release();
    await expect(page.locator('#stage-mask-done')).toBeVisible();
  });

  test('only one busy class is used, not the old pair', async ({ page }) => {
    await openMaskEditor(page);
    await readyToSubmit(page);
    const release = await holdGenerate(page);
    await page.locator('#stage-mask-submit').click();
    await expect(page.locator('.stage-mask-canvas-container')).toHaveClass(/processing/);

    const classes = await page.locator('.stage-mask-canvas-container').getAttribute('class');
    expect(classes).not.toContain('smask-busy');

    release();
    await expect(page.locator('#stage-mask-done')).toBeVisible();
  });

  test('clears the busy state and restores the crosshair when the run ends', async ({ page }) => {
    await openMaskEditor(page);
    await readyToSubmit(page);
    const release = await holdGenerate(page);
    await page.locator('#stage-mask-submit').click();
    await expect(page.locator('.stage-mask-canvas-container')).toHaveClass(/processing/);

    release();
    await expect(page.locator('#stage-mask-done')).toBeVisible();

    await expect(page.locator('.stage-mask-canvas-container')).not.toHaveClass(/processing/);
    await expect(page.locator('.stage-mask-canvas-container .smask-overlay')).toBeHidden();
    const after = await page.evaluate(() => {
      const draw = document.getElementById('stage-mask-draw-canvas');
      return { cursor: draw.style.cursor, pointerEvents: draw.style.pointerEvents, blur: getComputedStyle(draw).filter };
    });
    expect(after.cursor).toBe('crosshair');
    expect(after.pointerEvents).toBe('auto');
    expect(after.blur === 'none' || !after.blur.includes('blur(6px)')).toBe(true);
  });

  test('the refine-phase copy is filled in, not left blank', async ({ page }) => {
    await openMaskEditor(page);
    await readyToSubmit(page);
    const release = await holdGenerate(page);
    await page.locator('#stage-mask-submit').click();
    release();
    await expect(page.locator('#stage-mask-done')).toBeVisible();

    // Scope to the modal: index.html has a second `.stage-mask-title` (and
    // `.stage-mask-content`) belonging to the "Empty room" dialog, so an
    // unscoped selector is ambiguous. The editor itself scopes the same way.
    const modal = page.locator('#stage-mask-modal');
    await expect(page.locator('#stage-mask-done')).toHaveText(/\S/);
    await expect(page.locator('#stage-mask-rerun')).toHaveText(/\S/);
    await expect(modal.locator('.stage-mask-title')).toHaveText(/\S/);
    await expect(modal.locator('.stage-mask-note')).toHaveText(/\S/);
    // The help tooltip carries the long shared paragraph.
    const tip = await modal.locator('.smask-help__tip').textContent();
    expect(tip.length).toBeGreaterThan(200);
  });
});
