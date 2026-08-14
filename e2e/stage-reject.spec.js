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
import { openStageModalViaUI, roomPngBuffer, seedFreeSession, seedProSession, stubAnalytics } from './fixtures.js';

const SERVER_ENGLISH = 'Server English that the pack should override.';
const PACK = JSON.parse(fs.readFileSync('public/languages/english.json', 'utf8'));
const PACK_COPY = PACK.errors.unstageable.FOOD;
const CTA = PACK.errors.unstageableCta;

/** Answer the gatekeeper with a fixed verdict. */
const mockVerdict = (page, verdict) => page.route('**/api/validate-image', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(verdict) }),
);

const EXTERIOR = { valid: false, code: 'EXTERIOR', reason: SERVER_ENGLISH };

/** Open the stage modal and hand it a photo. */
async function upload(page) {
  await openStageModalViaUI(page);
  await page.locator('#stage-file-input').setInputFiles({
    name: 'room.png',
    mimeType: 'image/png',
    buffer: await roomPngBuffer(),
  });
}

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

    // The negative control for the EXTERIOR tests below: food has nowhere to go, so the
    // hand-off button must stay down. Without this, a permanently-visible button would
    // pass every assertion in this file. The panel is then a message with no button at
    // all — deliberately, because "Upload Another" above it is the retry.
    await expect(page.locator('#staging-error-viewer-cta')).toBeHidden();
    await expect(page.locator('#new-upload')).toBeVisible();
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

  test('a house exterior offers a Stagify+ user the Exterior Studio', async ({ page }) => {
    await mockVerdict(page, EXTERIOR);
    await upload(page);

    await expect(page.locator('#staging-error-viewer-text')).toHaveText(PACK.errors.unstageable.EXTERIOR);

    const cta = page.locator('#staging-error-viewer-cta');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(CTA.exteriorOpen);
    await expect(cta).toHaveAttribute('href', /exterior-studio\.html$/);
  });

  test('the hand-off survives the retry-and-succeed round trip', async ({ page }) => {
    // The stale-CTA regression. showStagingError() is reached from six call sites and
    // only this one wants a button; if the writer did not actively clear it, the button
    // would sit under the next message — or under a photo that was accepted.
    //
    // The retry goes through "Upload Another" in the viewer header, which is the whole
    // reason the panel carries no retry button of its own: it stays live BEHIND the
    // panel, which this flow also proves.
    await mockVerdict(page, EXTERIOR);
    await upload(page);
    await expect(page.locator('#staging-error-viewer-cta')).toBeVisible();

    await mockVerdict(page, { valid: true, code: null, reason: '' });
    await page.locator('#new-upload').click();
    await page.locator('#stage-file-input').setInputFiles({
      name: 'room2.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });

    await expect(page.locator('#staging-error-viewer')).toBeHidden();
    await expect(page.locator('#staging-error-viewer-cta')).toBeHidden();
  });
});

test.describe('Main tool — the exterior hand-off for a free account', () => {
  // The ONLY surface where the upsell branch is reachable in a browser: /api/validate-image
  // is 401 for anonymous visitors, and the Masking Studio gates free accounts before any
  // upload happens. If this case is not covered here it is not covered anywhere.
  test.beforeEach(async ({ page }) => {
    await seedFreeSession(page);
    await stubAnalytics(page);
  });

  test('a free account is offered Stagify+, and the label matches the destination', async ({ page }) => {
    await mockVerdict(page, EXTERIOR);
    await upload(page);

    const cta = page.locator('#staging-error-viewer-cta');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(CTA.exteriorUpgrade);
    await expect(cta).toHaveAttribute('href', /stagify-plus\.html$/);
    // The pairing is the point: "Open the Exterior Studio" pointing at a pricing table
    // is a bait-and-switch, and it is one wrong branch away at all times.
    await expect(cta).not.toHaveText(CTA.exteriorOpen);
  });
});
