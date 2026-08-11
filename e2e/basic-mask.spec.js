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

/** The toolbar row's shape: its height, and whether the badge group is still on its line. */
function rowGeometry(page) {
  return page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const tools = r('.stage-mask-tools');
    const stamp = r('#mask-stamp');
    const opts = r('#mask-stamp-opts');
    return {
      toolrowH: Math.round(r('.stage-mask-toolrow').height),
      sameLineAsTools: stamp.top < tools.bottom,
      // The checkbox and the strip beside it, rather than the strip having dropped under it.
      stripIntact: Math.abs(opts.top - stamp.top) < 14,
    };
  });
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

  // ── "Label as virtually staged" ───────────────────────────────────────────
  // Basic Mask composites in the browser and downloads that canvas, so unlike staging
  // there is no server round trip to hang the disclosure on — the badge costs an explicit
  // POST to /api/stamp-image at download time. Intercepted here: the real endpoint needs
  // sharp and a pro session, and what these prove is the WIRING either side of it.

  /** Upload, paint, apply and commit — leaves the editor on a downloadable result. */
  async function commitOneEdit(page) {
    await uploadRoom(page);
    await page.locator('#stage-mask-prompt').fill('repaint the wall white');
    await paintStroke(page);
    await page.locator('#stage-mask-submit').click();
    await page.locator('#stage-mask-done').click();
    await expect(page.locator('#stage-mask-download')).toBeVisible();
  }

  test('ticking the option moves NOTHING and covers nothing', async ({ page }) => {
    // Two failed layouts are behind this one assertion, and it is the only thing that would
    // have caught either. A floating panel cost the layout nothing but hung over a third of
    // the photo. Stacking the strip UNDER the checkbox fixed that and grew
    // .stage-mask-toolrow instead, shoving the brush slider, the prompt, the reference row
    // and the buttons down — for nothing, since the row's problem was never horizontal.
    // The strip now sits BESIDE the checkbox, inside the height the tool buttons already
    // set, so every row below holds its exact position.
    await openBasicMask(page);
    await uploadRoom(page);

    const rows = () => page.evaluate(() => {
      const y = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top);
      const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
      return {
        toolrowH: h('.stage-mask-toolrow'),
        controlsH: h('.stage-mask-controls'),
        canvasH: h('#stage-mask-base-canvas'),
        brushY: y('.stage-mask-brush-controls'),
        promptY: y('#stage-mask-prompt'),
        refY: y('.stage-mask-ref-container'),
        actionsY: y('.stage-mask-actions'),
      };
    });

    const strip = page.locator('#mask-stamp-opts');
    await expect(strip).toBeHidden();
    const before = await rows();

    await page.locator('#mask-label-virtually-staged').check();
    await expect(strip).toBeVisible();
    expect(await rows()).toEqual(before);

    // In flow, beside the checkbox — so it cannot be over the photo either.
    const stripBox = await strip.boundingBox();
    const canvasBox = await page.locator('#stage-mask-base-canvas').boundingBox();
    expect(stripBox.y).toBeGreaterThanOrEqual(
      canvasBox.y + canvasBox.height,
      'the strip starts below the photo, it does not overlap it',
    );
  });

  test('the longest label still holds one line, so nothing moves in any language', async ({ page }) => {
    // English fits with room to spare; Russian's label is ~120px longer, and the row is
    // flex-wrap:wrap — which does NOT shrink an oversized item, it moves it to the next
    // line. That put the push-down straight back for six of the eleven packs while looking
    // perfect in the one this suite reads by default.
    await openBasicMask(page);
    await uploadRoom(page);
    await page.locator('#mask-label-virtually-staged').check();

    const label = page.locator('label[for="mask-label-virtually-staged"]');
    const baseline = await rowGeometry(page);

    for (const lang of ['russian', 'italian', 'german', 'portuguese', 'japanese']) {
      const text = await page.evaluate(async (l) => {
        const pack = await (await fetch(`/languages/${l}.json`)).json();
        return pack.modal.staging.labelVirtuallyStaged;
      }, lang);
      await label.evaluate((el, t) => { el.textContent = t; }, text);

      const geo = await rowGeometry(page);
      expect(geo.toolrowH, `${lang}: the toolbar row grew`).toBe(baseline.toolrowH);
      expect(geo.sameLineAsTools, `${lang}: the group wrapped below the tool buttons`).toBe(true);
      expect(geo.stripIntact, `${lang}: the strip broke away from the checkbox`).toBe(true);
    }
  });

  test('the panel is not offered when the editor is refining a staged photo', async ({ page }) => {
    // It applies to THIS dialog's download, and the staging modes have none — they commit
    // into the before/after carousel, which is stamped on its own server round trip.
    await openBasicMask(page);
    await expect(page.locator('#mask-stamp')).toBeHidden();
    await uploadRoom(page);
    await expect(page.locator('#mask-stamp')).toBeVisible();
  });

  test('with the option ticked, the download is the stamped image', async ({ page }) => {
    const posted = [];
    await page.route('**/api/stamp-image', async (route) => {
      posted.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, image: TINY_PNG_DATA_URL }),
      });
    });

    await openBasicMask(page);
    await commitOneEdit(page);
    await page.locator('#mask-label-virtually-staged').check();
    // The swatch LABEL, not the input: the radio is deliberately clipped rather than
    // display:none (so it stays focusable), and the label is what a user clicks.
    await page.locator('#mask-stamp-opts .stamp-swatch', { has: page.locator('input[value="banner"]') }).click();
    await expect(page.locator('#mask-stamp-opts input[value="banner"]')).toBeChecked();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#stage-mask-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^stagify-basic-mask-\d+\.png$/);

    expect(posted).toHaveLength(1);
    expect(posted[0].style).toBe('banner', 'the style the user picked, not the default');
    expect(posted[0].image).toMatch(/^data:image\//);
    expect(posted[0].lang).toBeTruthy();
  });

  test('a failed stamp downloads NOTHING', async ({ page }) => {
    // The pairing for the test above, and the one that matters: falling back to the
    // unstamped composite would write an undisclosed photo to disk under a name the user
    // believes carries a disclosure. Nothing on screen would say so.
    await page.route('**/api/stamp-image', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'We couldn\'t add the label.', code: 'DISCLOSURE_STAMP_FAILED' }),
      }),
    );

    await openBasicMask(page);
    await commitOneEdit(page);
    await page.locator('#mask-label-virtually-staged').check();

    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.locator('#stage-mask-download').click();

    // The error surfaces, and the button comes back so they can untick and retry. Asserted
    // on the TEXT in one shot: the toast removes itself after 4.2s plus a fade, so a
    // toBeVisible() followed by a second query against it is a race.
    await expect(page.locator('#toast-host .toast').first()).toContainText(/label/i);
    await expect(page.locator('#stage-mask-download')).toBeEnabled();
    expect(downloaded).toBe(false);
  });

  test('with the option OFF the download never touches the network', async ({ page }) => {
    let called = 0;
    await page.route('**/api/stamp-image', (route) => { called += 1; return route.abort(); });

    await openBasicMask(page);
    await commitOneEdit(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#stage-mask-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^stagify-basic-mask-\d+\.png$/);
    expect(called).toBe(0);
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
