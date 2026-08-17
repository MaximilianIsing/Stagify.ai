// AI Designer — floor-plan renders, in a real browser with /api/chat intercepted.
//
// WHY THIS TIER. Two of the three things asserted here CANNOT be checked anywhere else:
//
//   1. The `else if` bug. lib/chat/chat-post-routing.js runs the staging, generate and CAD
//      dispatch steps UNCONDITIONALLY, so one reply can legitimately carry all three. The
//      browser used to render them through an `else if` ladder, which silently dropped a
//      paid-for floor-plan render whenever the same turn also staged a room — gone from the
//      transcript AND from the history the next turn is built from. There is a unit test
//      for the handler, but "both images are actually on the page" is a claim only a real
//      DOM can make.
//   2. The PDF rasterizer. public/scripts/pdf-page-to-image.js converts a floor-plan PDF to
//      a PNG in the browser because the server has never been able to read a PDF. Its pure
//      helpers are unit-tested; the pdf.js + canvas half needs a browser, and needs a
//      FOREGROUND one — pdf.js drives page.render() with requestAnimationFrame, which never
//      fires in a backgrounded tab.
//
// No real AI call and no cost: /api/chat is fulfilled from a fixture.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

// Two DISTINCT tiny PNGs standing in for renders coming back from the server. They must
// differ, or "both images are on the page" cannot be told apart from "one image, twice".
const CAD_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mNk+M9QzzCKRsEoGgWjAAAsdgL5Sd8sLwAAAABJRU5ErkJggg==';
const STAGED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FBAX/2d6UAAAAAElFTkSuQmCC';

test.describe('AI Designer — floor plans', () => {
  // Desktop-only by design: on a phone viewport the head gate replaces the URL before
  // anything paints, so there is no chat UI to drive.
  test.skip(({ isMobile }) => isMobile, 'the AI Designer is desktop-only by design');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('a CAD render is displayed with a download control', async ({ page }) => {
    await page.route('**/api/chat', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        response: 'Here is your floor plan, furnished.',
        cadImage: CAD_PNG,
        cadImageAnnotation: 'top-down furnished plan CAD: True',
        memories: { stores: [], forgets: [] },
      }),
    }));

    await page.goto('/ai-designer.html');
    const input = page.locator('#chat-input');
    await expect(input).toBeVisible();

    await input.fill('furnish this floor plan');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.message.assistant').last();
    await expect(bubble).toContainText('Here is your floor plan');
    await expect(bubble.locator(`img[src="${CAD_PNG}"]`)).toBeVisible();
  });

  test('a staged room AND a floor-plan render in one reply BOTH survive', async ({ page }) => {
    // The regression. Under the old `else if` ladder this page showed one image, and the
    // floor-plan render — already generated, already paid for — was discarded in the
    // browser with nothing reporting it.
    await page.route('**/api/chat', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        response: 'Staged the bedroom and rendered the plan.',
        stagedImage: STAGED_PNG,
        cadImage: CAD_PNG,
        memories: { stores: [], forgets: [] },
      }),
    }));

    await page.goto('/ai-designer.html');
    const input = page.locator('#chat-input');
    await expect(input).toBeVisible();

    await input.fill('stage the bedroom and render the plan');
    await page.locator('#send-btn').click();

    const bubble = page.locator('.message.assistant').last();
    await expect(bubble).toContainText('Staged the bedroom');

    // BOTH images, named individually — a count alone would pass if the same image were
    // rendered twice, and a presence check on the staged one alone is exactly what the
    // buggy ladder satisfied.
    await expect(bubble.locator(`img[src="${STAGED_PNG}"]`)).toBeVisible();
    await expect(bubble.locator(`img[src="${CAD_PNG}"]`)).toBeVisible();
    // Scoped to the renders themselves: each image card also mounts a download icon and a
    // mask icon, both <img> with file-path srcs, so a bare img count is 6 rather than 2.
    await expect(bubble.locator('img[src^="data:image"]')).toHaveCount(2);

    // And both reached the conversation history, which is what the NEXT turn is built
    // from — the half of the bug that a screenshot would never show. Read through the
    // entry's accessor (window.getConversationHistory), since the array itself is a
    // module-scoped `let` that gets REASSIGNED on reset.
    const urls = await page.evaluate(() => {
      const h = /** @type {any} */ (window).getConversationHistory?.() || [];
      return h.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((c) => c && c.type === 'image_url')
        .map((c) => c.image_url.url);
    });
    expect(urls).toEqual([STAGED_PNG, CAD_PNG]);
  });

  test('a floor-plan PDF is rasterized in the browser before upload', async ({ page }) => {
    // The server cannot read a PDF: chat-upload-prep.js reduces it to the placeholder
    // "[File: … Content cannot be directly read]", so before this it could never become an
    // image and never be rendered — while the product copy promised exactly that.
    await page.goto('/ai-designer.html');
    await expect(page.locator('#chat-input')).toBeVisible();

    // A minimal one-page PDF with real vector content (a rectangle, a dividing wall, and a
    // room label), so a blank-page pass is distinguishable from a real render.
    const result = await page.evaluate(async () => {
      const content = 'BT /F1 24 Tf 60 700 Td (LIVING ROOM  14ft x 18ft) Tj ET\n60 420 480 300 re S\n300 420 m 300 720 l S\n';
      const objs = [
        null,
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${content.length} >>\nstream\n${content}endstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      let pdf = '%PDF-1.4\n';
      const offsets = [];
      for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
      const xref = pdf.length;
      pdf += 'xref\n0 6\n0000000000 65535 f \n';
      for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
      pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

      const bytes = Uint8Array.from(pdf, (c) => c.charCodeAt(0));
      const file = new File([bytes], 'floor-plan.pdf', { type: 'application/pdf' });

      const api = /** @type {any} */ (window).StagifyPdf;
      if (!api) return { error: 'StagifyPdf was never installed on window' };

      const out = await api.toDisplayableFile(file);
      const bmp = await createImageBitmap(out);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      const corner = Array.from(ctx.getImageData(3, 3, 1, 1).data);
      const all = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < all.length; i += 4) if (all[i] < 200) ink++;

      return { name: out.name, type: out.type, w: bmp.width, h: bmp.height, corner, ink };
    });

    expect(result.error).toBeUndefined();
    expect(result.type).toBe('image/png');
    expect(result.name).toBe('floor-plan.png');

    // Scaled toward the 2000px long edge (612x792 at ~2.53x), so the dimension text on the
    // drawing stays legible to the vision model.
    expect(result.h).toBeGreaterThan(1900);
    expect(result.h).toBeLessThanOrEqual(2000);

    // Opaque WHITE background. PDF pages are transparent, and a plan rasterized onto
    // transparency reads as a black drawing on black once flattened downstream.
    expect(result.corner).toEqual([255, 255, 255, 255]);

    // The vectors actually rendered — a blank white page would pass every check above.
    expect(result.ink).toBeGreaterThan(1000);
  });

  test('a mislabelled file is passed through untouched rather than sent to the PDF reader', async ({ page }) => {
    // Content beats extension: files lie about their type, and a real PNG named .pdf handed
    // to pdf.js just throws.
    await page.goto('/ai-designer.html');
    await expect(page.locator('#chat-input')).toBeVisible();

    const passedThrough = await page.evaluate(async () => {
      const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
        'not-really.pdf', { type: 'application/pdf' });
      const out = await /** @type {any} */ (window).StagifyPdf.toDisplayableFile(png);
      return out === png;
    });

    expect(passedThrough).toBe(true);
  });
});
