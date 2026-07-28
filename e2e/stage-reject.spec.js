// Main Stagify tool (index.html) — stageability reject path.
//
// The sibling spec (masking-studio-reject.spec.js) covers the same gatekeeper in the
// OTHER studio, which has a different consumer: a toast that tears the photo back out.
// Here the verdict lands in the stage modal's inline error viewer instead, through a
// separate code path (scripts/app.js + app/staging-pipeline.js), so it needs its own
// browser coverage — the two studios share only the resolver, not the plumbing.
//
// Also pins that the LOCALIZED copy wins: the server sends a category code plus its
// canonical English, and the page must render the language pack's wording for that code.
// The mock's `reason` is deliberately not the pack's text, so an assertion against the
// pack can only pass if the lookup actually ran.
//
// /api/validate-image is mocked — no real Gemini call, no cost.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openStageModalViaUI, roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

const SERVER_ENGLISH = 'Server English that the pack should override.';
const PACK_COPY = JSON.parse(fs.readFileSync('public/languages/english.json', 'utf8'))
  .errors.unstageable.FOOD;

test.describe('Main tool — stageability reject', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
  });

  test('a rejected upload shows the localized reason in the stage modal', async ({ page }) => {
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: false, code: 'FOOD', reason: SERVER_ENGLISH }),
      }),
    );

    await openStageModalViaUI(page);

    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });

    // The pre-check fires on upload and hard-gates staging, so the error surfaces
    // without ever clicking Stage — no generation is spent on a rejected photo.
    const errorText = page.locator('#staging-error-viewer-text');
    await expect(errorText).toHaveText(PACK_COPY);
    await expect(page.locator('#staging-error-viewer')).toBeVisible();
    await expect(errorText).not.toHaveText(SERVER_ENGLISH);

    // The paint-brush FAB paints above the panel (z-index 12 vs 6) and would
    // float over the message, offering to edit a photo the app is rejecting.
    // The approved-upload test below shows it visible for this same pro session,
    // so this assertion cannot pass just because the FAB is never there.
    await expect(page.locator('#mask-edit-btn')).toBeHidden();
  });

  test('an approved upload shows no rejection error', async ({ page }) => {
    // The negative control: without it, a selector that never matches would make the
    // test above pass for the wrong reason.
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, code: null, reason: '' }),
      }),
    );

    await openStageModalViaUI(page);

    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });

    await expect(page.locator('#stage-preview')).toBeVisible();
    await expect(page.locator('#staging-error-viewer')).toBeHidden();
    // Pro session + a loaded photo: the FAB belongs on screen here. This is what
    // makes the hidden-FAB assertion in the reject test above non-vacuous.
    await expect(page.locator('#mask-edit-btn')).toBeVisible();
  });
});
