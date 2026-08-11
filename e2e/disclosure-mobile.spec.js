// "Label as virtually staged" on a phone, on both surfaces that composite in the browser.
//
// WHY A SEPARATE MOBILE SPEC: the desktop layout of this control is a deliberate
// horizontal squeeze — the strip rides beside the checkbox so the Basic Mask toolbar row
// never grows and never costs the photo height. None of that survives a 393px viewport,
// and the two failures it produced were both invisible to every desktop assertion:
//
//   1. The strip was handed ~68px and its contents — four FIXED-SIZE swatches (`flex:none`)
//      plus the preview trigger — simply painted outside it, over the label. Nothing
//      overflowed the page, so no scrollbar appeared to give it away.
//   2. In the Masking Studio the strip's min-content became the sidebar's, and the sidebar
//      is a grid item: the whole toolbar grew ~15px past the viewport, putting the preview
//      button on the screen edge. Again with no page-level horizontal scroll.
//
// Both are geometry that only exists at this width, so they are asserted at this width.
import { test, expect } from '@playwright/test';
import { seedProSession, roomPngBuffer, TINY_PNG_DATA_URL, waitForHomeReady } from './fixtures.js';

test.describe('virtually staged label — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'this spec is the mobile half of the layout');

  test('Basic Mask: the strip fits the dialog and nothing paints outside it', async ({ page }) => {
    await seedProSession(page);
    await page.route('**/api/mask-edit', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ editedImage: TINY_PNG_DATA_URL }) }),
    );
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await page.locator('.staging-menu__trigger').click();
    await page.locator('[data-staging-open="basic-mask"]').click();
    await page.locator('#stage-mask-upload-input').setInputFiles({
      name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer(),
    });
    await expect(page.locator('.stage-mask-canvas-container')).toBeVisible();

    await page.locator('#mask-label-virtually-staged').check();
    await expect(page.locator('#mask-stamp-opts')).toBeVisible();

    // ITS OWN ROW, directly above "Reference photo (optional)". On a PC the group rides
    // inside the toolbar row beside the brush tools; squeezed into that row on a phone it
    // was an uncomfortable place to reach. scripts/app/mask-stamp.js MOVES the element, so
    // this asserts the DOM, not just the pixels — reading order and focus order are the
    // same thing here, which is the reason it moves instead of being re-ordered in CSS.
    const placement = await page.evaluate(() => {
      const stamp = document.getElementById('mask-stamp');
      const controls = document.querySelector('.stage-mask-controls');
      return {
        parent: stamp.parentElement === controls,
        nextIsReferencePhoto: stamp.nextElementSibling?.classList.contains('stage-mask-ref-container'),
        afterThePrompt: [...controls.children].indexOf(stamp)
          > [...controls.children].indexOf(document.querySelector('.stage-mask-prompt-container')),
      };
    });
    expect(placement.parent, 'still buried in the toolbar row').toBe(true);
    expect(placement.nextIsReferencePhoto, 'not directly above the reference photo row').toBe(true);
    expect(placement.afterThePrompt).toBe(true);

    const geo = await page.evaluate(() => {
      const opts = document.getElementById('mask-stamp-opts');
      const content = document.querySelector('.stage-mask-content');
      const o = opts.getBoundingClientRect();
      const c = content.getBoundingClientRect();
      const de = document.documentElement;
      return {
        // Every direct child inside the strip's own box. This is the assertion the
        // squashed-to-68px bug fails: the strip had a sane rect, its contents did not.
        childSpill: Math.max(...[...opts.children].map((k) => k.getBoundingClientRect().right)) - o.right,
        overflowsContent: Math.max(0, Math.round(o.right - c.right), Math.round(c.left - o.left)),
        pageOverflow: de.scrollWidth - de.clientWidth,
      };
    });
    expect(geo.childSpill).toBeLessThanOrEqual(1, 'the swatches paint outside the strip');
    expect(geo.overflowsContent).toBe(0, 'the strip runs past the dialog');
    expect(geo.pageOverflow).toBe(0);

    // On its own row it is just another control, so it starts where the others do.
    // Right-aligned is a DESKTOP behaviour — up there it shares a line with the brush
    // tools and belongs against the far edge; inherited down here it read as a stray
    // fragment floating away from the form.
    const aligned = await page.evaluate(() => {
      const l = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
      return {
        checkbox: l('#mask-stamp .checkbox-container'),
        strip: l('#mask-stamp-opts'),
        formMargin: l('.stage-mask-brush-label'),
      };
    });
    expect(aligned.checkbox).toBe(aligned.formMargin, 'the checkbox drifted off the form margin');
    expect(aligned.strip).toBe(aligned.formMargin, 'the strip drifted off the form margin');

    // The (i) explainer is position:absolute with left:0/right:0, and it is anchored PER
    // SURFACE — the staging modal does it with an id selector this dialog does not have.
    // Unanchored it escapes to .stage-mask-modal (position:fixed, a containing block) and
    // stretches across the viewport above the dialog.
    await page.locator('#mask-stamp .opt-info__btn').tap();
    const tip = await page.evaluate(() => {
      const t = document.getElementById('mask-label-staged-tip').getBoundingClientRect();
      const c = document.querySelector('.stage-mask-content').getBoundingClientRect();
      return { insideDialog: t.left >= c.left - 1 && t.right <= c.right + 1, onScreen: t.top >= -1 };
    });
    expect(tip.insideDialog, 'the (i) tip escaped its surface').toBe(true);
    expect(tip.onScreen).toBe(true);
  });

  test('Masking Studio: the strip does not push the sidebar past the viewport', async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
    await page.goto('/masking-studio.html');
    await expect(page.locator('#ms-file-input')).toBeAttached();

    const toolbarWidth = () => page.evaluate(() =>
      Math.round(document.querySelector('.ms-toolbar').getBoundingClientRect().width));
    const before = await toolbarWidth();

    await page.locator('#ms-label-virtually-staged').check();
    await expect(page.locator('#ms-stamp-opts')).toBeVisible();
    await page.locator('#ms-label-block').scrollIntoViewIfNeeded();

    expect(await toolbarWidth()).toBe(before, 'showing the strip widened the whole sidebar');

    const geo = await page.evaluate(() => {
      const opts = document.getElementById('ms-stamp-opts');
      const o = opts.getBoundingClientRect();
      const btn = opts.querySelector('.stamp-preview__btn').getBoundingClientRect();
      const de = document.documentElement;
      return {
        childSpill: Math.max(...[...opts.children].map((k) => k.getBoundingClientRect().right)) - o.right,
        toolbarRight: Math.round(document.querySelector('.ms-toolbar').getBoundingClientRect().right),
        viewport: window.innerWidth,
        previewClearOfEdge: Math.round(window.innerWidth - btn.right),
        pageOverflow: de.scrollWidth - de.clientWidth,
      };
    });
    expect(geo.childSpill).toBeLessThanOrEqual(1);
    expect(geo.toolbarRight).toBeLessThanOrEqual(geo.viewport, 'the sidebar runs off screen');
    expect(geo.previewClearOfEdge).toBeGreaterThan(4, 'the preview button sits on the screen edge');
    expect(geo.pageOverflow).toBe(0);

    await page.locator('#ms-label-block .opt-info__btn').tap();
    const tip = await page.evaluate(() => {
      const t = document.getElementById('ms-label-staged-tip').getBoundingClientRect();
      const c = document.querySelector('.ms-toolbar').getBoundingClientRect();
      return { insidePanel: t.left >= c.left - 1 && t.right <= c.right + 1, onScreen: t.top >= -1 };
    });
    expect(tip.insidePanel, 'the (i) tip escaped its surface').toBe(true);
    expect(tip.onScreen).toBe(true);
  });
});
