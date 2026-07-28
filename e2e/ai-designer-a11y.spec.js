// AI Designer — its three dialogs announce themselves as dialogs.
//
// The unit guard (test/frontend/dialog-a11y.test.js) reads the source and fails the
// deploy if the attributes go missing. This spec checks the thing the source cannot
// show: that they are actually ON the live elements (one of which is built at
// runtime), that close buttons resolve a real accessible name once the language pack
// has loaded, and that focus lands inside each dialog and comes back out.
//
// Focus is the half a static check can't reach at all. Without it the dialog opens
// with focus still on the button behind the overlay — a screen reader never announces
// the dialog, and Escape/Tab act on the page underneath.
import { test, expect } from '@playwright/test';
import { roomPngBuffer, seedProSession } from './fixtures.js';

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

test.describe('AI Designer — mask editor accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('the dialog carries its roles and is named by its heading', async ({ page }) => {
    await openMaskEditor(page);

    const modal = page.locator('#mask-editor-modal');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal).toHaveAttribute('aria-labelledby', 'mask-editor-title');

    // The label target must exist and be non-empty, or the dialog's accessible name
    // is blank — indistinguishable, to a screen reader, from having no label at all.
    const title = page.locator('#mask-editor-title');
    await expect(title).toHaveCount(1);
    await expect(title).not.toBeEmpty();
  });

  test('the close button is named, not announced as its "×" glyph', async ({ page }) => {
    await openMaskEditor(page);

    const close = page.locator('#mask-editor-close');
    const label = await close.getAttribute('aria-label');
    expect(label, 'close button has no aria-label').toBeTruthy();
    expect(label).not.toBe('×');
    expect(label, 'the raw key leaked through instead of a translation').not.toBe('common.close');

    // The glyph itself must be hidden, or it is appended to the accessible name.
    await expect(close.locator('[aria-hidden="true"]')).toHaveCount(1);
  });

  test('focus moves into the dialog on open and returns to the opener on close', async ({ page }) => {
    await openMaskEditor(page);

    const focusedInDialog = await page.evaluate(() => {
      const modal = document.getElementById('mask-editor-modal');
      return !!(modal && document.activeElement && modal.contains(document.activeElement));
    });
    expect(focusedInDialog, 'focus stayed outside the dialog').toBe(true);

    await page.locator('#mask-editor-cancel').click();
    await expect(page.locator('#mask-editor-modal.active')).toHaveCount(0);

    // Back on the button that opened it, so keyboard users resume where they were
    // rather than at the top of the document.
    const restored = await page.evaluate(() =>
      !!document.activeElement?.classList.contains('ai-image-mask-btn'),
    );
    expect(restored, 'focus was not returned to the opener').toBe(true);
  });
});

test.describe('AI Designer — bug-report dialog accessibility', () => {
  test.beforeEach(async ({ page }) => {
    // The chat UI (and the bug-report button with it) sits behind the pro gate.
    await seedProSession(page);
    await page.goto('/ai-designer.html');
    await expect(page.locator('#chat-input')).toBeVisible();
  });

  test('announces as a named dialog and takes focus to the first field', async ({ page }) => {
    await page.locator('#bug-report-btn').click();
    const popup = page.locator('#bug-report-popup');
    await expect(popup).toHaveClass(/active/);
    await expect(popup).toHaveAttribute('role', 'dialog');
    await expect(popup).toHaveAttribute('aria-modal', 'true');
    await expect(popup).toHaveAttribute('aria-labelledby', 'bug-report-popup-title');
    await expect(page.locator('#bug-report-popup-title')).not.toBeEmpty();

    // A form dialog opens on its first field, not on Close.
    await expect(page.locator('#bug-report-description')).toBeFocused();

    const label = await page.locator('#bug-report-popup-close').getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toBe('×');
  });

  test('returns focus to the button that opened it', async ({ page }) => {
    await page.locator('#bug-report-btn').click();
    await expect(page.locator('#bug-report-popup')).toHaveClass(/active/);
    await page.locator('#bug-report-cancel').click();
    await expect(page.locator('#bug-report-btn')).toBeFocused();
  });
});

test.describe('AI Designer — image lightbox accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('announces as a named dialog with a reachable close button', async ({ page }) => {
    await openMaskEditor(page); // gets a generated image into the chat
    await page.locator('#mask-editor-cancel').click();
    await page.locator('.message.assistant .ai-generated-image').last().click();

    const modal = page.locator('#image-modal');
    await expect(modal).toHaveClass(/active/);
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    const name = await modal.getAttribute('aria-label');
    expect(name, 'the lightbox has no accessible name').toBeTruthy();

    // It was a <span> before: unreachable by keyboard, so Escape and click-outside
    // were the only ways out.
    const close = page.locator('#image-modal-close');
    await expect(close).toBeFocused();
    expect(await close.evaluate((el) => el.tagName)).toBe('BUTTON');
    expect(await close.getAttribute('aria-label')).toBeTruthy();

    // And it can be operated from the keyboard alone.
    await page.keyboard.press('Enter');
    await expect(modal).not.toHaveClass(/active/);
  });
});
