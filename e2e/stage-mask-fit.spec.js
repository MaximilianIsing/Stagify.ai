// Main Stagify tool — mask editor sizing on a SHORT viewport.
//
// The AI Designer's editor was fixed for this long ago (see
// ai-designer-mask-fit.spec.js): its old sizing handed the image a flat fraction
// of the viewport height and let flex sort out the rest, which over-commits
// because the header + tool row + slider + prompt + reference block + buttons
// need ~300px more than the budget left them.
//
// The stage editor kept that flat-fraction sizing. It is NOT clipped here — its
// `.stage-mask-content` scrolls — but on a short window the prompt field and the
// Apply/Cancel buttons end up below the fold, which is its own kind of broken:
// the dialog looks finished and the primary action is off-screen.
//
// These assertions describe the fixed behaviour. /api/validate-image is mocked
// and nothing is generated except in the refine test, so this costs nothing.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

const IMG_W = 960;
const IMG_H = 540; // 16:9 — the shape that showed the problem worst

async function openMaskEditor(page, { width, height }) {
  await page.setViewportSize({ width, height });
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
    name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer(IMG_W, IMG_H),
  });
  await expect(page.locator('#stage-preview')).toBeVisible();
  await page.locator('#mask-edit-btn').click();
  await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
}

function boxes(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const { width, height, top, bottom } = el.getBoundingClientRect();
      return { width, height, top, bottom };
    };
    const content = document.querySelector('.stage-mask-content');
    const submit = document.querySelector('#stage-mask-submit');
    return {
      canvas: rect('#stage-mask-base-canvas'),
      overlay: rect('#stage-mask-draw-canvas'),
      container: rect('.stage-mask-canvas-container'),
      content: rect('.stage-mask-content'),
      submit: rect('#stage-mask-submit'),
      submitInView: submit
        ? submit.getBoundingClientRect().bottom <= window.innerHeight + 1
        : null,
      contentScrollH: content ? content.scrollHeight : 0,
      contentClientH: content ? content.clientHeight : 0,
      viewportH: window.innerHeight,
    };
  });
}

test.describe('Main tool — mask editor fits short viewports', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('shows the whole image AND the controls at 1280x620', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 620 });
    const b = await boxes(page);

    // Not squished: rendered ratio matches the source within 1%.
    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);

    // Not clipped: the box is exactly as tall as the canvas it holds.
    expect(b.container.height - b.canvas.height).toBeLessThanOrEqual(5);

    // The mask overlay still registers with the photo underneath it.
    expect(Math.abs(b.overlay.width - b.canvas.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.overlay.height - b.canvas.height)).toBeLessThanOrEqual(1);

    // The whole dialog fits its budget — this is the regression being fixed.
    // Before the fix the content needed 820px in a 589px box.
    expect(b.contentScrollH).toBeLessThanOrEqual(b.contentClientH + 1);
    expect(b.content.bottom).toBeLessThanOrEqual(b.viewportH + 1);

    // And the primary action is reachable without scrolling.
    expect(b.submitInView).toBe(true);

    // Fitting must not shrink the photo to a sliver — it is the thing you need
    // to see in order to paint a mask.
    expect(b.canvas.height).toBeGreaterThanOrEqual(b.viewportH * 0.25);
  });

  // Below a certain height the chrome simply cannot be squeezed further, and the
  // design chooses deliberately: the image keeps a floor share of the budget and
  // the dialog scrolls, because a mask you cannot see is worse than a dialog you
  // have to scroll. So this case does NOT assert "no scrolling" — that would be
  // demanding a guarantee the sizing intentionally declines to make. It asserts
  // the things that must still hold, plus that the shortfall stays small: the fix
  // took it from 255px of overflow to under 40.
  test('at 1000x560 the image holds its floor and the dialog scrolls a little', async ({ page }) => {
    await openMaskEditor(page, { width: 1000, height: 560 });
    const b = await boxes(page);

    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    expect(b.container.height - b.canvas.height).toBeLessThanOrEqual(5);
    expect(Math.abs(b.overlay.height - b.canvas.height)).toBeLessThanOrEqual(1);

    // The image is not sacrificed to fit the controls in.
    const budget = Math.min(b.viewportH, b.viewportH - 32);
    expect(b.canvas.height).toBeGreaterThanOrEqual(budget * 0.28);

    // Scrolling is a nudge, not a wall.
    expect(b.contentScrollH - b.contentClientH).toBeLessThanOrEqual(40);
  });

  test('a tall window still gives the image generous room', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 1000 });
    const b = await boxes(page);

    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    expect(b.contentScrollH).toBeLessThanOrEqual(b.contentClientH + 1);
    // Never upscaled past its natural size.
    expect(b.canvas.width).toBeLessThanOrEqual(IMG_W + 1);
  });

  test('re-fits when the window is resized', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 620 });
    const short = await boxes(page);

    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect
      .poll(async () => (await boxes(page)).canvas.height)
      .toBeGreaterThan(short.canvas.height + 20);

    const tall = await boxes(page);
    expect(tall.canvas.width / tall.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    expect(tall.content.bottom).toBeLessThanOrEqual(tall.viewportH + 1);
  });

  // The refine phase swaps the buttons and adds a note row, so the dialog has to
  // re-measure or the height it handed the image is one row out of date.
  test('still fits after entering the refine phase', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 620 });

    const png = await roomPngBuffer(IMG_W, IMG_H);
    await page.route('**/api/mask-edit', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ editedImage: 'data:image/png;base64,' + png.toString('base64') }),
      }),
    );

    const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await page.locator('#stage-mask-prompt').fill('put a green armchair here');
    await page.locator('#stage-mask-submit').click();

    await expect(page.locator('#stage-mask-done')).toBeVisible();

    const b = await boxes(page);
    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    expect(b.container.height - b.canvas.height).toBeLessThanOrEqual(5);
    expect(b.contentScrollH).toBeLessThanOrEqual(b.contentClientH + 1);
  });

  // Resizing the canvas changes the CSS box the pointer maps through. The brush
  // reads getBoundingClientRect live, so this should hold — but it is exactly the
  // thing a sizing change could quietly break.
  test('the brush still lands where the pointer is after fitting', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 620 });
    const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.up();

    const hit = await page.evaluate(() => {
      const c = document.getElementById('stage-mask-draw-canvas');
      const ctx = c.getContext('2d');
      const centre = ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data[3];
      const corner = ctx.getImageData(2, 2, 1, 1).data[3];
      return { centre, corner };
    });

    expect(hit.centre).toBeGreaterThan(10);
    expect(hit.corner).toBe(0);
  });
});
