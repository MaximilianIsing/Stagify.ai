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
import { openStageModalViaUI, roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

const IMG_W = 960;
const IMG_H = 540; // 16:9 — the shape that showed the problem worst

// Pass a { width, height } to pin a window size; pass nothing to keep whatever the
// project's device descriptor gave us (that is how the phone case below stays a
// phone — setViewportSize would silently undo the mobile viewport).
async function openMaskEditor(page, size) {
  if (size) await page.setViewportSize(size);
  await page.route('**/api/validate-image', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, code: null, reason: '' }),
    }),
  );
  await openStageModalViaUI(page);
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
  // Desktop-only for the same reason as its AI-Designer sibling: openMaskEditor()
  // setViewportSize()s to a fixed desktop window (1280x620, 1000x560, 1280x1000)
  // before every assertion, so under the mobile-chrome project these would measure
  // a desktop layout and report it as mobile coverage. Skipped rather than
  // parameterised — the thresholds below (a 300px image floor, "the dialog scrolls
  // a little") are numbers chosen for a wide-and-short window and mean nothing at
  // 393px.
  test.skip(({ isMobile }) => !!isMobile, 'pins desktop window sizes; each case resizes to >=1000px wide.');

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

// The mobile counterpart of the block above. The desktop cases are skipped under
// mobile-chrome because they resize the phone away, which would have left the mask
// editor with NO sizing coverage on a narrow viewport — the one shape where the
// image, the brush row, the prompt and the Apply button compete hardest for space.
// This runs at the device descriptor's own viewport and asserts the same contract
// the desktop cases do (right shape, whole image, primary action reachable), with
// the two extra failure modes a phone adds: sideways scroll, and a canvas squeezed
// to nothing.
test.describe('Main tool — mask editor fits a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'measures the device descriptor viewport; desktop is covered above.');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('the whole image, the prompt and Apply all fit a 393px-wide screen', async ({ page }) => {
    await openMaskEditor(page); // no resize — stay on the phone viewport
    const b = await boxes(page);
    const overflow = await page.evaluate(() => ({
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
    }));

    // Same shape as the source: a phone must letterbox the 16:9 room, not squash it.
    expect(b.canvas.width / b.canvas.height).toBeCloseTo(IMG_W / IMG_H, 1);
    // …and not shrink it to a token strip to make room for the controls.
    expect(b.canvas.height).toBeGreaterThan(120);
    // The bordered box is exactly as tall as the canvas inside it — nothing clipped.
    expect(Math.abs(b.container.height - b.canvas.height)).toBeLessThanOrEqual(2);

    // The image stays inside the screen and nothing pushes the page sideways —
    // the classic phone regression a desktop-width test cannot see.
    expect(b.canvas.width).toBeLessThanOrEqual(overflow.innerW);
    expect(overflow.docScrollW).toBeLessThanOrEqual(overflow.docClientW + 1);

    // The primary action is on screen, not below the fold behind a scroll the
    // dialog gives no hint of.
    expect(b.submitInView).toBe(true);
    expect(b.submit.bottom).toBeLessThanOrEqual(b.viewportH);
  });

  test('a finger stroke paints where it touched, at the phone canvas scale', async ({ page }) => {
    // The desktop file proves the pointer→canvas mapping survives a resize with the
    // mouse. On a phone the same mapping runs through touch events AND a 2.75x
    // device-pixel-ratio canvas, which is where an off-by-DPR bug would hide.
    await openMaskEditor(page);
    const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);

    const hit = await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('stage-mask-draw-canvas'));
      const ctx = c.getContext('2d');
      return {
        centre: ctx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data[3],
        corner: ctx.getImageData(2, 2, 1, 1).data[3],
      };
    });

    expect(hit.centre).toBeGreaterThan(10);
    expect(hit.corner).toBe(0);
  });
});
