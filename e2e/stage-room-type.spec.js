// Main Stagify tool (index.html) — room-type selection, end to end.
//
// index.spec.js proves the dropdown OPENS; nothing anywhere proved that picking an
// option does the right thing, or that the value the API receives is the one the user
// chose. Both gaps matter more since "Dorm" landed, because it is the first option
// carrying extra chrome (a "New" badge) and the first whose label and submitted value
// are structurally different nodes:
//
//   <div class="option option--with-badge" data-value="Dorm">
//     <span class="option-label" data-lang="roomTypes.dorm">Dorm</span>
//     <span class="option-badge" data-lang="common.newBadge">New</span>
//   </div>
//
// The naive `option.textContent` read that initCustomSelect used to do yields "DormNew"
// here, and the translated label must never leak into the request — the API contract is
// the untranslated data-value. Both are asserted below.
//
// /api/validate-image and /api/process-image are mocked — no real Gemini call, no cost.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { roomPngBuffer, seedProSession, stubAnalytics } from './fixtures.js';

const PACKS = (lang) => JSON.parse(fs.readFileSync(`public/languages/${lang}.json`, 'utf8'));

/** Open index.html with the stage modal lifted, exactly as the sibling specs do. */
async function openStageModal(page, path = '/index.html') {
  await page.goto(path);
  // Opening the modal through the UI requires the sign-in flow; lift `.hidden` the
  // way the app's own openModal() does.
  await page.evaluate(() => {
    const modal = document.getElementById('stage-modal');
    if (modal) modal.classList.remove('hidden');
  });
}

/** Pick a room type through the real dropdown wiring (trigger click → option click). */
async function pickRoomType(page, value) {
  const select = page.locator('#room-type-select');
  await select.locator('.select-trigger').click();
  await expect(select.locator('.select-menu')).not.toHaveClass(/hidden/);
  await select.locator(`.option[data-value="${value}"]`).click();
  return select;
}

test.describe('Main tool — room-type selection', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
    await stubAnalytics(page);
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, code: null, reason: '' }),
      }),
    );
  });

  test('the Dorm option renders a New badge and does not leak it into the trigger', async ({ page }) => {
    await openStageModal(page);

    const select = page.locator('#room-type-select');
    const dorm = select.locator('.option[data-value="Dorm"]');
    await select.locator('.select-trigger').click();

    // The badge is real, visible chrome — not just markup.
    await expect(dorm.locator('.option-badge')).toBeVisible();
    await expect(dorm.locator('.option-badge')).toHaveText(PACKS('english').common.newBadge);

    await dorm.click();

    // The regression this guards: reading the whole option's textContent gives "DormNew".
    await expect(select.locator('.select-value')).toHaveText(PACKS('english').roomTypes.dorm);
    await expect(select).toHaveAttribute('data-value', 'Dorm');
    await expect(select.locator('.select-menu')).toHaveClass(/hidden/);
    await expect(dorm).toHaveClass(/selected/);
  });

  test('the selected room type is what reaches /api/process-image', async ({ page }) => {
    let submittedRoomType = null;
    await page.route('**/api/process-image', async (route) => {
      const body = route.request().postData() || '';
      // multipart/form-data — pull the value of the roomType part.
      const m = body.match(/name="roomType"\r?\n\r?\n([^\r\n]*)/);
      submittedRoomType = m ? m[1] : `NO roomType PART IN BODY (len ${body.length})`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stopped by e2e' }),
      });
    });

    await openStageModal(page);
    await pickRoomType(page, 'Dorm');

    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });
    await expect(page.locator('#stage-preview')).toBeVisible();
    await page.locator('#process-btn').click();

    await expect.poll(() => submittedRoomType, { timeout: 15_000 }).toBe('Dorm');
  });

  test('a localized page submits the English value, not the translated label', async ({ page }) => {
    // The label is display-only; promptMatrix is keyed on the English string, so a
    // translated value reaching the API would miss the matrix and stage generically.
    let submittedRoomType = null;
    await page.route('**/api/process-image', async (route) => {
      const m = (route.request().postData() || '').match(/name="roomType"\r?\n\r?\n([^\r\n]*)/);
      submittedRoomType = m ? m[1] : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stopped by e2e' }),
      });
    });

    await openStageModal(page, '/es');

    const select = await pickRoomType(page, 'Dorm');
    // Server-rendered Spanish label, English wire value.
    await expect(select.locator('.select-value')).toHaveText(PACKS('spanish').roomTypes.dorm);
    await expect(select.locator('.option[data-value="Dorm"] .option-badge')).toHaveText(
      PACKS('spanish').common.newBadge,
    );

    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });
    await expect(page.locator('#stage-preview')).toBeVisible();
    await page.locator('#process-btn').click();

    await expect.poll(() => submittedRoomType, { timeout: 15_000 }).toBe('Dorm');
  });
});

// The "Remove existing furniture" control is gated by plan AND room type, from two
// different files (auth.js and app.js). The unit suite covers the rule in isolation
// (test/remove-furniture-gate.test.js); these prove the wiring in a real browser —
// that the room-type select actually re-runs the gate, and that a box checked before
// the switch does not still submit removeFurniture=true.
test.describe('Main tool — remove-furniture gate', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page); // plan: 'pro' — the control is Stagify+ only
    await stubAnalytics(page);
    await page.route('**/api/validate-image', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, code: null, reason: '' }),
      }),
    );
  });

  test('the control is offered on a normal room and withdrawn when Dorm is picked', async ({ page }) => {
    await openStageModal(page);
    const row = page.locator('#remove-furniture-row');

    await expect(row).toBeVisible(); // pro user, default room (Bedroom)

    await pickRoomType(page, 'Dorm');
    await expect(row).toBeHidden();

    // …and comes back on a room whose furniture is not fixed.
    await pickRoomType(page, 'Living room');
    await expect(row).toBeVisible();
  });

  test('a box checked before switching to Dorm does not submit removeFurniture', async ({ page }) => {
    // The failure this guards: hiding the row without clearing the checkbox. The
    // pipeline reads `#remove-furniture.checked`, not the row's visibility, so the
    // request would still ask to discard the dorm's fixed furniture.
    let submitted = null;
    await page.route('**/api/process-image', async (route) => {
      const body = route.request().postData() || '';
      const grab = (field) => (body.match(new RegExp(`name="${field}"\\r?\\n\\r?\\n([^\\r\\n]*)`)) || [])[1];
      submitted = { roomType: grab('roomType'), removeFurniture: grab('removeFurniture') };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stopped by e2e' }),
      });
    });

    await openStageModal(page);

    const checkbox = page.locator('#remove-furniture');
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    // The keep-furniture box rides on the checkbox, so it should be showing now.
    await expect(page.locator('#keep-furniture-row')).toBeVisible();

    await pickRoomType(page, 'Dorm');
    await expect(page.locator('#remove-furniture-row')).toBeHidden();
    await expect(checkbox).not.toBeChecked();
    // Clearing must also fire `change`, which is what puts the dependent UI back.
    await expect(page.locator('#keep-furniture-row')).toBeHidden();

    await page.locator('#stage-file-input').setInputFiles({
      name: 'room.png',
      mimeType: 'image/png',
      buffer: await roomPngBuffer(),
    });
    await expect(page.locator('#stage-preview')).toBeVisible();
    await page.locator('#process-btn').click();

    await expect.poll(() => submitted, { timeout: 15_000 }).toEqual({
      roomType: 'Dorm',
      removeFurniture: 'false',
    });
  });
});
