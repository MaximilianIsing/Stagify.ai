// AI Designer — mask editor sizing on a SHORT viewport.
//
// Regression for the bug where the dialog over-committed its height budget (the
// image took a flat 70vh, the controls needed ~300px more, and the 90vh cap made
// flex squash the `overflow: hidden` canvas box): the photo was clipped at the
// bottom with nothing to scroll. mask-fit.js now measures the chrome and gives
// the image whatever height is actually left.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

const IMG_W = 960;
const IMG_H = 540; // 16:9 — a wide room, the shape that showed the clipping worst

async function openMaskEditor(page, { width, height }) {
  const png = await roomPngBuffer(IMG_W, IMG_H);
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');

  await page.setViewportSize({ width, height });
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

// Every box the assertions need, in one round trip.
function boxes(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const { width, height, top, bottom } = el.getBoundingClientRect();
      return { width, height, top, bottom };
    };
    const content = document.querySelector('.mask-editor-content');
    return {
      canvas: rect('#mask-editor-canvas'),
      overlay: rect('#mask-editor-mask-canvas'),
      container: rect('.mask-editor-canvas-container'),
      content: rect('.mask-editor-content'),
      contentScrollH: content ? content.scrollHeight : 0,
      contentClientH: content ? content.clientHeight : 0,
      viewportH: window.innerHeight,
    };
  });
}

test.describe('AI Designer — mask editor fits short viewports', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('keeps the aspect ratio and shows the whole image at 1280x620', async ({ page }) => {
    await openMaskEditor(page, { width: 1280, height: 620 });
    const b = await boxes(page);

    // Not squished: rendered ratio matches the source within 1%.
    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);

    // Not clipped: the bordered box is exactly as tall as the canvas it holds
    // (2px border each side), i.e. flex never shaved height off it.
    expect(b.container.height - b.canvas.height).toBeLessThanOrEqual(5);

    // The mask overlay still registers with the photo underneath it.
    expect(Math.abs(b.overlay.width - b.canvas.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.overlay.height - b.canvas.height)).toBeLessThanOrEqual(1);

    // And the whole dialog lives inside its 90vh budget, so nothing scrolls away.
    expect(b.content.height).toBeLessThanOrEqual(b.viewportH * 0.9 + 1);
    expect(b.content.bottom).toBeLessThanOrEqual(b.viewportH);
    // The height budget adds up: the dialog does not overflow its own cap. (The
    // `overflow-y: auto` net is there for absurdly short windows only — if it
    // engages here, the image was handed height the controls needed.)
    expect(b.contentScrollH).toBeLessThanOrEqual(b.contentClientH + 1);

    // Fitting must not mean shrinking the photo to a sliver — it is the part you
    // need to see to paint a mask (the compact-controls media query pays for it).
    expect(b.canvas.height).toBeGreaterThanOrEqual(b.viewportH * 0.25);
  });

  // The refine phase adds a note row above the buttons, so the dialog needs to
  // re-measure — otherwise the height it hands the image is one row out of date.
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

    // Paint a stroke so "Apply Edit" is enabled, then run the mocked edit.
    const box = await page.locator('#mask-editor-mask-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    await page.locator('#mask-editor-prompt').fill('put a green armchair here');
    await page.locator('#mask-editor-submit').click();

    await expect(page.locator('#mask-editor-done')).toBeVisible();

    const b = await boxes(page);
    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    expect(b.container.height - b.canvas.height).toBeLessThanOrEqual(5);
    expect(b.content.bottom).toBeLessThanOrEqual(b.viewportH);
    expect(b.contentScrollH).toBeLessThanOrEqual(b.contentClientH + 1);
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
    expect(tall.content.bottom).toBeLessThanOrEqual(tall.viewportH);
  });
});
