// Home page — load smoke. Drives the real /index.html (NOT auth-gated, so no
// seedProSession) in Chromium and asserts the page boots cleanly: no uncaught
// errors, the hero stats line renders, a custom select opens on click, and the
// before/after carousel controls exist. The two hero-stat count endpoints are
// mocked so the numbers are deterministic; everything else is the real app.
import { test, expect } from '@playwright/test';
import { stubAnalytics } from './fixtures.js';

test.describe('Home page — load smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Same staging-banner neutralisation as fixtures.seedProSession (the
    // IS_STAGING banner is a max-z-index sticky bar that overlays the page and
    // intercepts pointer events) — without the auth seeding, which index.html
    // doesn't need.
    await page.addInitScript(() => {
      try {
        const s = document.createElement('style');
        s.textContent = '#stagify-staging-banner{display:none !important}';
        document.documentElement.appendChild(s);
      } catch { /* ignore */ }
    });

    // Keep the Google Ads tag (gtag.js) from making real external calls.
    await stubAnalytics(page);

    await page.route('**/api/prompt-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ promptCount: 1234 }) }),
    );
    await page.route('**/api/contact-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ usersServed: 567 }) }),
    );
  });

  test('loads cleanly with hero stats, working custom select, and before/after controls', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/index.html');

    // Hero stats line renders (stat pills are populated from the mocked counts).
    await expect(page.locator('#hero-stats')).toBeVisible();
    await expect(page.locator('.stat-pill-number[data-stat="roomsStaged"]')).toBeAttached();
    await expect(page.locator('.stat-pill-number[data-stat="usersServed"]')).toBeAttached();

    // Before/After toggle and version-carousel arrows exist. They live inside
    // the (initially hidden) image viewer, so assert presence, not visibility.
    await expect(page.locator('#toggle-before')).toBeAttached();
    await expect(page.locator('#toggle-after')).toBeAttached();
    await expect(page.locator('#carousel-prev')).toBeAttached();
    await expect(page.locator('#carousel-next')).toBeAttached();

    // Custom select opens on click. The stage modal starts hidden (and opening
    // it through the UI requires sign-in), so lift the .hidden class exactly
    // like the app's own openModal() does, then drive the real select wiring.
    await page.evaluate(() => {
      const modal = document.getElementById('stage-modal');
      if (modal) modal.classList.remove('hidden');
    });
    const roomSelect = page.locator('#room-type-select');
    await expect(roomSelect).toBeVisible();
    const menu = roomSelect.locator('.select-menu');
    await expect(menu).toHaveClass(/hidden/);
    await roomSelect.locator('.select-trigger').click();
    await expect(menu).not.toHaveClass(/hidden/);

    // No uncaught exceptions; no console errors beyond resource-load noise
    // (e.g. an aborted media fetch logs "Failed to load resource").
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((t) => !/Failed to load resource/i.test(t))).toEqual([]);
  });

  test('the hero picker adopts the static LCP photo instead of re-creating it', async ({ page }) => {
    // The homepage's LCP element is the `<img>` in `.hp-stage`, and it ships in index.html
    // so it can paint without waiting for the module graph. hero-picker.js must therefore
    // APPEND the other renders around it — replacing the node, even with an identical src,
    // restarts the browser's LCP candidate at the later time and silently undoes the
    // optimisation while looking perfect.
    //
    // This lives in e2e and not in a unit test on purpose: the failure mode is an
    // unreachable code path, and a source scan cannot see reachability. Stubbing the
    // adopt branch to `null` leaves every greppable string intact in dead code — that
    // mutant survived a source-scanning test. In a real browser it cannot: an
    // unreachable branch never sets the attribute.
    await page.goto('/index.html');

    const stage = page.locator('.hp-stage');
    await expect(
      stage,
      'hero-picker.js did not take the adopt path — the static photo was overwritten'
    ).toHaveAttribute('data-hp-adopted', '');

    // The first paint costs exactly one image: the default pair. The empty "before" shot
    // and the other 35 renders are fetched on demand, so anything more here means the
    // hero has started paying for images nobody asked to see.
    const photo = stage.locator('img').first();
    await expect(photo).toHaveAttribute('src', 'media-webp/example/modern-bedroom.webp');
    await expect(photo).toHaveClass(/is-on/);
  });

  test('picking a style swaps the photo and rewrites the sentence', async ({ page }) => {
    // The whole point of the hero: the headline is a control, not a slogan. If the menu
    // opens but the photo never changes, the page still looks finished.
    await page.goto('/index.html');

    await expect(page.locator('#hero-style-label')).toHaveText('Modern');
    await page.locator('#hero-style-btn').click();

    const menu = page.locator('#hero-style-menu');
    await expect(menu).toBeVisible();
    await menu.locator('.hp-menu__item', { hasText: 'Coastal' }).click();

    await expect(menu).toBeHidden();
    await expect(page.locator('#hero-style-label')).toHaveText('Coastal');

    // The new render is added and shown; the default one is still in the DOM but hidden,
    // because it is the adopted LCP node and must never be removed.
    const shown = page.locator('.hp-stage img.is-on');
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute('src', 'media-webp/example/coastal-bedroom.webp');
    await expect(page.locator('.hp-stage img[src*="modern-bedroom"]')).toHaveCount(1);
  });

  test('the hero picker reopens on the last pick, and forgets one it no longer offers', async ({ page }) => {
    // Remembering the pick is the one hero behaviour that spans two page loads, so a
    // single-load test cannot see it at all. It is also the behaviour that quietly
    // undoes the LCP work for returning visitors, which is a reason to be sure it is
    // doing something real rather than a reason to leave it unguarded.
    await page.goto('/index.html');

    await page.locator('#hero-style-btn').click();
    await page.locator('#hero-style-menu .hp-menu__item', { hasText: 'Farmhouse' }).click();
    await page.locator('#hero-room-btn').click();
    await page.locator('#hero-room-menu .hp-menu__item', { hasText: 'Kitchen' }).click();

    await page.reload();

    await expect(page.locator('#hero-style-label')).toHaveText('Farmhouse');
    await expect(page.locator('#hero-room-label')).toHaveText('kitchen');
    await expect(page.locator('.hp-stage img.is-on')).toHaveAttribute(
      'src',
      'media-webp/example/farmhouse-kitchen.webp',
    );

    // The adopted LCP node survives the restore. show() hides it, it does not remove it,
    // and removing it would break the adopt guarantee the test above pins.
    await expect(page.locator('.hp-stage')).toHaveAttribute('data-hp-adopted', '');
    await expect(page.locator('.hp-stage img[src*="modern-bedroom"]')).toHaveCount(1);

    // A pick naming a room or style that no longer exists must fall back to the default,
    // not build a path to a render that was never generated. That is what happens the day
    // someone drops a room type from ROOMS, and the failure mode is an empty hero for
    // exactly the returning visitors this feature exists to please.
    await page.evaluate(() => window.localStorage.setItem('heroPick', 'farmhouse|conservatory'));
    await page.reload();

    await expect(page.locator('#hero-room-label')).toHaveText('bedroom');
    await expect(page.locator('#hero-style-label')).toHaveText('Modern');
    await expect(page.locator('.hp-stage img.is-on')).toHaveAttribute(
      'src',
      'media-webp/example/modern-bedroom.webp',
    );
  });

  test('the deferred Google Ads tag still initializes', async ({ page }) => {
    // scripts/gtag.js is `defer` so it stops blocking the parser ahead of every
    // stylesheet. The risk of that change is silent: the tag would simply stop
    // setting up, and nobody would notice until conversions dried up. So assert the
    // two things the tag actually has to leave behind — a callable `gtag` and the
    // config queued on dataLayer. Neither depends on the external loader, which
    // stubAnalytics aborts.
    await page.goto('/');
    await expect(page.locator('#room-type-select')).toBeAttached();

    const state = await page.evaluate(() => ({
      gtagType: typeof window.gtag,
      configured: window.__gtagConfigured === true,
      entries: (window.dataLayer || []).map((args) => Array.from(args).join(':')),
    }));

    expect(state.gtagType).toBe('function');
    expect(state.configured).toBe(true);
    expect(state.entries.some((e) => e.startsWith('js:'))).toBe(true);
    expect(state.entries.some((e) => e === 'config:AW-18274233484')).toBe(true);
  });
});
