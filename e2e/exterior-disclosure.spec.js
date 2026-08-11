// "Label as virtually staged" in the Exterior Studio.
//
// WHY THIS SURFACE GETS ITS OWN SPEC RATHER THAN A CASE IN exterior-studio.spec.js
// The badge itself is server work and is unit-tested there. What only a browser can show
// is the two things this control has actually broken every time it has been copied onto a
// new surface, both invisible to unit tests and to every desktop screenshot:
//
//   1. The (i) explainer is position:absolute with left:0/right:0 and is anchored PER
//      SURFACE. Unanchored it escapes to whatever positioned ancestor it finds and
//      stretches across the panel.
//   2. .stamp-opts is flex-wrap:nowrap around four fixed 38px swatches, so its min-content
//      is large. Dropped into a grid item it becomes that item's automatic minimum and
//      pushes the whole sidebar wider — with no page scrollbar to show it happening.
//
// And one thing that is not layout at all: this page bills per render, so the badge must
// not be able to make a render happen. It is not a change to the property.
import { test, expect } from '@playwright/test';
import { PRO_ME, seedProSession, roomPngBuffer, TINY_PNG_DATA_URL } from './fixtures.js';

const URL = '/exterior-studio.html';

const STAMP_FAILED = 'We couldn’t add the "virtually staged" label, so your photo wasn’t delivered.'
  + ' Untick that option to enhance without it.';

/** Mock the studio's one endpoint, capturing the multipart body it sent. */
async function stubEnhance(page, { status = 200, body = null } = {}) {
  /** @type {{ postData: string | null }[]} */
  const calls = [];
  await page.route('**/api/enhance-exterior', async (route) => {
    calls.push({ postData: route.request().postData() });
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { success: true, image: TINY_PNG_DATA_URL, user: PRO_ME.user }),
    });
  });
  return calls;
}

/** Put a photo in the tool so the submit button's other precondition is met. */
async function withPhoto(page) {
  await page.setInputFiles('#ex-file', {
    name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
  });
}

test.describe('Exterior Studio — label as virtually staged', () => {
  test.beforeEach(async ({ page }) => { await seedProSession(page); });

  test('ticking the box reveals the strip and costs the panel no width', async ({ page }) => {
    await page.goto(URL);
    await expect(page.locator('#ex-tool')).toBeVisible();

    const panelWidth = () => page.evaluate(() =>
      Math.round(document.querySelector('.ex-toolbar').getBoundingClientRect().width));
    const before = await panelWidth();

    await expect(page.locator('#ex-stamp-opts')).toBeHidden();
    await page.check('#ex-label-virtually-staged');
    await expect(page.locator('#ex-stamp-opts')).toBeVisible();

    expect(await panelWidth()).toBe(before, 'showing the strip widened the controls panel');

    const geo = await page.evaluate(() => {
      const opts = document.getElementById('ex-stamp-opts');
      const panel = document.querySelector('.ex-toolbar');
      const o = opts.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const de = document.documentElement;
      return {
        // Every direct child measured against the strip's OWN box. A strip that is handed
        // too little room keeps a sane rect while its fixed-size swatches paint outside it.
        childSpill: Math.max(...[...opts.children].map((k) => k.getBoundingClientRect().right)) - o.right,
        overflowsPanel: Math.max(0, Math.round(o.right - p.right), Math.round(p.left - o.left)),
        pageOverflow: de.scrollWidth - de.clientWidth,
      };
    });
    expect(geo.childSpill).toBeLessThanOrEqual(1, 'the swatches paint outside the strip');
    expect(geo.overflowsPanel).toBe(0, 'the strip runs past the controls panel');
    expect(geo.pageOverflow).toBe(0);
  });

  test('the strip is ONE row, and stays one row in a long-label language', async ({ page }) => {
    // The whole strip belongs on a single line: swatches, then the size slider, then the
    // preview. It reached two rows twice — first because the slider is flex:1 1 auto and
    // ate the leftover width, then because the preview's LABEL is translated and
    // "Pré-visualização" is some 60px wider than "Preview". The label is gone from this
    // surface for exactly that reason, so the row's width no longer depends on the pack —
    // which is what makes one row a promise instead of something that holds in English.
    const measure = async (url) => {
      await page.goto(url);
      await expect(page.locator('#ex-tool')).toBeVisible();
      await page.check('#ex-label-virtually-staged');
      await expect(page.locator('#ex-stamp-opts')).toBeVisible();
      return page.evaluate(() => {
        const opts = document.getElementById('ex-stamp-opts');
        const o = opts.getBoundingClientRect();
        const kids = [...opts.children].map((k) => k.getBoundingClientRect());
        const btn = opts.querySelector('.stamp-preview__btn');
        return {
          // Rows, counted by how many children START one — not by distinct tops, which
          // align-items:center makes different for every child on the SAME row.
          rows: kids.filter((b) => Math.round(b.left) === Math.round(o.left)).length,
          spill: Math.round(Math.max(...kids.map((b) => b.right)) - o.right),
          sliderWidth: Math.round(opts.querySelector('.stamp-opts__size').getBoundingClientRect().width),
          // Its name has to survive losing its visible text: a display:none span is out of
          // the accessibility tree, so without the aria-label this is an unlabelled button.
          previewName: btn.getAttribute('aria-label'),
          previewWidth: Math.round(btn.getBoundingClientRect().width),
        };
      });
    };

    const en = await measure(URL);
    const pt = await measure('/pt/exterior-studio.html');

    expect(en.rows).toBe(1, 'the strip broke onto a second row');
    expect(pt.rows).toBe(1, 'the longer language pushed the strip onto a second row');
    expect(en.spill).toBeLessThanOrEqual(1);
    expect(pt.spill).toBeLessThanOrEqual(1);

    // The preview button is the same size in both, which is the property that makes the
    // row language-independent rather than merely wide enough today.
    expect(pt.previewWidth).toBe(en.previewWidth);
    // ...and it is still announced, in the visitor's language.
    expect(en.previewName).toBeTruthy();
    expect(pt.previewName).toBeTruthy();
    expect(pt.previewName).not.toBe(en.previewName, 'the page did not actually translate');

    // A slider long enough to use and not so long it reads as the row's main event — it
    // was 161px, having absorbed all the slack the other two controls left behind.
    expect(en.sliderWidth).toBeGreaterThan(70);
    expect(en.sliderWidth).toBeLessThanOrEqual(120);
    expect(pt.sliderWidth).toBe(en.sliderWidth);
  });

  test('the (i) explainer stays inside this surface', async ({ page }) => {
    // It has no positioned ancestor of its own unless .ex-label-block gives it one. The
    // staging modal anchors its copy with an id rule that does not exist on this page.
    await page.goto(URL);
    await expect(page.locator('#ex-tool')).toBeVisible();
    await page.locator('#ex-label-block .opt-info__btn').hover();

    const tip = await page.evaluate(() => {
      const t = document.getElementById('ex-label-staged-tip').getBoundingClientRect();
      const p = document.querySelector('.ex-toolbar').getBoundingClientRect();
      return {
        inside: t.left >= p.left - 1 && t.right <= p.right + 1,
        onScreen: t.top >= -1,
        width: Math.round(t.width),
        panel: Math.round(p.width),
      };
    });
    expect(tip.inside, `the tip escaped its surface (${tip.width}px against a ${tip.panel}px panel)`).toBe(true);
    expect(tip.onScreen).toBe(true);
  });

  test('the badge alone is NOT a request — it cannot buy a render', async ({ page }) => {
    // The submit gate exists because a request with nothing selected falls through to a
    // generic correction pass: a real render, really billed, that nobody asked for. A
    // caption is not a change to the property, so it must not open that door.
    await page.goto(URL);
    await withPhoto(page);
    await expect(page.locator('#ex-enhance')).toBeDisabled();

    await page.check('#ex-label-virtually-staged');
    await expect(page.locator('#ex-enhance')).toBeDisabled();

    // ...and it still rides along once a real change IS asked for.
    await page.check('#ex-clutter');
    await expect(page.locator('#ex-enhance')).toBeEnabled();
  });

  test('the chosen style and size reach the server, and OFF is stated not omitted', async ({ page }) => {
    const calls = await stubEnhance(page);
    await page.goto(URL);
    await withPhoto(page);
    await page.check('#ex-clutter');

    // First, with the option left alone.
    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();
    expect(calls[0].postData || '').toMatch(/name="labelVirtuallyStaged"[\s\S]*?false/);

    await page.check('#ex-label-virtually-staged');
    // Clicked through the swatch LABEL: the radio itself is clipped to a pixel so it keeps
    // focus and semantics without being visible, which leaves nothing for a direct click.
    await page.locator('#ex-stamp-opts .stamp-swatch', { has: page.locator('input[value="banner"]') }).click();
    await expect(page.locator('#ex-stamp-opts input[value="banner"]')).toBeChecked();
    // The slider reports a multiplier; drive it to a value that is not the default so a
    // hard-coded 1 cannot pass this.
    await page.locator('#ex-stamp-scale').fill('1.4');
    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();

    const sent = calls[1].postData || '';
    expect(sent).toMatch(/name="labelVirtuallyStaged"[\s\S]*?true/);
    expect(sent).toMatch(/name="stampStyle"[\s\S]*?banner/);
    expect(sent).toMatch(/name="stampScale"[\s\S]*?1\.4/);
    expect(sent).toMatch(/name="stampLang"/);
  });

  test('the preview is the real stamp, rendered by the server', async ({ page }) => {
    // A CSS mock would be a second implementation of the badge that nothing keeps in step,
    // and the person who found the drift would be an agent looking at a published photo.
    /** @type {string[]} */
    const previews = [];
    await page.route('**/api/disclosure-preview*', async (route) => {
      previews.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(TINY_PNG_DATA_URL.split(',')[1], 'base64'),
      });
    });
    await page.goto(URL);
    await expect(page.locator('#ex-tool')).toBeVisible();

    await page.check('#ex-label-virtually-staged');
    await page.locator('#ex-stamp-opts .stamp-swatch', { has: page.locator('input[value="minimal"]') }).click();
    await expect.poll(() => previews.some((u) => u.includes('style=minimal'))).toBe(true);
  });

  test('a withheld stamp says which option to untick, and keeps the photo on screen', async ({ page }) => {
    // The stamp fails closed, so this 500 means the render SUCCEEDED and was held back.
    // Told "enhancement failed", the user retries into the same wall and pays each time.
    await stubEnhance(page, {
      status: 500,
      body: { error: STAMP_FAILED, code: 'DISCLOSURE_STAMP_FAILED' },
    });
    await page.goto(URL);
    await withPhoto(page);
    await page.check('#ex-clutter');
    await page.check('#ex-label-virtually-staged');
    await page.click('#ex-enhance');

    // One assertion against the toast, not two: it lives ~4.2s plus a fade, so a
    // visibility check followed by a second query against it is a race.
    await expect(page.locator('.toast, .toast-error').first()).toContainText(/untick/i);

    // Nothing was delivered, so the workspace must still be showing their upload — and the
    // option stays ticked, because nothing here may untick it on their behalf.
    await expect(page.locator('#ex-result')).toBeHidden();
    await expect(page.locator('#ex-preview')).toBeVisible();
    await expect(page.locator('#ex-label-virtually-staged')).toBeChecked();
  });
});
