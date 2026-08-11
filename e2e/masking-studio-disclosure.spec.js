// Masking Studio — "Label as virtually staged".
//
// This studio has TWO exits, and the disclosure has to survive both or it is worse than not
// offering it. "Looks Good" writes a gallery entry, which is the copy that outlives the
// session — re-downloaded months later, served by a share link. "Download Result" writes a
// file to disk. They reach the badge differently on purpose: the save request is already
// carrying the composite, so the server stamps it there; the download's pixels exist only in
// the browser, so those make a round trip to /api/stamp-image.
//
// The assertion that matters on both is the negative one: when the badge cannot be applied,
// NOTHING is delivered. An unlabelled file under a request that asked for a label is the
// exact exposure the feature exists to prevent, and nothing on screen would reveal it.
import { test, expect } from '@playwright/test';
import { TINY_PNG_DATA_URL, roomPngBuffer, seedProSession } from './fixtures.js';

/** Upload, paint, prompt and Apply Edit — leaves the studio one press from both exits. */
async function generateOneArea(page) {
  await page.goto('/masking-studio.html');
  const fileInput = page.locator('#ms-file-input');
  await expect(fileInput).toBeAttached();
  await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

  const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
  await expect(prompt).toBeVisible();

  // The rectangle tool: a real drag is the only way the app records a painted mask, and it
  // avoids the wand, which would hit /api/segment.
  await page.locator('#ms-rect-btn').click();
  const stack = page.locator('#ms-stack');
  await stack.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await stack.boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 12 });
  await page.mouse.up();

  await prompt.fill('a cozy modern sofa');
  await page.locator('#ms-generate').click();
  await expect(page.locator('.ms-layer-status--done').first()).toBeVisible({ timeout: 20000 });
}

test.describe('Masking Studio — virtually staged label', () => {
  test.skip(({ isMobile }) => isMobile, 'the studio is desktop-only');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, reason: '' }) }),
    );
    await page.route('**/api/mask-edit', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, editedImage: TINY_PNG_DATA_URL }),
      }),
    );
  });

  test('the option is offered, and its controls follow the checkbox', async ({ page }) => {
    await page.goto('/masking-studio.html');
    await expect(page.locator('#ms-file-input')).toBeAttached();

    // Visible from the start: it has to be set BEFORE "Looks Good", which is the press that
    // writes the gallery entry. Hiding it until the review phase would be too late.
    const checkbox = page.locator('#ms-label-virtually-staged');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#ms-stamp-opts')).toBeHidden();

    await checkbox.check();
    await expect(page.locator('#ms-stamp-opts')).toBeVisible();
    // The preview is the real server render, so "the preview is wrong" can only mean "the
    // output is wrong" — see lib/image/disclosure-preview.js.
    await expect(page.locator('#ms-stamp-opts .stamp-preview__img')).toHaveAttribute(
      'src', /^\/api\/disclosure-preview\?/,
    );

    await checkbox.uncheck();
    await expect(page.locator('#ms-stamp-opts')).toBeHidden();
  });

  test('"Looks Good" hands the badge settings to the server, which stamps the stored copy', async ({ page }) => {
    // Server-side for this exit: the save already carries the composite, so routing it
    // through /api/stamp-image first would upload the same megabyte twice.
    const saves = [];
    await page.route('**/api/masking-studio/save', async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, gallery: null }),
      });
    });
    let stampCalls = 0;
    await page.route('**/api/stamp-image', (route) => { stampCalls += 1; return route.abort(); });

    await generateOneArea(page);
    await page.locator('#ms-label-virtually-staged').check();
    await page.locator('#ms-stamp-opts .stamp-swatch', { has: page.locator('input[value="minimal"]') }).click();
    await page.locator('#ms-view-result').click();

    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].labelVirtuallyStaged).toBe(true);
    expect(saves[0].stampStyle).toBe('minimal');
    expect(saves[0].after).toMatch(/^data:image\//);
    expect(stampCalls).toBe(0, 'the save is stamped server-side, not via a second upload');
  });

  test('Download stamps through /api/stamp-image and saves what came back', async ({ page }) => {
    await page.route('**/api/masking-studio/save', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, gallery: null }) }),
    );
    const posted = [];
    await page.route('**/api/stamp-image', async (route) => {
      posted.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, image: TINY_PNG_DATA_URL }),
      });
    });

    await generateOneArea(page);
    await page.locator('#ms-label-virtually-staged').check();
    await page.locator('#ms-view-result').click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#ms-download').click(),
    ]);
    // .png, not .jpg: the studio composites JPEG but the stamp returns PNG, and the file is
    // named after the bytes it actually got.
    expect(download.suggestedFilename()).toMatch(/^stagify-masking-studio-\d+\.png$/);
    expect(posted).toHaveLength(1);
    expect(posted[0].image).toMatch(/^data:image\/jpeg/, 'the composite goes up as the JPEG it is');
  });

  test('with the option OFF both exits are untouched', async ({ page }) => {
    // The pairing for the two tests above: without it, each could pass on a studio that had
    // simply stopped delivering anything.
    const saves = [];
    await page.route('**/api/masking-studio/save', async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, gallery: null }) });
    });
    let stampCalls = 0;
    await page.route('**/api/stamp-image', (route) => { stampCalls += 1; return route.abort(); });

    await generateOneArea(page);
    await page.locator('#ms-view-result').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#ms-download').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.jpg$/, 'the untouched composite keeps its format');
    expect(stampCalls).toBe(0);
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].labelVirtuallyStaged).toBe(false);
  });

  test('a refused stamp downloads NOTHING and says so', async ({ page }) => {
    await page.route('**/api/masking-studio/save', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, gallery: null }) }),
    );
    await page.route('**/api/stamp-image', (route) =>
      route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'We couldn\'t add the label.', code: 'DISCLOSURE_STAMP_FAILED' }),
      }),
    );

    await generateOneArea(page);
    await page.locator('#ms-label-virtually-staged').check();
    await page.locator('#ms-view-result').click();

    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.locator('#ms-download').click();

    // Asserted on the TEXT in one shot, for the same reason as the test below: the toast is
    // transient, so two sequential queries against it are a race.
    await expect(page.locator('#toast-host .toast').first()).toContainText(/label/i);
    await expect(page.locator('#ms-download')).toBeEnabled('so they can untick and retry');
    expect(downloaded).toBe(false);
  });

  test('a refused stamp on save breaks the studio\'s silence about gallery writes', async ({ page }) => {
    // Every other save failure is swallowed on purpose — it is a background nicety. This one
    // is the exception: the user asked for the label, it is why nothing was stored, and
    // unticking is an action only they can take.
    await page.route('**/api/masking-studio/save', (route) =>
      route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'We couldn\'t add the "virtually staged" label.', code: 'DISCLOSURE_STAMP_FAILED' }),
      }),
    );

    await generateOneArea(page);
    await page.locator('#ms-label-virtually-staged').check();
    await page.locator('#ms-view-result').click();

    // ONE assertion, not toBeVisible() followed by toContainText(): the toast removes
    // itself after 4.2s + a fade, so a second query against the same transient element is a
    // race — and it lost, exactly once, before this was collapsed.
    await expect(page.locator('#toast-host .toast').first()).toContainText('virtually staged');
  });
});
