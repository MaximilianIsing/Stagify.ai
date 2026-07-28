// Main Stagify tool — the mask editor's brush engine.
//
// CHARACTERIZATION, written before extracting the brush into a shared module.
// The two editors carry near-identical copies of this: pointer→canvas mapping,
// brush vs erase, the "painted" flag that gates Submit, and touch support. The
// existing specs only ever paint one plain mouse stroke, so erase, touch and the
// mapping maths were entirely uncovered — exactly the parts where an extraction
// could go wrong without anything noticing.
//
// Assertions read the draw canvas's real alpha channel rather than any internal
// flag, so they describe what the user actually painted.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

async function openMaskEditor(page) {
  await page.route('**/api/validate-image', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, code: null, reason: '' }),
    }),
  );
  await page.goto('/index.html');
  await page.evaluate(() => document.getElementById('stage-modal')?.classList.remove('hidden'));
  await page.locator('#stage-file-input').setInputFiles({
    name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer(480, 320),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();
  await page.locator('#mask-edit-btn').click();
  await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
}

/** Count non-transparent pixels on the draw canvas. */
function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.getElementById('stage-mask-draw-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
    return n;
  });
}

/** Alpha at a point given in FRACTIONS of the canvas's intrinsic size. */
function alphaAt(page, fx, fy) {
  return page.evaluate(({ fx: x, fy: y }) => {
    const c = document.getElementById('stage-mask-draw-canvas');
    const px = Math.round(c.width * x);
    const py = Math.round(c.height * y);
    return c.getContext('2d').getImageData(px, py, 1, 1).data[3];
  }, { fx, fy });
}

async function strokeAcross(page, { fromX = 0.3, toX = 0.7, y = 0.5 } = {}) {
  const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * fromX, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toX, box.y + box.height * y, { steps: 10 });
  await page.mouse.up();
}

test.describe('Main tool — mask editor brush engine', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('a stroke paints where the pointer actually went, in canvas space', async ({ page }) => {
    await openMaskEditor(page);
    await strokeAcross(page, { fromX: 0.3, toX: 0.7, y: 0.5 });

    // On the stroke line.
    expect(await alphaAt(page, 0.5, 0.5)).toBeGreaterThan(10);
    // Well away from it — the mapping must not be offset or scaled wrongly.
    expect(await alphaAt(page, 0.05, 0.1)).toBe(0);
    expect(await alphaAt(page, 0.95, 0.9)).toBe(0);
  });

  test('erase removes from the selection instead of adding to it', async ({ page }) => {
    await openMaskEditor(page);
    await strokeAcross(page);
    const afterBrush = await paintedPixels(page);
    expect(afterBrush).toBeGreaterThan(0);

    await page.locator('#stage-mask-erase-btn').click();
    await expect(page.locator('#stage-mask-erase-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#stage-mask-brush-btn')).toHaveAttribute('aria-pressed', 'false');

    await strokeAcross(page); // same path, now erasing
    expect(await paintedPixels(page)).toBeLessThan(afterBrush);
  });

  test('erasing the whole selection away disables Submit again', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall');
    await strokeAcross(page);
    await expect(page.locator('#stage-mask-submit')).toBeEnabled();

    // A fat eraser over the same line clears it; the flag is recomputed by a
    // full canvas scan on stroke end, not tracked incrementally.
    await page.locator('#stage-mask-erase-btn').click();
    await page.locator('#stage-mask-brush-slider').fill('150');
    await strokeAcross(page, { fromX: 0.1, toX: 0.9, y: 0.5 });
    await strokeAcross(page, { fromX: 0.1, toX: 0.9, y: 0.45 });
    await strokeAcross(page, { fromX: 0.1, toX: 0.9, y: 0.55 });

    expect(await paintedPixels(page)).toBe(0);
    await expect(page.locator('#stage-mask-submit')).toBeDisabled();
  });

  test('brush size changes how much a stroke covers, and the label follows', async ({ page }) => {
    await openMaskEditor(page);
    await page.locator('#stage-mask-brush-slider').fill('20');
    await expect(page.locator('#stage-mask-brush-size')).toHaveText('20 px');
    await strokeAcross(page, { fromX: 0.3, toX: 0.7, y: 0.3 });
    const thin = await paintedPixels(page);

    await page.locator('#stage-mask-clear').click();
    await page.locator('#stage-mask-brush-slider').fill('150');
    await expect(page.locator('#stage-mask-brush-size')).toHaveText('150 px');
    await strokeAcross(page, { fromX: 0.3, toX: 0.7, y: 0.3 });
    const thick = await paintedPixels(page);

    expect(thick).toBeGreaterThan(thin * 2);
  });

  test('a single click lays down a dot rather than nothing', async ({ page }) => {
    await openMaskEditor(page);
    const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();

    expect(await paintedPixels(page)).toBeGreaterThan(0);
    expect(await alphaAt(page, 0.5, 0.5)).toBeGreaterThan(10);
  });

  test('touch draws the same way a mouse does', async ({ page }) => {
    await openMaskEditor(page);
    const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
    await page.evaluate(({ x, y, w, h }) => {
      const c = document.getElementById('stage-mask-draw-canvas');
      const touch = (cx, cy) => ({ clientX: cx, clientY: cy });
      const fire = (type, cx, cy) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: [touch(cx, cy)] });
        c.dispatchEvent(ev);
      };
      fire('touchstart', x + w * 0.3, y + h * 0.5);
      fire('touchmove', x + w * 0.5, y + h * 0.5);
      fire('touchmove', x + w * 0.7, y + h * 0.5);
      fire('touchend', x + w * 0.7, y + h * 0.5);
    }, { x: box.x, y: box.y, w: box.width, h: box.height });

    expect(await paintedPixels(page)).toBeGreaterThan(0);
    expect(await alphaAt(page, 0.5, 0.5)).toBeGreaterThan(10);
  });

  test('Clear Mask wipes the canvas', async ({ page }) => {
    await openMaskEditor(page);
    await strokeAcross(page);
    expect(await paintedPixels(page)).toBeGreaterThan(0);

    await page.locator('#stage-mask-clear').click();
    expect(await paintedPixels(page)).toBe(0);
  });

  test('reopening the editor starts with an empty mask', async ({ page }) => {
    await openMaskEditor(page);
    await strokeAcross(page);
    expect(await paintedPixels(page)).toBeGreaterThan(0);

    await page.locator('#stage-mask-cancel').click();
    await page.locator('#mask-edit-btn').click();
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
    expect(await paintedPixels(page)).toBe(0);
  });
});
