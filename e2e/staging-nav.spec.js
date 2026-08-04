// The top nav's "Staging" dropdown, in a real browser.
//
// It replaced two bare links that were hidden from free users, so the two things
// worth proving here are the ones a DOM-stubbed unit test cannot:
//
//   - a free user SEES all four tools and can only use one of them. The lock is
//     presentational (a class, deliberately not aria-disabled), so this drives the
//     click and checks where the browser actually ends up;
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

/**
 * Wait out the entry transition before measuring geometry.
 *
 * The panel animates in with `translateY(-6px) scale(.98)` → `translateY(0) scale(1)`
 * over .18s, and getBoundingClientRect() reports the TRANSFORMED box — so a rect read
 * straight after `data-open` lands is up to 6px high and a few px narrow. That is the
 * animation, not the placement, and it made the "hangs 8px under the nav row"
 * assertion fail by 5.5px. Opacity shares the same transition, so it is the settle
 * signal.
 */
async function settleMenu(page) {
  await page.waitForFunction(() => {
    const p = document.querySelector('.staging-menu__panel');
    return !!p && getComputedStyle(p).opacity === '1';
  });
}

test.describe('Staging dropdown — desktop', () => {
  // These pin the DESKTOP shape of the menu — all four rows visible, and the sliding
  // nav pill, which only exists on a pointer device. The phone shape is a different
  // thing, not a weaker one: it has its own describe at the end of this file, where
  // three rows show and the PC-only AI Designer row does not.
  // (This used to say the whole menu was `desktop-only`. That was true until
  // 2026-08-01 and left a phone with no nav path to any staging tool at all.)
  test.skip(({ isMobile }) => isMobile, 'asserts the desktop layout; the phone half is below');

  test('lists the five tools in order and opens on click', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    // Closed until asked: the panel is pointer-inert without [data-open].
    await expect(page.locator(MENU)).not.toHaveAttribute('data-open', '');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');

    const items = await openMenu(page);
    await expect(items).toHaveCount(5);
    await expect(items.nth(0)).toContainText('Image Staging');
    await expect(items.nth(1)).toContainText('Basic Mask');
    await expect(items.nth(2)).toContainText('AI Designer');
    await expect(items.nth(3)).toContainText('Masking Studio');
    await expect(items.nth(4)).toContainText('Exterior Studio');
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

  test('a Pro user gets all five unlocked', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    for (let i = 0; i < 5; i += 1) {
      await expect(items.nth(i)).not.toHaveClass(/is-locked/);
      // The lock is what carries "this is Stagify+" into the a11y tree, so an
      // unlocked row must not still be announcing it. Asserted as visibility AND
      // as the computed name: the lock is display:none rather than absent, so a
      // text assertion alone would read a hidden descendant, and a visibility
      // assertion alone would not notice an aria-label that survived the hiding.
      await expect(items.nth(i).locator('.staging-menu__lock')).toBeHidden();
      await expect(items.nth(i)).not.toHaveAccessibleName(/Stagify\+/);
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

  test('a free user sees all five but only Image Staging is live', async ({ page }) => {
    await seedFreeSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    const items = await openMenu(page);
    await expect(items).toHaveCount(5, 'the studios stay visible — that is the upsell');
    await expect(items.nth(0)).not.toHaveClass(/is-locked/);
    for (const i of [1, 2, 3, 4]) {
      await expect(items.nth(i)).toHaveClass(/is-locked/);
      // A locked row stays an operable link (it goes to Stagify+), so the state is
      // announced by the lock's own label rather than by aria-disabled. The lock is
      // the only mark of it now — it used to sit beside a Stagify+ logo that said
      // the same thing — so this checks both halves of what it has to do: be seen,
      // and be announced. The name is computed by the browser, which is the point of
      // asserting it here rather than in the static guard: role="img" + aria-label on
      // an <svg> either reaches name-from-content or it does not.
      await expect(items.nth(i).locator('.staging-menu__lock')).toBeVisible();
      await expect(items.nth(i)).toHaveAccessibleName(/Stagify\+/);
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
    // All five rows stay in the DOM — one of them is hidden by CSS, not dropped, so
    // the markup is identical on every page and at every width.
    await expect(items).toHaveCount(5);
    for (const name of ['Image Staging', 'Basic Mask', 'Masking Studio', 'Exterior Studio']) {
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

  test('the open panel escapes every clipping ancestor and is really painted', async ({ page }) => {
    // The panel hangs ~134px below a ~32px nav row, so it overflows all of its
    // ancestors, and three of them clip the X axis: .nav-center always, plus .nav and
    // .site-header on the pages loading home.css. `overflow-x:clip` with
    // `overflow-y:visible` must not clip vertically — Chromium and Playwright's WebKit
    // honour that, real iOS Safari does not, and it erased the panel outright. So the
    // panel is `position:fixed` below 768px: out of the containing-block chain, where
    // no ancestor's overflow can reach it however that ancestor computes.
    //
    // This test used to assert `panel.offsetParent === .nav-center`, i.e. that the
    // panel was positioned INSIDE the clipping box. That is the opposite of the
    // property now, and it was never the real one anyway: it passed on the phone the
    // whole time the panel was invisible there.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await openMenu(page);
    await settleMenu(page);

    const geom = await page.evaluate(() => {
      const panel = /** @type {HTMLElement} */ (document.querySelector('.staging-menu__panel'));
      const row = /** @type {HTMLElement} */ (document.querySelector('.nav-center'));
      const trigger = /** @type {HTMLElement} */ (document.querySelector('.staging-menu__trigger'));
      const p = panel.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();

      // Does anything between the panel and the viewport establish a containing block
      // for fixed descendants? If so the escape is void and the panel is back inside
      // the overflow boxes — the exact regression the static guard also watches for.
      const traps = [];
      for (let el = panel.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
          || (cs.backdropFilter && cs.backdropFilter !== 'none')
          || cs.willChange !== 'auto' || cs.contain !== 'none') {
          traps.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
        }
      }
      const cx = p.x + p.width / 2;
      const cy = p.y + p.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        position: getComputedStyle(panel).position,
        panel: { x: p.x, y: p.y, w: p.width, h: p.height, bottom: p.bottom, right: p.right },
        row: { left: r.left, right: r.right, bottom: r.bottom },
        trigger: { left: t.left, width: t.width },
        // offsetWidth ignores the scale(.98)→scale(1) entry transform, so the aim maths
        // below is not measuring the animation.
        layoutWidth: panel.offsetWidth,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        traps,
        // THE assertion this file was missing. Geometry can be perfect while nothing is
        // painted — on the phone the rect was a correct 224x134 at y=116 with opacity 1
        // and the panel was simply not there. Hit-testing is the closest a DOM test gets
        // to asking "is this actually on screen", and it fails when an ancestor clips.
        hitsPanel: !!(hit && hit.closest('.staging-menu__panel')),
        hitWas: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).split(' ')[0] : null,
      };
    });

    expect(geom.position).toBe('fixed');
    expect(geom.traps).toEqual([]);
    expect(geom.hitsPanel, `centre of the panel hit ${geom.hitWas}`).toBe(true);

    // Wholly on screen, top and bottom included — the axis that iOS clipped.
    expect(geom.panel.y).toBeGreaterThanOrEqual(0);
    expect(geom.panel.bottom).toBeLessThanOrEqual(geom.viewport.h);
    expect(geom.panel.x).toBeGreaterThanOrEqual(0);
    expect(geom.panel.right).toBeLessThanOrEqual(geom.viewport.w);

    // Hung just under the nav row rather than floating somewhere arbitrary.
    expect(Math.abs(geom.panel.y - (geom.row.bottom + 8))).toBeLessThanOrEqual(2);

    // Inside the row's horizontal bounds, and not full-bleed: content width with a real
    // gutter either side, which is what stops a four-row menu spanning the whole phone.
    expect(geom.panel.x).toBeGreaterThanOrEqual(geom.row.left + 8 - 1);
    expect(geom.panel.right).toBeLessThanOrEqual(geom.row.right - 8 + 1);
    expect(geom.layoutWidth).toBeLessThan(geom.row.right - geom.row.left - 40);

    // And it points at "Staging" rather than at the middle of the nav. Recompute
    // staging-menu.js's own clamp: where centring fits this reduces to exact centring,
    // and a panel that ignored its trigger still fails it.
    const GAP = 8;
    const min = Math.max(geom.row.left, 0) + GAP;
    const max = Math.min(geom.row.right, geom.viewport.w) - geom.layoutWidth - GAP;
    const centred = geom.trigger.left + (geom.trigger.width - geom.layoutWidth) / 2;
    const aimed = Math.min(Math.max(centred, min), Math.max(min, max));
    expect(Math.abs(geom.panel.x - aimed)).toBeLessThanOrEqual(2);

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
    // and capped at `max-width:calc(100vw - 16px)`, so against a ~370px row there is
    // ~145px of slack and the clamp's output can never push it past the edge.
    // Measured, not assumed — an earlier reading of this code claimed a stale offset
    // was what cut the phone menu off, and these numbers are what disproved it (the
    // real cause was ancestor overflow clipping, fixed by position:fixed). Pin the
    // containment so a future change to either bound (a flat 224px min-width beats
    // max-width, which is the known trap) cannot turn the mis-aim into a real clip.
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);
    await openMenu(page);
    await settleMenu(page);

    const read = () => page.evaluate(() => {
      const panel = /** @type {HTMLElement} */ (document.querySelector('.staging-menu__panel'));
      const row = /** @type {HTMLElement} */ (document.querySelector('.nav-center'));
      const trigger = /** @type {HTMLElement} */ (document.querySelector('.staging-menu__trigger'));
      const p = panel.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const hit = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2);
      return {
        panelWidth: panel.offsetWidth,
        rowLeft: r.left,
        rowRight: r.right,
        x: p.x,
        right: p.right,
        bottom: p.bottom,
        triggerLeft: trigger.getBoundingClientRect().left,
        left: panel.style.getPropertyValue('--staging-panel-left'),
        viewportH: window.innerHeight,
        hitsPanel: !!(hit && hit.closest('.staging-menu__panel')),
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
    expect(after.left).toBe(before.left);

    // The invariants the test above pins at open time, now re-checked AFTER the
    // reflow. These are the property; the aim is a nicety on top of them.
    expect(after.hitsPanel).toBe(true);
    expect(after.x).toBeGreaterThanOrEqual(after.rowLeft + 8 - 1);
    expect(after.right).toBeLessThanOrEqual(after.rowRight - 8 + 1);
    expect(after.bottom).toBeLessThanOrEqual(after.viewportH);

    // And the last row is still reachable rather than clipped away.
    await expect(page.locator(ITEM).filter({ hasText: 'Maskierungsstudio' })).toBeInViewport();
  });
});
