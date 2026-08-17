// The gallery is PC-only, in a real browser.
//
// public/scripts/gallery-gate.js reads the LAYOUT viewport, which is the one thing the
// unit test (test/frontend/gallery/gallery-gate-mobile.test.js) has to stub: it runs the
// gate's source against a fake matchMedia. What only a real browser can show is that the
// page actually delivers that viewport to it — <meta name="viewport"> is parsed above the
// script, so a phone reports its device width rather than the ~980px desktop fallback.
// Get that ordering wrong and the redirect never fires for anybody while every unit
// assertion stays green.
//
// Both halves are asserted, on the project each belongs to, so this can't pass by
// redirecting everyone or by redirecting no one.
import { test, expect } from '@playwright/test';
import { PRO_ME, seedProSession, stubAnalytics, hideStagingBanner, waitForHomeReady } from './fixtures.js';

const GALLERY_TAB = '.nav-center a[href="gallery.html"]';

/** A visitor with no session at all: no token, and /api/auth/me answers 401. */
async function signedOut(page) {
  await stubAnalytics(page);
  await hideStagingBanner(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }),
  );
}

test.describe('Gallery — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is the mobile half of the PC-only rule');

  test('a Pro user who opens the URL on a phone lands on the home page', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/gallery.html');

    await expect(page).toHaveURL(/\/(index\.html)?$/);
    // Really the home page, not a blank document that merely has the right URL.
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('.gal-main')).toHaveCount(0);
  });

  test('and the nav stops offering the tab at all', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await expect(page.locator(GALLERY_TAB)).toHaveCount(1);
    await expect(page.locator(GALLERY_TAB)).toBeHidden();
  });

  test('not even before the plan check — the pre-paint reveal must lose to this rule', async ({ page }) => {
    // session-class.js arms `html.has-session` from the stored token, and the rule that
    // shows the tab through `.hidden` has to carry !important AND more specificity to beat
    // `.hidden` — which makes it outrank `.desktop-only` too. The stylesheet re-hides it
    // below the breakpoint for exactly this case; without that, every signed-in phone
    // visitor is offered a tab whose page redirects them home the moment they tap it.
    await stubAnalytics(page);
    await hideStagingBanner(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('stagifyAuthToken', 'e2e-token'); } catch { /* private mode */ }
    });
    let release;
    const answered = new Promise((r) => { release = r; });
    await page.route('**/api/auth/me', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) });
    });

    await page.goto('/index.html');
    // The class really is armed — otherwise this passes for the wrong reason, on a page
    // where the pre-paint mechanism simply never ran.
    await expect(page.locator('html')).toHaveClass(/has-session/);
    await expect(page.locator(GALLERY_TAB)).toBeHidden();

    release();
    await expect(page.locator(GALLERY_TAB)).toBeHidden();
  });
});

test.describe('Gallery — signed out', () => {
  test.skip(({ isMobile }) => isMobile, 'the width rule already covers a phone; this is the auth rule');

  test('a visitor with no session is sent to the home page', async ({ page }) => {
    await signedOut(page);
    await page.goto('/gallery.html');

    await expect(page).toHaveURL(/\/(index\.html)?$/);
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('.gal-main')).toHaveCount(0);
  });

  test('and the tab stays hidden even after /api/auth/me has answered', async ({ page }) => {
    // The tab ships `hidden`, so "still hidden" could just mean the auth pass never
    // ran. Wait for the page to be live first, then assert — otherwise this passes on
    // a broken applyUserToUI() that never reveals it for anyone.
    await signedOut(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await expect(page.locator(GALLERY_TAB)).toHaveCount(1);
    await expect(page.locator(GALLERY_TAB)).toBeHidden();
  });
});

test.describe('Gallery tab — the nav pill follows it', () => {
  test.skip(({ isMobile }) => isMobile, 'the tab is desktop-only, so there is nothing to reveal');

  // The pill is positioned by MEASURED offsets, so revealing a tab after it has settled
  // leaves it pointing at where a link used to be. Two details decide whether a test of
  // this is real or theatre, and both were got wrong first time round:
  //
  //   WHICH LINK. .nav-center is `justify-content: flex-end`, so a tab appearing pushes
  //   the links BEFORE it leftwards and leaves the ones after it exactly where they
  //   were. Asserting on Guides (after the tab) can never fail. Home moves; measured at
  //   82px on a 1280px viewport.
  //
  //   WHEN THE TAB APPEARS. This used to seed a token and hold /api/auth/me past 'load',
  //   because a returning visitor's tab arrived a round trip after the pill had settled.
  //   session-class.js closed that window: a stored token now shows the tab before the
  //   first paint, so on that path there is nothing left to push aside and the assertion
  //   below could no longer fail — it would pass with the listener deleted.
  //
  //   Signing in DURING the session is the path that still reveals the tab late, and it
  //   always will: there is no token at paint time by definition. So that is what this
  //   drives — the same two calls auth-modal.js makes when a sign-in completes. Everything
  //   the test is actually about (measure, reveal, re-measure) is unchanged.
  //
  // `is-lit` alone would not catch any of it: the class lands on the right link, the
  // pill is simply drawn in the wrong place.
  test('the pill follows the links the tab pushes aside', async ({ page }) => {
    await stubAnalytics(page);
    await hideStagingBanner(page);
    // Deliberately NO token: a signed-out first paint is the only state in which the tab
    // can still arrive after the pill has settled.
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) }),
    );

    await page.goto('/index.html');
    await page.waitForLoadState('load');
    await page.waitForTimeout(200); // past nav-pill's own 60ms settle timer

    const home = page.locator('.nav-center a[href="index.html"].nav-link');
    await expect(home).toHaveClass(/is-lit/);
    await expect(page.locator(GALLERY_TAB)).toBeHidden();
    const before = await home.evaluate((el) => Math.round(el.getBoundingClientRect().left));

    // What a completed sign-in does: auth-modal.js stores the token, takes the user from
    // /api/auth/me, and calls applyUserToUI — which is what reveals the tab.
    await page.evaluate(() => {
      window.StagifyAuth.setToken('e2e-token');
      return window.StagifyAuth.fetchMe().then(() => window.StagifyAuth.applyUserToUI());
    });
    await expect(page.locator(GALLERY_TAB)).toBeVisible();

    // The reveal really did move the link this test is about — otherwise the assertion
    // below would hold no matter what the pill did.
    await expect
      .poll(() => home.evaluate((el) => Math.round(el.getBoundingClientRect().left)))
      .toBeLessThan(before - 20);

    // Poll the geometry: the pill glides to its resting place with a transition, so a
    // single read can catch it mid-flight.
    await expect
      .poll(async () => page.evaluate(() => {
        const pill = document.querySelector('.nav-pill');
        const link = document.querySelector('.nav-center a[href="index.html"].nav-link');
        if (!pill || !link) return null;
        const p = pill.getBoundingClientRect();
        const l = link.getBoundingClientRect();
        return Math.round(Math.abs(p.left + p.width / 2 - (l.left + l.width / 2)));
      }), { timeout: 5000 })
      .toBeLessThanOrEqual(2);
  });
});

test.describe('Gallery tab — no pop-in for a returning visitor', () => {
  test.skip(({ isMobile }) => isMobile, 'the tab is desktop-only; the phone half is above');

  // The regression: the tab could only be revealed once /api/auth/me answered, so a
  // signed-in visitor watched it appear in the middle of the nav a round trip after the
  // page had settled — and because .nav-center is flex-end, its arrival shoved Home and
  // Staging leftwards with it.
  //
  // Stalling the answer is what makes this provable: everything asserted here happens
  // while the request the page is waiting on is still open.

  test('the tab is already in the nav before /api/auth/me answers', async ({ page }) => {
    await stubAnalytics(page);
    await hideStagingBanner(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('stagifyAuthToken', 'e2e-token'); } catch { /* private mode */ }
    });

    let release;
    const answered = new Promise((r) => { release = r; });
    await page.route('**/api/auth/me', async (route) => {
      await answered;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) });
    });

    await page.goto('/index.html');
    await expect(page.locator(GALLERY_TAB)).toBeVisible();
    // Still the shipped markup underneath — the reveal is the stylesheet's, so the writer
    // has not run yet and this really is the pre-answer window.
    await expect(page.locator(GALLERY_TAB)).toHaveClass(/hidden/);

    release();
    await expect(page.locator(GALLERY_TAB)).not.toHaveClass(/hidden/);
    await expect(page.locator(GALLERY_TAB)).toBeVisible();
  });

  test('an EXPIRED token loses the tab again', async ({ page }) => {
    // The cost of a presence check: a dead token still arms the pre-paint class. When
    // /api/auth/me refuses it the tab has to go — and the class with it, or the stylesheet
    // keeps showing a tab the writer believes it has hidden.
    await stubAnalytics(page);
    await hideStagingBanner(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('stagifyAuthToken', 'stale-token'); } catch { /* private mode */ }
    });
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }),
    );

    await page.goto('/index.html');
    await waitForHomeReady(page);
    await expect(page.locator(GALLERY_TAB)).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/has-session/);
  });
});

test.describe('Gallery — desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop half: nothing may be redirected here');

  test('a Pro user reaches the gallery and the tab is offered', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await expect(page.locator('.nav-center a[href="gallery.html"]')).toBeVisible();

    await page.goto('/gallery.html');
    // Still on the gallery — the gate must not fire at a desktop width. The grid's own
    // state (ready / empty / off, depending on whether the object store is configured on
    // the test server) is gallery-app.js's business, not this gate's.
    await expect(page).toHaveURL(/\/gallery\.html$/);
    await expect(page.locator('.gal-main')).toBeVisible();
  });
});
