// Basic Mask — the mask editor run standalone, from the top nav.
//
// The staging-nav spec proves the dropdown row opens the dialog. This one proves
// the tool actually works with no staging job behind it, which is the whole point
// of the feature: the editor's other two modes both open ON an image the staging
// flow already has (the uploaded photo, or the rendered result), and everything
// downstream — the version caps, the commit into the before/after carousels —
// assumed one of those existed.
//
// The round trip therefore covers the parts with no other coverage: its own
// uploader, and a commit that has nowhere to commit TO, so the result becomes the
// new base image and is offered as a download instead.
//
// /api/mask-edit is intercepted with a canned decodable PNG — no model call, no cost.

import { test, expect } from '@playwright/test';
import { seedProSession, roomPngBuffer, TINY_PNG_DATA_URL, waitForHomeReady } from './fixtures.js';

const MODAL = '#stage-mask-modal';
// The switcher itself. .language-picker-container is a zero-height positioning
// shell — Playwright reports it hidden even when the picker is on screen.
const LANG_PICKER = '.language-picker-container .lang-switch__trigger';

async function openBasicMask(page) {
  await seedProSession(page);
  await page.route('**/api/mask-edit', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ editedImage: TINY_PNG_DATA_URL }),
    }),
  );
  await page.goto('/index.html');
  await waitForHomeReady(page);
  await page.locator('.staging-menu__trigger').click();
  await page.locator('[data-staging-open="basic-mask"]').click();
  await expect(page.locator(MODAL)).toHaveClass(/active/);
}

async function uploadRoom(page) {
  await page.locator('#stage-mask-upload-input').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: await roomPngBuffer(),
  });
  await expect(page.locator('#stage-mask-upload')).toBeHidden();
  await expect(page.locator('.stage-mask-canvas-container')).toBeVisible();
}

/** One stroke across the middle of the draw canvas. */
async function paintStroke(page) {
  const box = await page.locator('#stage-mask-draw-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
}

test.describe('Basic Mask (standalone)', () => {
  test.skip(({ isMobile }) => isMobile, 'reached from the desktop-only Staging menu');

  test('uploads its own photo and paints on it', async ({ page }) => {
    await openBasicMask(page);

    // The uploader is the whole difference from the other two modes.
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await expect(page.locator('#stage-mask-submit')).toBeDisabled();

    await uploadRoom(page);

    // No /api/validate-image on this path by design — Basic Mask edits any photo,
    // not just a stageable room, and that check spends a paid vision call.
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await expect(page.locator('#stage-mask-submit')).toBeDisabled();
    await paintStroke(page);
    await expect(page.locator('#stage-mask-submit')).toBeEnabled();
  });

  test('the uploader is photo-shaped and the language picker gets out of the way', async ({ page }) => {
    await openBasicMask(page);

    // The floating picker sits at z-index 1100 and hovered over the dialog. It
    // never showed here before Basic Mask, because reaching the mask editor the
    // old way meant #stage-modal was open on top of it.
    //
    // Asserted on the switcher itself, NOT on .language-picker-container: that
    // wrapper is a zero-height positioning shell, so Playwright calls it hidden
    // either way and the check would pass with the rule deleted.
    await expect(page.locator(LANG_PICKER)).toBeHidden();

    // 16:9 — left to fill the dialog the dropzone stretched to a ~3.4:1
    // letterbox that looked nothing like the photo about to land in it.
    const box = await page.locator('#stage-mask-upload').boundingBox();
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1);

    // ...and the DIALOG shrinks to match. Capping only the dropzone left it
    // marooned in the middle of a 920px-wide box sized for the canvas view,
    // with nothing else in the dialog to justify the width.
    const dialog = await page.locator(`${MODAL} .stage-mask-content`).boundingBox();
    expect(box.width / dialog.width).toBeGreaterThan(0.85);
  });

  test('the picker comes back once the editor closes', async ({ page }) => {
    // The rule is scoped to `.stage-mask-modal.active`, so a stale one would
    // leave the site without a language switcher entirely.
    await openBasicMask(page);
    await expect(page.locator(LANG_PICKER)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator(LANG_PICKER)).toBeVisible();
  });

  test('the committed result becomes the new base and offers a download', async ({ page }) => {
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await paintStroke(page);

    // Nothing to download before there is a result.
    await expect(page.locator('#stage-mask-download')).toBeHidden();
    await expect(page.locator('#stage-mask-another')).toBeVisible();

    await page.locator('#stage-mask-submit').click();

    // Refine phase: the standalone buttons step aside for Regenerate / Looks good.
    await expect(page.locator('#stage-mask-done')).toBeVisible();
    await expect(page.locator('#stage-mask-another')).toBeHidden();
    await expect(page.locator('#stage-mask-download')).toBeHidden();

    await page.locator('#stage-mask-done').click();

    // Committed. The editor stays open on the result so the next mask stacks on
    // top of it — there is no carousel for it to go into.
    await expect(page.locator(MODAL)).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-download')).toBeVisible();
    await expect(page.locator('#stage-mask-submit')).toBeVisible();
    await expect(page.locator('#stage-mask-prompt')).toHaveValue('', 'the prompt resets for the next edit');
    await expect(page.locator('#stage-mask-submit')).toBeDisabled('a fresh mask is needed first');

    // And the staging flow was never involved.
    await expect(page.locator('#stage-modal')).toHaveClass(/hidden/);
  });

  test('the download actually produces a file', async ({ page }) => {
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await paintStroke(page);
    await page.locator('#stage-mask-submit').click();
    await page.locator('#stage-mask-done').click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#stage-mask-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^stagify-basic-mask-\d+\.png$/);
  });

  test('"Upload another" returns to the uploader', async ({ page }) => {
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await paintStroke(page);

    await page.locator('#stage-mask-another').click();
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await expect(page.locator('.stage-mask-canvas-container')).toBeHidden();
    await expect(page.locator('#stage-mask-prompt')).toHaveValue('');
  });

  test('closes cleanly straight from the uploader', async ({ page }) => {
    // Open, change your mind, close — the likeliest interaction, and the one path
    // where closeEditor() runs having never had an image (so fit/viewport are
    // unbound without ever being bound).
    await openBasicMask(page);
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL)).not.toHaveClass(/active/);

    // And the staging screen still works afterwards.
    await page.locator('.staging-menu__trigger').click();
    await page.locator('[data-staging-open="stage"]').click();
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
  });

  test('reopening after a close starts clean, not on the last image', async ({ page }) => {
    // closeEditor() is shared with the two staging modes; a standalone session
    // that leaked its image would show the previous visitor's photo.
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#stage-mask-close').click();
    await expect(page.locator(MODAL)).not.toHaveClass(/active/);

    await page.locator('.staging-menu__trigger').click();
    await page.locator('[data-staging-open="basic-mask"]').click();
    await expect(page.locator(MODAL)).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await expect(page.locator('#stage-mask-download')).toBeHidden();
  });

  test('the staging flow still opens on the uploaded photo, not the Basic Mask one', async ({ page }) => {
    // The two modes share one dialog and one pair of canvases. Running Basic Mask
    // first must not leave state that the FAB path then picks up.
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#stage-mask-close').click();
    // Wait for it to actually go: the dialog is a fixed, full-screen overlay, so
    // clicking the nav while it is still up races its teardown for the pointer.
    await expect(page.locator(MODAL)).not.toHaveClass(/active/);

    await page.locator('.staging-menu__trigger').click();
    await page.locator('[data-staging-open="stage"]').click();
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
    // The staging screen is at its own starting point — its dropzone, not an
    // image carried over from the mask editor.
    await expect(page.locator('#stage-dropzone')).toBeVisible();
    await expect(page.locator('#mask-edit-btn')).toBeHidden();
  });
});
