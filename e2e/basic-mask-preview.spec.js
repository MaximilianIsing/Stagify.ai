// The Basic Mask preview page, in a real browser.
//
// This page is the newest of the four public previews and the odd one out: it has no tool
// on it. Basic Mask opens as a panel inside the staging flow on the home page, so the
// Stagify+ view here is a way IN — an "Open Basic Mask" button — rather than the studio
// embedded. That means the thing to prove is a SWAP, and the two halves of it fail
// independently: a subscriber shown the sales button is being asked to buy what they own,
// and a free account shown the open button is handed a door that 403s behind it.
//
// Everything else here is the property the whole preview pattern rests on and that no unit
// test can establish: that the page really renders for a visitor with no token. A unit test
// cannot prove the absence of a redirect — it can only prove that the module it imported
// did not fire one. Only a real navigation shows that nothing else on the page did either.
// So the load-bearing assertions are NEGATIVES, and each is paired with its positive.
import { test, expect } from '@playwright/test';
import { PRO_ME, seedProSession, seedFreeSession, stubAnalytics, hideStagingBanner } from './fixtures.js';

const URL = '/basic-mask.html';

// There is deliberately NO pitch region on this page, which is why there is no locator for
// one. The other three previews hide a block of sales copy from a subscriber; here the
// whole page is that copy — it explains a tool that lives somewhere else — so nothing is
// taken away and only the button swaps. preview-access.test.js records the same thing by
// binding this page with `pitch: null`. A `#bm-pitch` selector used to be asserted here and
// matched nothing: hidden-for-Pro passed vacuously, and visible-for-anonymous was the only
// reason anyone noticed.
const BOARD = '.bm-board';          // what the tool does — shown to everyone
const UPGRADE = '#bm-hero-actions'; // "Get Stagify+ to use it"
const OPEN = '#bm-tool';            // "Open Basic Mask"

/** A visitor with no session at all: no token, and /api/auth/me answers 401. */
async function signedOut(page) {
  await stubAnalytics(page);
  await hideStagingBanner(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }));
}

test.describe('Basic Mask preview — the public view', () => {
  test('an anonymous visitor gets the real page, NOT a redirect to the pricing table', async ({ page }) => {
    await signedOut(page);
    await page.goto(URL);

    await expect(page).toHaveURL(/basic-mask\.html$/);
    // Paired positive: the URL surviving proves nothing on its own — a blank document has
    // the right URL too.
    await expect(page.locator('.bm-intro__title')).toBeVisible();
    await expect(page.locator(BOARD)).toBeVisible();
    await expect(page.locator('.site-header')).toBeVisible();
  });

  test('the upgrade button sells, and the open button is present but hidden', async ({ page }) => {
    await signedOut(page);
    await page.goto(URL);

    await expect(page.locator(UPGRADE)).toBeVisible();
    await expect(page.locator('#bm-cta')).toHaveAttribute('href', 'stagify-plus.html');

    // Present-but-hidden, not absent: `toBeHidden` passes just as happily on an element
    // that was never rendered, which would make this meaningless the day someone deletes it.
    await expect(page.locator(OPEN)).toHaveCount(1);
    await expect(page.locator(OPEN)).toBeHidden();
  });

  test('the page is indexable — no noindex, a canonical of its own, and one h1', async ({ page }) => {
    // The SEO half of the whole arrangement. Without this the page could quietly stop being
    // worth having and only the ranking would notice, months later.
    await signedOut(page);
    await page.goto(URL);

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index, follow/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://stagify.ai/basic-mask.html');
    await expect(page.locator('link[rel="alternate"][hreflang="de"]')).toHaveAttribute('href', 'https://stagify.ai/de/basic-mask.html');
    await expect(page.locator('h1')).toHaveCount(1);
  });
});

test.describe('Basic Mask preview — signed-in free account', () => {
  test('gets the same page as an anonymous visitor, with NOTHING covering it', async ({ page }) => {
    // Signing up must not change this page. On the Masking Studio it used to: creating an
    // account swapped the tool for a full-screen, undismissable dialog about not having
    // paid. The browser is where that has to be checked — such an overlay is `position:
    // fixed` over the viewport, so the page underneath stays "visible" to any DOM assertion
    // while being completely unreadable on screen.
    await seedFreeSession(page);
    await page.goto(URL);

    await expect(page.locator(BOARD)).toBeVisible();
    await expect(page.locator(UPGRADE)).toBeVisible();
    await expect(page.locator(OPEN)).toBeHidden();

    const box = await page.locator('.bm-intro__title').boundingBox();
    const covered = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? !el.closest('.bm-intro') : true;
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(covered, 'something is painted over the Basic Mask pitch').toBe(false);
  });
});

test.describe('Basic Mask preview — Stagify+', () => {
  test.beforeEach(async ({ page }) => { await seedProSession(page); });

  test('the two buttons swap, and the board stays', async ({ page }) => {
    await page.goto(URL);

    await expect(page.locator(OPEN)).toBeVisible();
    await expect(page.locator('#bm-open')).toHaveAttribute('href', 'index.html#basic-mask');
    // The sales button goes: someone who already bought it does not need selling. It is the
    // ONLY thing that goes, which is what makes this page the odd one out.
    await expect(page.locator(UPGRADE)).toBeHidden();
    // NOT the feature board, and not the intro above it. They describe what the tool does
    // and are worth reading whether or not you have paid — taking them away would leave the
    // page saying nothing at all to the person who owns the tool.
    await expect(page.locator(BOARD)).toBeVisible();
    await expect(page.locator('.bm-intro__sub')).toBeVisible();
  });

  test('the sales button is NEVER flashed at a subscriber, however slow the plan check', async ({ page }) => {
    // The regression the pre-paint gate exists for: the markup ships in the anonymous
    // shape, so without it a Stagify+ visitor sees "Get Stagify+ to use it" for as long as
    // /api/auth/me takes to answer. Brief on a fast connection, very much not brief on a
    // slow one. Held the only way it can be: stall the answer, so the whole in-flight
    // window is open for inspection.
    let release;
    const answered = new Promise((r) => { release = r; });
    await page.route('**/api/auth/me', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) });
    });

    await page.goto(URL);
    await expect(page.locator('.bm-intro__title')).toBeVisible();
    await expect(page.locator(UPGRADE)).toBeHidden();
    // Paired positive, and the reason this is not just "hide everything and hope": the open
    // button is up and usable during the same window, not merely the sales button suppressed.
    await expect(page.locator(OPEN)).toBeVisible();

    release();
    await expect(page.locator(OPEN)).toBeVisible();
    await expect(page.locator(UPGRADE)).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/bm-pro-pending/);
  });

  test('a cached Stagify+ plan that is no longer true is CORRECTED, not honoured', async ({ page }) => {
    // The accepted cost of pre-painting from a cache: somebody who cancelled still has
    // `stagifyPlan: 'pro'` in storage, so they get the open button until /api/auth/me
    // answers. Cosmetic — the render route refuses them either way — but the correction has
    // to actually arrive, and it is the one path where the guess is WRONG.
    await seedFreeSession(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('stagifyPlan', 'pro'); } catch { /* ignore */ }
    });
    await page.goto(URL);

    await expect(page.locator(UPGRADE)).toBeVisible();
    await expect(page.locator(OPEN)).toBeHidden();
    // The class has to come off too. Left on, the CSS override outranks the `hidden`
    // attribute and the wrong button stays on screen whatever the writer sets.
    await expect(page.locator('html')).not.toHaveClass(/bm-pro-pending/);
  });
});

test.describe('Basic Mask preview — the nav row', () => {
  test('a locked row opens the PITCH, not the tool and not the pricing page', async ({ page }) => {
    // The row's own href is `index.html#basic-mask`, which opens the tool panel in the
    // staging flow — right for a subscriber, wrong for everyone else. It therefore names
    // its preview page separately, and staging-menu.js prefers that while the row is
    // locked. Both wrong answers are asserted against: the pricing table (what every other
    // locked row does) and the tool itself (what the href would do).
    await signedOut(page);
    await page.goto('/index.html');
    await page.click('.staging-menu__trigger');

    const row = page.locator('.staging-menu__panel a[href="index.html#basic-mask"]');
    await expect(row).toHaveClass(/is-locked/);
    await row.click();

    await expect(page).toHaveURL(/basic-mask\.html$/);
    await expect(page.locator(BOARD)).toBeVisible();
  });

  test('a Stagify+ visitor still gets the tool from the same row', async ({ page }) => {
    // The paired positive: the override above must apply ONLY while the row is locked, or
    // the preview page becomes a detour for the people who paid to skip it.
    await seedProSession(page);
    await page.goto('/index.html');
    await page.click('.staging-menu__trigger');

    const row = page.locator('.staging-menu__panel a[href="index.html#basic-mask"]');
    await expect(row).not.toHaveClass(/is-locked/);
    await row.click();
    await expect(page).toHaveURL(/index\.html(#basic-mask)?$/);
  });
});
