// Home page — the "See it for yourself" studio showcase, on a phone.
//
// THE BUG THIS PINS. The walkthrough player positions its callout card in frame
// pixels and clamps it inside the frame, which is `overflow: hidden`. On a phone
// the frame is ~323px wide and, at these demos' recorded ratios, only 161-199px
// tall — while the longest step is 228 characters, which at any legible type size
// is a taller card than the box it has to fit in. `clamp(v, lo, hi)` then got an
// inverted range (`hi < lo`), silently returned `lo`, and the frame clipped the
// bottom of the card — taking the footer with it. That footer is `Back`, the
// `N / M` counter and `Next`, and since tapping the frame still advances, the
// walkthrough became silently FORWARD-ONLY across 15-17 steps with nothing on
// screen to say where you were. Measured before the fix: 37px of the footer
// outside the frame on the AI Designer demo, 34px on Masking.
//
// The fix hands the card to the CSS as a bottom sheet once it cannot fit, so the
// footer is pinned and the text scrolls instead. This spec walks EVERY step of
// every homepage walkthrough and asserts the footer stayed inside the frame — it
// does not assert which presentation was used, because that is a threshold that
// may legitimately move with the type size or a re-recording.
//
// Why e2e and not test/frontend/: demo-player.js is a classic script (it is in
// BLOCKED_CLASSIC in test/frontend/untested-frontend-modules.test.js), there is no
// jsdom in this repo, and the whole defect is layout — offsetHeight against a
// clipped box. Nothing below a real browser can see it.
import { test, expect } from '@playwright/test';
import { stubAnalytics, hideStagingBanner } from './fixtures.js';

// Desktop has room for the card on every step, so the sheet never engages and there
// is nothing here to assert. The mobile-chrome project (Pixel 5, 393px, hasTouch) is
// the one that reproduces it.
test.describe('Home showcase — walkthrough callout fits its frame', () => {
  test.skip(({ isMobile }) => !isMobile, 'the card only overflows at phone width');

  test.beforeEach(async ({ page }) => {
    await hideStagingBanner(page);
    await stubAnalytics(page);
    await page.route('**/api/prompt-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ promptCount: 1234 }) }),
    );
    await page.route('**/api/contact-count', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ usersServed: 567 }) }),
    );
  });

  test('every step keeps Back / the counter / Next inside the frame', async ({ page }) => {
    await page.goto('/index.html');

    // The carousel upgrades itself late (index-deferred.js runs after `load`), and
    // only the FRONT panel ever mounts a player.
    await expect(page.locator('[data-showcase].shw--ready')).toBeAttached({ timeout: 30000 });

    const front = page.locator('.shw__panel[data-shw-state="front"]');
    // Below 900px the inactive tabs are display:none — the ‹/› stepper is the control.
    const next = page.locator('[data-shw-arrow="1"]');
    await expect(next).toBeVisible();

    const visited = new Set();
    let checked = 0;

    // Five panels, three of which mount a walkthrough; the other two (the exterior
    // before/after and the gallery mock) are skipped by the `steps` probe below.
    for (let panel = 0; panel < 5; panel += 1) {
      const id = await front.getAttribute('id');
      if (!id || visited.has(id)) break;
      visited.add(id);

      const host = front.locator('.designer-demo[data-demo]');
      if (await host.count()) {
        // Wait for the player to mount rather than for a timeout: the deferred
        // scripts land in no guaranteed order and designer-demo.js polls for them.
        await page.waitForFunction(
          () => {
            const h = document.querySelector('.shw__panel[data-shw-state="front"] .designer-demo');
            return !!(h && h.__player && h.querySelector('.sdp__foot'));
          },
          null,
          { timeout: 30000 },
        );

        const total = await page.evaluate(() => {
          const h = document.querySelector('.shw__panel[data-shw-state="front"] .designer-demo');
          return h.__player.steps.length;
        });
        expect(total, `${id} has steps`).toBeGreaterThan(1);

        for (let step = 0; step < total; step += 1) {
          const box = await page.evaluate(() => {
            const h = document.querySelector('.shw__panel[data-shw-state="front"] .designer-demo');
            const f = h.querySelector('.sdp__frame').getBoundingClientRect();
            const t = h.querySelector('.sdp__foot').getBoundingClientRect();
            return {
              step: h.__player.i + 1,
              below: Math.round(t.bottom - f.bottom),
              above: Math.round(f.top - t.top),
              width: Math.round(t.width),
            };
          });

          // The whole footer row, not just its buttons: if this is inside the frame
          // then Back, the counter and Next are all reachable and readable.
          expect(box.below, `${id} step ${box.step}: footer below the frame`).toBeLessThanOrEqual(0);
          expect(box.above, `${id} step ${box.step}: footer above the frame`).toBeLessThanOrEqual(0);
          expect(box.width, `${id} step ${box.step}: footer has width`).toBeGreaterThan(0);
          checked += 1;

          // Advance through the player's own API rather than tapping the frame: a tap
          // lands on whatever is under it, and this spec is about geometry, not the
          // click target (e2e/guides-walkthrough.spec.js drives the real taps).
          await page.evaluate(() => {
            const h = document.querySelector('.shw__panel[data-shw-state="front"] .designer-demo');
            h.__player.advance();
          });
          await page.waitForTimeout(150);
        }
      }

      await next.click();
      await page.waitForTimeout(900);
    }

    // Guards the loop itself: a stepper that stopped working would otherwise make
    // this pass having asserted nothing.
    expect(checked, 'steps actually walked').toBeGreaterThan(40);
    expect(visited.size, 'panels actually visited').toBe(5);
  });
});
