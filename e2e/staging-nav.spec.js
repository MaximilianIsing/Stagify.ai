// The top nav's "Staging" dropdown, in a real browser.
//
// It replaced two bare links that were hidden from free users, so the two things
// worth proving here are the ones a DOM-stubbed unit test cannot:
//
//   - a free user SEES all four tools and can only use one of them. The lock is
//     now presentational (a class + aria-disabled), so this drives the click and
//     checks where the browser actually ends up;
//   - "Image Staging" and "Basic Mask" open the home page's screens both in place
//     (window hook) and after a navigation (URL fragment) — two different code
//     paths to the same dialog, and only one of them is exercised if you always
//     start on the home page.
//
// Every /api/* call is mocked (see fixtures.js) — no model calls, no cost.

import { test, expect } from '@playwright/test';
import { seedProSession, seedFreeSession, waitForHomeReady } from './fixtures.js';

const MENU = '[data-staging-menu]';
const TRIGGER = '.staging-menu__trigger';
const ITEM = '.staging-menu__item';

/** Open the dropdown the way a user does, and hand back its rows. */
async function openMenu(page) {
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU)).toHaveAttribute('data-open', '');
  return page.locator(`${MENU} ${ITEM}`);
}

test.describe('Staging dropdown — desktop', () => {
  // These pin the DESKTOP shape of the menu — all four rows visible, and the sliding
  // nav pill, which only exists on a pointer device. The phone shape is a different
  // thing, not a weaker one: it has its own describe at the end of this file, where
  // three rows show and the PC-only AI Designer row does not.
  // (This used to say the whole menu was `desktop-only`. That was true until
  // 2026-08-01 and left a phone with no nav path to any staging tool at all.)
  test.skip(({ isMobile }) => isMobile, 'asserts the desktop layout; the phone half is below');

  test('lists the four tools in order and opens on click', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    // Closed until asked: the panel is pointer-inert without [data-open].
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');

    const items = await openMenu(page);
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('Image Staging');
    await expect(items.nth(1)).toContainText('Basic Mask');
    await expect(items.nth(2)).toContainText('AI Designer');
    await expect(items.nth(3)).toContainText('Masking Studio');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape and an outside click both close it', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');

    await openMenu(page);
    await page.locator('.brand').click({ trial: true });
    await page.mouse.click(5, 400); // well away from the nav
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
  });

  // The sliding pill lends itself to the trigger while the menu is open, then
  // goes back. Regression: nav-pill.js locks `active` to any clicked link so the
  // pill survives a slow navigation — but the trigger does not navigate, so that
  // lock stranded the pill on "Staging" for the rest of the page's life.
  // `.is-lit` is the class moveTo() puts on whatever the pill is currently under.
  test('the pill returns to the current page when the menu closes', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const home = page.locator('.nav-center .nav-link', { hasText: 'Home' });
    const trigger = page.locator(TRIGGER);
    await expect(home).toHaveClass(/is-lit/);

    await openMenu(page);
    await expect(trigger).toHaveClass(/is-lit/, { timeout: 5000 });
    await expect(home).not.toHaveClass(/is-lit/);

    // Dismiss by clicking away — the path that had no click on the trigger at
    // all, so nothing else would have prompted a re-settle.
    await page.mouse.click(5, 400);
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(home).toHaveClass(/is-lit/);
    await expect(trigger).not.toHaveClass(/is-lit/);
  });

  test('the pill returns after the menu is dismissed with Escape', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const home = page.locator('.nav-center .nav-link', { hasText: 'Home' });
    await openMenu(page);
    await expect(page.locator(TRIGGER)).toHaveClass(/is-lit/, { timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(home).toHaveClass(/is-lit/);
  });

  test('the pill rests on Staging while on one of its own pages', async ({ page }) => {
    // The other half: the trigger stands for the pages its rows link to, so the
    // pill should sit on it on ai-designer.html — that is what the two links it
    // replaced used to do for themselves.
    await seedProSession(page);
    await page.goto('/ai-designer.html');
    await expect(page.locator(TRIGGER)).toHaveClass(/is-lit/, { timeout: 5000 });
  });

  test('a Pro user gets all four unlocked', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    for (let i = 0; i < 4; i += 1) {
      await expect(items.nth(i)).not.toHaveClass(/is-locked/);
      // The chip is what carries "this is Stagify+" into the a11y tree, so an
      // unlocked row must not still be announcing it. Asserted as visibility,
      // not text: the chip is display:none rather than absent, and textContent
      // (what toContainText reads) includes hidden descendants.
      await expect(items.nth(i).locator('.staging-menu__badge')).toBeHidden();
    }
  });

  test('Image Staging opens the stage dialog in place on the home page', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const modal = page.locator('#stage-modal');
    await expect(modal).toHaveClass(/hidden/);

    const items = await openMenu(page);
    await items.nth(0).click();

    await expect(modal).not.toHaveClass(/hidden/);
    // Opened in place: the hook ran instead of the href, so no fragment is left
    // behind to reopen the dialog on the next refresh.
    expect(new URL(page.url()).hash).toBe('');
  });

  test('Image Staging from another page navigates home and opens the dialog', async ({ page }) => {
    // The other half of the entry: off the home page the hooks do not exist, so
    // the row is a plain link and app/staging-entry.js consumes the fragment.
    await seedProSession(page);
    await page.goto('/guides.html');

    const items = await openMenu(page);
    await items.nth(0).click();

    await page.waitForURL(/\/(index\.html)?(\?.*)?$/);
    await expect(page.locator('#stage-modal')).not.toHaveClass(/hidden/);
    expect(new URL(page.url()).hash).toBe('', 'the fragment is consumed, not left in the URL');
  });

  test('Basic Mask opens the mask editor standalone, with its own uploader', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const maskModal = page.locator('#stage-mask-modal');
    await expect(maskModal).not.toHaveClass(/active/);

    const items = await openMenu(page);
    await items.nth(1).click();

    await expect(maskModal).toHaveClass(/active/);
    // Standalone: no staging job behind it, so the dialog shows the dropzone
    // rather than a canvas of an image it does not have.
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
    await expect(page.locator('.stage-mask-canvas-container')).toBeHidden();
    await expect(page.locator('#stage-mask-modal .stage-mask-title')).toContainText('Basic Mask');
    // Reached without ever opening the staging flow.
    await expect(page.locator('#stage-modal')).toHaveClass(/hidden/);
  });

  test('a free user sees all four but only Image Staging is live', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    await expect(items).toHaveCount(4, 'the studios stay visible — that is the upsell');
    await expect(items.nth(0)).not.toHaveClass(/is-locked/);
    for (const i of [1, 2, 3]) {
      await expect(items.nth(i)).toHaveClass(/is-locked/);
      // A locked row stays an operable link (it goes to Stagify+), so the state
      // is announced by the visible chip rather than by aria-disabled.
      await expect(items.nth(i).locator('.staging-menu__badge')).toBeVisible();
      await expect(items.nth(i).locator('.staging-menu__lock')).toBeVisible();
    }
  });

  test('a free user clicking a locked tool lands on Stagify+', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    await items.nth(1).click(); // Basic Mask

    await page.waitForURL(/stagify-plus\.html/);
    // And emphatically NOT into the tool.
    await expect(page.locator('#stage-mask-modal')).toHaveCount(0);
  });

  test('a free user typing the Basic Mask URL is still turned away', async ({ page }) => {
    // The locked row is presentation, not a gate — the fragment is typeable and
    // survives a middle-click, so the entry re-checks the plan itself.
    await seedFreeSession(page);
    await page.goto('/index.html#basic-mask');
    await page.waitForURL(/stagify-plus\.html/);
  });

  test('a Pro user typing the Basic Mask URL gets the editor', async ({ page }) => {
    // The mirror of the test above — without it, "always redirect" would pass.
    await seedProSession(page);
    await page.goto('/index.html#basic-mask');
    await expect(page.locator('#stage-mask-modal')).toHaveClass(/active/);
    await expect(page.locator('#stage-mask-upload')).toBeVisible();
  });
});

test.describe('Staging dropdown — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is the mobile half of the nav');

  // The dropdown is the ONLY nav entry to Image Staging, Basic Mask, the AI Designer
  // and the Masking Studio. It used to be `desktop-only`, so a phone had no nav path
  // to any staging tool at all — including the two features Stagify+ is sold on, for
  // someone already paying. These two tests are why it can be shown again.

  test('a paying user can reach every phone-capable staging tool', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await expect(page.locator(TRIGGER)).toBeVisible();
    const items = await openMenu(page);
    // All four rows stay in the DOM — one of them is hidden by CSS, not dropped, so
    // the markup is identical on every page and at every width.
    await expect(items).toHaveCount(4);
    for (const name of ['Image Staging', 'Basic Mask', 'Masking Studio']) {
      await expect(page.locator(ITEM).filter({ hasText: name })).toBeVisible();
    }

    // The AI Designer is the exception, and deliberately: it is a PC-only tool whose
    // page bounces a phone-sized viewport home before it paints (see
    // e2e/ai-designer.spec.js's "AI Designer — phone"). Offering the row here would
    // advertise a tool that answers a tap by undoing it. Asserted by href rather than
    // by label, so a translated build fails for a real reason and not this one.
    await expect(page.locator(`${ITEM}[href="ai-designer.html"]`)).toHaveCount(1);
    await expect(page.locator(`${ITEM}[href="ai-designer.html"]`)).toBeHidden();
  });

  test('the hidden AI Designer row is out of the keyboard rotation', async ({ page }) => {
    // A `display:none` row cannot take focus, so leaving it in the ArrowDown cycle
    // makes one keypress look dead instead of moving on to the Masking Studio. This
    // is reachable on a phone-sized viewport with a hardware keyboard attached.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    // Opened FROM THE KEYBOARD, which is the only way the menu now moves focus into
    // the panel on open — a tap must not, because focus() asks a phone to scroll a
    // sticky-header element into view. Enter on a focused button reports detail 0,
    // which is what staging-menu.js keys off.
    await page.locator(TRIGGER).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(MENU)).toHaveAttribute('data-open', '');
    await expect(page.locator(ITEM).first()).toBeFocused();

    await page.keyboard.press('ArrowDown'); // Image Staging -> Basic Mask
    await page.keyboard.press('ArrowDown'); // -> Masking Studio, NOT the hidden row
    await expect(page.locator(`${ITEM}[href="masking-studio.html"]`)).toBeFocused();
  });

  test('a TAP does not pull focus into the panel', async ({ page }) => {
    // The other half of the gate above, and the reason it exists. On a phone,
    // focus() on a row inside the position:sticky header asks the browser to scroll
    // it into view, and it arms `.staging-menu__item:focus-visible .staging-menu__tip`
    // — a dark tooltip painted over the rows below its own. A tap wants neither.
    //
    // page.tap() is a real touch on this project (Pixel 5, hasTouch), so this is the
    // gesture the fix is about rather than a mouse click standing in for one.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await page.tap(TRIGGER);
    await expect(page.locator(MENU)).toHaveAttribute('data-open', '');
    await expect(page.locator(ITEM).first()).not.toBeFocused();

    // Still fully operable by keyboard afterwards: with focus outside the rows,
    // ArrowDown enters at the top rather than doing nothing.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(ITEM).first()).toBeFocused();
  });

  test('the open panel is anchored to the clipping box, so it can never be cut off', async ({ page }) => {
    // The reason the menu was hidden on phones: .nav-center clips the X axis, and a
    // panel anchored to its own trigger is a fixed 224px centred on that trigger —
    // so wherever the wrapping nav happens to put the trigger, the panel can run past
    // the clip and lose a row.
    //
    // Asserting only "the panel is on screen" is NOT enough: at this particular
    // viewport the trigger lands near the middle and 224px fits anyway, so that
    // assertion passes with the fix reverted. What the fix actually guarantees is
    // that the panel is POSITIONED IN .nav-center — the very box doing the clipping —
    // and never wider than it, leaving nothing to clip at ANY trigger position or
    // viewport width. Pin both halves; neither alone is the property.
    //
    // It is deliberately no longer stretched to fill that box: spanning the whole
    // phone for four rows is what this test used to require, so the width assertion
    // below is upper AND lower bounded.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await openMenu(page);

    // Compare LAYOUT geometry (offsetWidth/clientWidth), not boundingBox(): the panel
    // animates in with a scale(.98)→scale(1) transition, and a transformed bounding
    // box is a few px narrower until it settles — which is measurement noise, not the
    // property under test. offsetWidth ignores transforms entirely.
    const geom = await page.evaluate(() => {
      const panel = document.querySelector('.staging-menu__panel');
      const clip = document.querySelector('.nav-center');
      return {
        panelWidth: panel.offsetWidth,
        clipWidth: clip.clientWidth,
        offsetLeft: panel.offsetLeft,
        // Same offsetParent as the panel below 768px (the wrapper is static there),
        // so these two are directly comparable without touching bounding boxes.
        triggerLeft: panel.parentElement.querySelector('.staging-menu__trigger').offsetLeft,
        triggerWidth: panel.parentElement.querySelector('.staging-menu__trigger').offsetWidth,
        // offsetLeft is measured from offsetParent's padding edge, and clientWidth IS
        // the padding box — so these three compose only while offsetParent is the clip
        // box. Assert that identity rather than assume it: put `position:relative` back
        // on the wrapper and offsetLeft silently starts meaning "from the trigger",
        // which reads as a comfortably-inset panel no matter where the panel really is.
        anchoredToClipBox: panel.offsetParent === clip,
      };
    });

    expect(geom.anchoredToClipBox).toBe(true);
    expect(geom.clipWidth).toBeGreaterThan(240);
    // Never wider than the box that clips it, and wholly inside it.
    expect(geom.panelWidth).toBeLessThanOrEqual(geom.clipWidth);
    expect(geom.offsetLeft).toBeGreaterThanOrEqual(0);
    expect(geom.offsetLeft + geom.panelWidth).toBeLessThanOrEqual(geom.clipWidth);
    // ...but not full-bleed: content width, with real margin either side.
    expect(geom.panelWidth).toBeLessThan(geom.clipWidth - 40);
    expect(geom.offsetLeft).toBeGreaterThan(0);

    // And it points at "Staging" rather than at the middle of the nav. Spanning the
    // clip box cleared the clipping but left the panel visibly adrift from its own
    // trigger; staging-menu.js re-aims it on open, clamped to the two bounds above.
    //
    // Assert the clamped aim, not bare centre-to-centre. The panel is 224px and the
    // trigger is ~77px, so centring it only fits while the trigger sits far enough from
    // either edge — and the nav row puts the trigger second of five items, close to the
    // left. At this viewport centring wants a -1.5px offset, i.e. outside the box, so
    // staging-menu.js correctly clamps to GAP and the two midpoints land ~9px apart.
    // Recompute that same clamp here: where centring fits this reduces to the old
    // exact-centre assertion, and a panel that ignored its trigger (the pre-fix
    // behaviour: `margin-inline: auto auto`, centred in the clip box at offsetLeft 72)
    // still fails it.
    const GAP = 8; // staging-menu.js's own bound
    const wantedShift = geom.triggerLeft + (geom.triggerWidth - geom.panelWidth) / 2;
    const room = geom.clipWidth - geom.panelWidth;
    const aimedLeft = Math.min(Math.max(wantedShift, GAP), room - GAP);
    expect(Math.abs(geom.offsetLeft - aimedLeft)).toBeLessThanOrEqual(2);

    // And it is genuinely usable, not merely laid out somewhere plausible.
    await expect(page.locator(ITEM).filter({ hasText: 'Masking Studio' })).toBeInViewport();
  });

  test('the panel stays inside the clip box when the nav reflows UNDER an open menu', async ({ page }) => {
    // The test above opens the menu only after waitForHomeReady(), i.e. once every
    // late layout change has already landed — so it pins the geometry at open time
    // and structurally cannot see this. On a phone the nav is still moving for
    // seconds after the tap, and NONE of it fires `resize`:
    //   - the Inter woff2 subsets swap in and every label's width changes;
    //   - the language pack resolves, applyLanguageToElements() rewrites every
    //     [data-lang] textContent and dispatches "languagechange";
    //   - /api/auth/me resolves, syncStagingMenu() re-toggles `is-locked` (which
    //     shows/hides an 18px badge on three rows, so the panel's own max-content
    //     width changes) and gallery-tab.js dispatches "stagify:navvisibility".
    //
    // --staging-panel-shift is a FIXED px left margin computed once in alignPanel(),
    // which re-runs on `resize` ALONE — where nav-pill.js, solving the same "the row
    // moves under me" problem in this very container, re-settles on six signals. So
    // the shift genuinely does go stale here: this test measures the trigger sliding
    // 73px -> 123px while `--staging-panel-shift` stays at its original 8px, i.e. the
    // panel stops pointing at "Staging".
    //
    // That staleness is a MIS-AIM, not a clipping bug, and the distinction is the
    // point of this test. The panel is pinned at its `min-width:min(224px,100%)` floor
    // and capped at `max-width:100%`, so against a ~370px clip box there is ~145px of
    // slack and the clamp's output can never push it past the edge. Measured, not
    // assumed — an earlier reading of this code claimed a stale shift was what cut the
    // phone menu off, and these numbers are what disproved it. Pin the containment so
    // a future change to either bound (a flat 224px min-width beats max-width, which
    // is the known trap) cannot quietly turn the mis-aim into a real clip.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await openMenu(page);

    const read = () => page.evaluate(() => {
      const panel = document.querySelector('.staging-menu__panel');
      const clip = document.querySelector('.nav-center');
      const trigger = document.querySelector('.staging-menu__trigger');
      return {
        panelWidth: panel.offsetWidth,
        clipWidth: clip.clientWidth,
        offsetLeft: panel.offsetLeft,
        triggerLeft: trigger.offsetLeft,
        triggerWidth: trigger.offsetWidth,
        shift: panel.style.getPropertyValue('--staging-panel-shift'),
        anchoredToClipBox: panel.offsetParent === clip,
      };
    });

    const before = await read();

    // Now do to the nav exactly what the language pack does when it lands: rewrite
    // the [data-lang] labels and announce it. German is not arbitrary — it is the
    // real pack with the longest nav labels, and language-detect.js picks it from the
    // browser's own tag, so a German phone gets this on the FIRST load with no
    // interaction at all. Both halves matter: the nav links move the trigger, and the
    // menu's own rows widen the panel, which is what eats the clamp's headroom.
    await page.evaluate(() => {
      const german = {
        'navigation.home': 'Startseite',
        'navigation.staging': 'Inszenierung',
        'navigation.guides': 'Anleitungen',
        'navigation.contactUs': 'Kontaktieren Sie uns',
        'navigation.imageStaging': 'Bildinszenierung',
        'navigation.basicMask': 'Einfache Maske',
        'navigation.maskingStudio': 'Maskierungsstudio',
      };
      for (const [key, value] of Object.entries(german)) {
        for (const el of document.querySelectorAll(`[data-lang="${key}"]`)) el.textContent = value;
      }
      window.dispatchEvent(new Event('languagechange'));
    });
    // The re-settle is rAF-debounced with a 60ms follow-up, same shape as nav-pill's.
    await page.waitForTimeout(250);

    const after = await read();

    // The reflow must genuinely have moved the nav, or this test proves nothing.
    // Asserted on the TRIGGER, not the panel width: the panel is at its min-width
    // floor and German is not long enough to lift it off, so a width assertion here
    // fails on a menu that is behaving perfectly.
    expect(after.triggerLeft).toBeGreaterThan(before.triggerLeft);
    // ...and the aim really is stale — this is the live (cosmetic) defect.
    expect(after.shift).toBe(before.shift);

    // The same three invariants the test above pins at open time, now re-checked
    // AFTER the reflow. These are the property; the aim is a nicety on top of them.
    expect(after.anchoredToClipBox).toBe(true);
    expect(after.offsetLeft).toBeGreaterThanOrEqual(0);
    expect(after.offsetLeft + after.panelWidth).toBeLessThanOrEqual(after.clipWidth);

    // And the last row is still reachable rather than clipped away.
    await expect(page.locator(ITEM).filter({ hasText: 'Maskierungsstudio' })).toBeInViewport();
  });
});
