// The Exterior Studio, in a real browser.
//
// This page is the only Stagify+ surface that does NOT bounce a visitor without a token,
// and that is the whole point of it: it shows one of three views on a single URL so the
// pitch (and the crawler) get a real page. Everything about that arrangement is invisible
// to a unit test, because a unit test cannot prove the absence of a redirect — it can
// only prove that the module it imported did not fire one. Only a real navigation shows
// that nothing else on the page did either.
//
// So the load-bearing assertion here is a NEGATIVE, and negatives pass for the wrong
// reasons all the time. Each one is therefore paired with its positive: "no redirect"
// alongside "and here is the content that proves the page really rendered", and "the tool
// is hidden" alongside "and the tool is present in the DOM at all".
import { test, expect } from '@playwright/test';
import {
  PRO_ME, seedProSession, seedFreeSession,
  stubAnalytics, hideStagingBanner, roomPngBuffer, TINY_PNG_DATA_URL,
} from './fixtures.js';

const URL = '/exterior-studio.html';

const HERO = '.ex-intro h1';
const FEATURES = '#ex-features';
const TOOL = '#ex-tool';
const GATE = '#ex-pro-gate';
const NAV_ROW = '.staging-menu__panel a[href="exterior-studio.html"]';

/** A visitor with no session at all: no token, and /api/auth/me answers 401. */
async function signedOut(page) {
  await stubAnalytics(page);
  await hideStagingBanner(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }),
  );
}

/** Mock the one endpoint the studio calls, capturing the multipart it sent. */
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

test.describe('Exterior Studio — the public view', () => {
  test('an anonymous visitor gets the real page, NOT a redirect to the pricing table', async ({ page }) => {
    // The behaviour that separates this page from masking-studio.html and
    // ai-designer.html, whose head gates location.replace() anyone without a token —
    // which is also why Googlebot never sees either of them.
    await signedOut(page);
    await page.goto(URL);

    await expect(page).toHaveURL(/exterior-studio\.html$/);
    // Paired positive: the URL surviving proves nothing on its own — a blank document
    // has the right URL too.
    await expect(page.locator(HERO)).toBeVisible();
    await expect(page.locator(FEATURES)).toBeVisible();
    await expect(page.locator('.site-header')).toBeVisible();
  });

  test('the tool is present but hidden, and the CTA sells', async ({ page }) => {
    await signedOut(page);
    await page.goto(URL);

    // Present-but-hidden, not absent: `toBeHidden` passes just as happily on an element
    // that was never rendered, which would make this assertion meaningless the day
    // somebody deletes the section.
    await expect(page.locator(TOOL)).toHaveCount(1);
    await expect(page.locator(TOOL)).toBeHidden();

    await expect(page.locator('#ex-cta')).toHaveAttribute('href', 'stagify-plus.html');
    // No modal over a first-time reader who has not been told the price yet.
    await expect(page.locator(GATE)).toBeHidden();
  });

  test('the page is indexable — no noindex, and a canonical of its own', async ({ page }) => {
    // The SEO half of the no-redirect decision. Without this the redirect could come back
    // and only the ranking would notice, months later.
    await signedOut(page);
    await page.goto(URL);

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index, follow/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://stagify.ai/exterior-studio.html');
    await expect(page.locator('h1')).toHaveCount(1);
  });
});

test.describe('Exterior Studio — signed-in free account', () => {
  test('gets the upgrade dialog over the pitch, and still no tool', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto(URL);

    await expect(page.locator(GATE)).toBeVisible();
    await expect(page.locator(`${GATE} a[href="stagify-plus.html"]`)).toBeVisible();
    await expect(page.locator(TOOL)).toBeHidden();
    // The pitch stays behind the dialog rather than being replaced by it — dismissing by
    // navigating away must not have left them on a blank page.
    await expect(page.locator(HERO)).toBeVisible();
  });
});

test.describe('Exterior Studio — Stagify+', () => {
  test.beforeEach(async ({ page }) => { await seedProSession(page); });

  test('gets the tool, and the pitch is taken away', async ({ page }) => {
    await page.goto(URL);

    await expect(page.locator(TOOL)).toBeVisible();
    await expect(page.locator(FEATURES)).toBeHidden();
    await expect(page.locator(GATE)).toBeHidden();
    // The sales button goes too — the tool is right there, so offering to sell it again
    // is noise. The masking studio has no hero button for the same reason.
    await expect(page.locator('#ex-hero-actions')).toBeHidden();
  });

  test('the controls are OPT-IN: nothing is requested, and submit stays disabled', async ({ page }) => {
    // The complaint this redesign answers: the first build showed two dropdowns about the
    // weather that someone who only wanted the bins gone still had to read and dismiss.
    await page.goto(URL);
    await expect(page.locator(TOOL)).toBeVisible();

    for (const id of ['#ex-use-time', '#ex-use-sky', '#ex-vehicles', '#ex-clutter', '#ex-people', '#ex-snow', '#ex-wet']) {
      await expect(page.locator(id)).not.toBeChecked();
    }
    // The preset dropdowns do not exist on screen until their row is ticked.
    await expect(page.locator('#ex-time')).toBeHidden();
    await expect(page.locator('#ex-sky')).toBeHidden();

    await expect(page.locator('#ex-enhance')).toBeDisabled();
  });

  test('"just remove the bin bags" is a complete request on its own', async ({ page }) => {
    // The exact case the user described. One tick, one click — and critically, the wire
    // must carry NO time-of-day or sky change, because none was asked for.
    const calls = await stubEnhance(page);
    await page.goto(URL);
    await page.setInputFiles('#ex-file', {
      name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
    });
    await expect(page.locator('#ex-enhance')).toBeDisabled();

    await page.check('#ex-clutter');
    await expect(page.locator('#ex-enhance')).toBeEnabled();
    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();

    const sent = calls[0].postData || '';
    expect(sent).toMatch(/name="removeClutter"[\s\S]*?true/);
    expect(sent).toMatch(/name="removeVehicles"[\s\S]*?false/);
    expect(sent).toMatch(/name="timeOfDay"[\s\S]*?keep/);
    expect(sent).toMatch(/name="sky"[\s\S]*?keep/);
    expect(sent).not.toContain('goldenHour');
  });

  test('a revealed preset select sits on its label\'s centre line', async ({ page }) => {
    // The select is revealed BESIDE its label rather than under it, which saves a row per
    // ticked preset — and puts both in one `align-items: center` flex row, where centring
    // is computed on the flex ITEM including its padding. So any asymmetric vertical
    // padding on the revealed body lifts the select by half of it and strands it above its
    // own label. That shipped at 5px and reads as a wonky control, not as a CSS bug, which
    // is why it needs measuring rather than reviewing: it is invisible in the stylesheet
    // and obvious on screen.
    await page.goto(URL);
    await expect(page.locator(TOOL)).toBeVisible();
    await page.check('#ex-use-time');
    await page.check('#ex-use-sky');

    for (const [boxSel, selectSel] of [['#ex-use-time', '#ex-time'], ['#ex-use-sky', '#ex-sky']]) {
      const box = await page.locator(boxSel).boundingBox();
      const select = await page.locator(selectSel).boundingBox();
      const boxMid = box.y + box.height / 2;
      const selectMid = select.y + select.height / 2;
      expect(
        Math.abs(boxMid - selectMid),
        `${selectSel} is off its label's centre line by ${(boxMid - selectMid).toFixed(1)}px`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('"just clear the snow" is a complete request, and changes nothing else', async ({ page }) => {
    // The same shape as the bin-bags case, for the removal with the most to get wrong. Snow
    // is the row that uncovers the whole plot rather than one patch of driveway, so a
    // request that quietly also relit the scene or swapped the sky would be handing back a
    // photograph of a different day — and the browser is the only place the full chain
    // (checkbox → controls.js → FormData → the wire) is exercised for real.
    const calls = await stubEnhance(page);
    await page.goto(URL);
    await page.setInputFiles('#ex-file', {
      name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
    });
    await expect(page.locator('#ex-enhance')).toBeDisabled();

    await page.check('#ex-snow');
    await expect(page.locator('#ex-enhance')).toBeEnabled();
    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();

    const sent = calls[0].postData || '';
    expect(sent).toMatch(/name="removeSnow"[\s\S]*?true/);
    for (const off of ['removeVehicles', 'removeClutter', 'removePeople', 'removeWetWeather']) {
      expect(sent).toMatch(new RegExp(`name="${off}"[\\s\\S]*?false`));
    }
    expect(sent).toMatch(/name="timeOfDay"[\s\S]*?keep/);
    expect(sent).toMatch(/name="sky"[\s\S]*?keep/);
    expect(sent).not.toContain('goldenHour');
  });

  test('free text alone enables the button, without touching a checkbox', async ({ page }) => {
    const calls = await stubEnhance(page);
    await page.goto(URL);
    await page.setInputFiles('#ex-file', {
      name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
    });
    // Typing, not blurring: `change` on a textarea only fires on blur, so the button has
    // to come alive on `input` or the visitor thinks the tool ignored them.
    await page.fill('#ex-notes', 'remove the bin bags by the gate');
    await expect(page.locator('#ex-enhance')).toBeEnabled();

    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();
    expect(calls[0].postData || '').toContain('remove the bin bags by the gate');
  });

  test('upload → tick options → enhance → compare, with the wire values sent', async ({ page }) => {
    const calls = await stubEnhance(page);
    await page.goto(URL);
    await expect(page.locator(TOOL)).toBeVisible();

    await page.setInputFiles('#ex-file', {
      name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
    });
    // The drop panel gives way to the chosen photo, and step 1 swaps its hint for the card.
    await expect(page.locator('#ex-preview')).toBeVisible();
    await expect(page.locator('#ex-drop')).toBeHidden();
    await expect(page.locator('#ex-replace')).toBeVisible();

    // Ticking a row reveals its dropdown — the control does not exist before that.
    await page.check('#ex-use-time');
    await expect(page.locator('#ex-time')).toBeVisible();
    await page.selectOption('#ex-time', 'dusk');
    await page.check('#ex-use-sky');
    await page.selectOption('#ex-sky', 'clearBlue');
    await page.check('#ex-vehicles');
    await page.fill('#ex-notes', 'keep the flag');

    await page.click('#ex-enhance');

    await expect(page.locator('#ex-result')).toBeVisible();
    await expect(page.locator('#ex-done')).toBeVisible();
    await expect(page.locator('#ex-compare-after')).toHaveJSProperty('src', TINY_PNG_DATA_URL);

    // What actually reached the server. The English wire values, not the labels.
    expect(calls).toHaveLength(1);
    const sent = calls[0].postData || '';
    expect(sent).toContain('dusk');
    expect(sent).toContain('clearBlue');
    expect(sent).toContain('keep the flag');
    // Both booleans stated explicitly — an unchecked toggle must say 'false', not vanish.
    expect(sent).toMatch(/name="removeVehicles"[\s\S]*?true/);
    expect(sent).toMatch(/name="removeClutter"[\s\S]*?false/);
  });

  test('a rejected upload shows the category message and keeps the photo on screen', async ({ page }) => {
    // The whole point of the 422 copy: the visitor should know to try a different photo,
    // and should not have to re-pick the one they already chose.
    await stubEnhance(page, {
      status: 422,
      body: { code: 'ANIMAL', reason: 'This looks like a photo of a pet.' },
    });
    await page.goto(URL);
    await page.setInputFiles('#ex-file', {
      name: 'dog.png', mimeType: 'image/png', buffer: await roomPngBuffer(300, 300),
    });
    await page.check('#ex-clutter');
    await page.click('#ex-enhance');

    await expect(page.locator('#toast-host')).toContainText(/pet/i);
    await expect(page.locator('#ex-preview')).toBeVisible();
    await expect(page.locator('#ex-result')).toBeHidden();
    // And the form is usable again rather than stuck in its working state.
    await expect(page.locator('#ex-enhance')).toBeEnabled();
  });

  test('start over returns the tool to its empty state', async ({ page }) => {
    await stubEnhance(page);
    await page.goto(URL);
    await page.setInputFiles('#ex-file', {
      name: 'house.png', mimeType: 'image/png', buffer: await roomPngBuffer(640, 420),
    });
    await page.check('#ex-vehicles');
    await page.click('#ex-enhance');
    await expect(page.locator('#ex-result')).toBeVisible();

    await page.click('#ex-startover');
    await expect(page.locator('#ex-drop')).toBeVisible();
    await expect(page.locator('#ex-result')).toBeHidden();
    await expect(page.locator('#ex-preview')).toBeHidden();
  });
});

test.describe('Exterior Studio — the nav row', () => {
  test('a Stagify+ visitor reaches the studio from the Staging dropdown', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await page.click('.staging-menu__trigger');

    const row = page.locator(NAV_ROW);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/is-locked/);
    await row.click();
    await expect(page).toHaveURL(/exterior-studio\.html$/);
    await expect(page.locator(TOOL)).toBeVisible();
  });

  test('a locked row still opens the STUDIO, not the pricing page', async ({ page }) => {
    // The data-staging-preview rule. Every other locked row sends a non-Pro visitor to
    // stagify-plus.html; this one has a public view to show them, and skipping the pitch
    // to show the price is how the whole arrangement stops paying for itself.
    await signedOut(page);
    await page.goto('/index.html');
    await page.click('.staging-menu__trigger');

    const row = page.locator(NAV_ROW);
    await expect(row).toHaveClass(/is-locked/);
    await row.click();

    await expect(page).toHaveURL(/exterior-studio\.html$/);
    await expect(page.locator(FEATURES)).toBeVisible();
  });

  test('the row is offered on a phone, unlike the AI Designer', async ({ page }) => {
    // The page is responsive, so hiding the row would take a working tool away from
    // exactly the person most likely to want it — an agent standing in the driveway.
    await seedProSession(page);
    await page.goto('/index.html');
    await page.click('.staging-menu__trigger');
    await expect(page.locator(NAV_ROW)).toBeVisible();
  });
});
