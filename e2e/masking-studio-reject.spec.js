// Masking Studio — stageability reject path. Proves the lag fix in
// masking-studio/upload.js: the uploaded photo enters the studio IMMEDIATELY
// (draw phase) without waiting on the /api/validate-image vision round-trip, and
// is then pulled back out to the empty dropzone when the verdict comes back
// negative. The validate-image response is gated (held open until the test has
// observed the draw phase) so the ordering is deterministic, not a timing race.
// No real Gemini call, no cost.
//
// Doubles as the browser-level proof that rejection copy is LOCALIZED: the server
// sends a category code plus canonical English, and the page must render the string
// from the language pack instead. The mock's `reason` below is deliberately NOT the
// pack's wording, so an assertion against the pack can only pass if the lookup ran.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { roomPngBuffer, seedProSession } from './fixtures.js';

// Distinct from the pack copy on purpose — if the lookup silently stopped working,
// this string would surface and the assertion below would fail.
const SERVER_ENGLISH = 'This looks like a selfie, not a room.';

// Sourced from the pack rather than hardcoded, so re-wording the copy can't break
// this test (test/unstageable-i18n.test.js is what guards the key's existence).
const PACK_COPY = JSON.parse(fs.readFileSync('public/languages/english.json', 'utf8'))
  .errors.unstageable.PERSON_PORTRAIT;

test.describe('Masking Studio — stageability reject', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page, { msHelpSeen: true });
  });

  test('photo shows immediately, then reverts to the dropzone when the pre-check rejects it', async ({ page }) => {
    // Hold the verdict open until we have proven the photo is already in the
    // studio — the whole point of the fix is that the show does not await this.
    let releaseValidate;
    const validateGate = new Promise((resolve) => { releaseValidate = resolve; });
    await page.route('**/api/validate-image', async (route) => {
      await validateGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: false, code: 'PERSON_PORTRAIT', reason: SERVER_ENGLISH }),
      });
    });

    await page.goto('/masking-studio.html');

    const fileInput = page.locator('#ms-file-input');
    await expect(fileInput).toBeAttached();
    await fileInput.setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: await roomPngBuffer() });

    // Draw phase reached (auto-added active layer's prompt box appears) WHILE the
    // validate-image request is still pending — the image did not wait on it.
    const prompt = page.locator('.ms-layer.is-active textarea.ms-layer-prompt');
    await expect(prompt).toBeVisible();
    await expect(page.locator('#ms-stack')).toBeVisible();
    await expect(page.locator('#ms-dropzone')).toBeHidden();

    // Now let the negative verdict land: the photo is torn back out.
    releaseValidate();

    await expect(page.locator('#ms-dropzone')).toBeVisible();
    await expect(page.locator('#ms-stack')).toBeHidden();
    await expect(prompt).toHaveCount(0);
    // The pack's wording wins over the server's English — i.e. the code was localized.
    const toast = page.locator('.toast--error');
    await expect(toast).toContainText(PACK_COPY);
    await expect(toast).not.toContainText(SERVER_ENGLISH);
  });
});
