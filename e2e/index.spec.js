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
    await expect(page.locator('.hp-stat__num[data-stat="roomsStaged"]')).toBeAttached();
    await expect(page.locator('.hp-stat__num[data-stat="usersServed"]')).toBeAttached();

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
    // The homepage's LCP element is the `<img>` in `.hp-canvas`, and it ships in index.html
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

    const stage = page.locator('.hp-canvas');
    await expect(
      stage,
      'hero-picker.js did not take the adopt path — the static photo was overwritten'
    ).toHaveAttribute('data-hp-adopted', '');

    // The first paint costs exactly one image: the default pair. The empty "before" shot
    // and the other 35 renders are fetched on demand, so anything more here means the
    // hero has started paying for images nobody asked to see.
    const photo = stage.locator('img[data-hp-img]');
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
    // `>` throughout: the headline now lives inside the canvas and each dropdown row carries
    // a 46px thumbnail, so a descendant query counts 14 menu thumbs alongside the renders.
    const shown = page.locator('.hp-canvas > img.is-on');
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute('src', 'media-webp/example/coastal-bedroom.webp');
    await expect(page.locator('.hp-canvas > img[src*="modern-bedroom"]')).toHaveCount(1);
  });

  test('the hero picker is usable, and visible, from the keyboard alone', async ({ page }) => {
    // A real browser is the only place this can be checked. The focus RING in particular was
    // invisible for a while because `:focus-visible` shared a block with `:hover` and set
    // `outline: none` — and `[aria-selected="true"]` matched at the same specificity later in
    // the sheet, so it won on exactly the row that receives focus when the menu opens. No
    // source scan sees that; it needs a computed style. `test/frontend/hero-picker-a11y.test.js`
    // guards the declarations, this guards the outcome.
    await page.goto('/index.html');

    const styleBtn = page.locator('#hero-style-btn');
    const menu = page.locator('#hero-style-menu');

    // Open with the keyboard, not a click: :focus-visible deliberately does not match a
    // programmatic or mouse focus, so a click-driven check would report no ring and be wrong.
    await styleBtn.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();

    // Arrow first, so focus-visible is unambiguously in keyboard mode.
    await page.keyboard.press('ArrowDown');
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThan(0);

    // Home/End matter because the style menu is 8 rows; Left/Right because it is two columns.
    await page.keyboard.press('End');
    await expect(page.locator('.hp-menu__item:focus')).toHaveText(/Custom/);
    await page.keyboard.press('Home');
    await expect(page.locator('.hp-menu__item:focus')).toHaveText(/Standard/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.hp-menu__item:focus')).toHaveText(/Farmhouse/);

    // Escape closes and hands focus back, rather than dropping it on the document.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(styleBtn).toBeFocused();

    // Enter on an option picks it, exactly as a click does.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.locator('#hero-style-label')).not.toHaveText('Modern');
  });

  test('closing the menu never strands focus on the document', async ({ page }) => {
    // Clicking the photo blurs the focused option on MOUSEDOWN, well before the handler that
    // closes the menu runs — so "was focus inside the menu?" is always false by then, and the
    // visitor was left on <body> with their next Tab restarting at the top of the page.
    await page.goto('/index.html');

    await page.locator('#hero-style-btn').click();
    await expect(page.locator('#hero-style-menu')).toBeVisible();

    // The canvas is not focusable, which is the whole point of this case.
    await page.locator('.hp-canvas__img.is-on').click({ position: { x: 40, y: 40 } });

    await expect(page.locator('#hero-style-menu')).toBeHidden();
    await expect(page.locator('#hero-style-btn')).toBeFocused();
  });

  test('only the render on screen is exposed to assistive tech', async ({ page }) => {
    // opacity: 0 hides a thing from the eye and from nobody else. Without aria-hidden every
    // pair the visitor has viewed stays in the tree as a real <img> with real alt text.
    await page.goto('/index.html');

    const menu = page.locator('#hero-style-menu');
    for (const style of ['Coastal', 'Farmhouse']) {
      await page.locator('#hero-style-btn').click();
      await menu.locator('.hp-menu__item', { hasText: style }).click();
      await expect(menu).toBeHidden();
    }

    // Three renders exist by now; exactly one may be visible to a screen reader.
    await expect(page.locator('.hp-canvas > img')).not.toHaveCount(1);
    await expect(page.locator('.hp-canvas > img:not([aria-hidden="true"])')).toHaveCount(1);

    // And the swap is announced, rather than happening in silence.
    await expect(page.locator('#hero-live')).toHaveText(/farmhouse/i);
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
    await expect(page.locator('.hp-canvas > img.is-on')).toHaveAttribute(
      'src',
      'media-webp/example/farmhouse-kitchen.webp',
    );

    // The adopted LCP node survives the restore. show() hides it, it does not remove it,
    // and removing it would break the adopt guarantee the test above pins.
    await expect(page.locator('.hp-canvas')).toHaveAttribute('data-hp-adopted', '');
    await expect(page.locator('.hp-canvas > img[src*="modern-bedroom"]')).toHaveCount(1);

    // A pick naming a room or style that no longer exists must fall back to the default,
    // not build a path to a render that was never generated. That is what happens the day
    // someone drops a room type from ROOMS, and the failure mode is an empty hero for
    // exactly the returning visitors this feature exists to please.
    await page.evaluate(() => window.localStorage.setItem('heroPick', 'farmhouse|conservatory'));
    await page.reload();

    await expect(page.locator('#hero-room-label')).toHaveText('bedroom');
    await expect(page.locator('#hero-style-label')).toHaveText('Modern');
    await expect(page.locator('.hp-canvas > img.is-on')).toHaveAttribute(
      'src',
      'media-webp/example/modern-bedroom.webp',
    );
  });


  test('the NAR tile sentence holds two lines in English', async ({ page }) => {
    // A LAYOUT ASSERTION THAT ONLY A REAL BROWSER CAN MAKE. The card's column split
    // (.nar-card grid-template-columns) is tuned to a measurement: English's longest
    // tile sentence needs 285px of text column to wrap to two lines, and it gets 299.
    // node --test has no layout engine, so nothing in the deploy-gating suite can
    // notice the day someone retunes that ratio and the sentence silently runs to
    // three lines — taller than the tile beside it, and taller than the 2024 wording
    // it swaps with, so the whole card jumps height when the year switch is used.
    // Desktop only, and not incidentally: below 900px `.nar-card` collapses to a single
    // column, so the tile spans the full card and the ratio this guards is not even in
    // play. Asserting a line count there would be pinning a different layout.
    const vw = page.viewportSize()?.width ?? 0;
    test.skip(vw <= 900, 'the two-column split only applies above the 900px breakpoint');

    await page.goto('/');
    const txt = page.locator('.nar-stat__txt').first();
    await expect(txt).toBeVisible();

    const box = await txt.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
        width: el.getBoundingClientRect().width,
      };
    });
    expect(box.lines).toBe(2);
    // The margin, not just the outcome: at 285px it flips to three lines, so a change
    // that leaves this barely passing is a change that will break on another machine.
    expect(box.width).toBeGreaterThanOrEqual(292);
  });


  test('the citation dissolve clone lays out identically to the live text', async ({ page }) => {
    // A SUB-PIXEL LAYOUT BUG THAT LOOKED LIKE A DESIGN FAULT. Switching years dissolves
    // the citation by parking a clone of the old paragraph over the new one. The
    // paragraph is a flex item sized to its own content, so the sentence sits EXACTLY on
    // its wrap boundary with no slack — and `offsetWidth` rounds to an integer. The
    // clone was handed 640px for text needing 640.21px, wrapped to a second line, and
    // dropped its "Source: …" line 21.7px below the real one for the length of the fade.
    // (The years are not even the same width: "2024" is ~0.5px wider than "2025".)
    //
    // Only a real browser can see this, so it lives here rather than in the unit suite.
    await page.goto('/');
    await expect(page.locator('[data-nar-dissolve]')).toBeVisible();
    // The citation is in the static HTML, so its visibility says nothing about whether
    // the switch is wired — index-deferred.js injects home-figures.js after `load`, and
    // a click before that lands on an inert button and produces no clone at all.
    // initNarYears() takes the year-dependent nodes off language-loader.js as its first
    // act, so their hooks disappearing is the precise "ready" signal.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-nar-owned][data-lang], [data-nar-owned][data-lang-attr]').length === 0,
    );

    for (const year of ['2024', '2025']) {
      const m = await page.evaluate((y) => {
        const card = document.querySelector('[data-nar-chart]');
        card.querySelector(`[data-nar-year="${y}"]`).click();
        const ghost = card.querySelector('.nar-ghost');
        const live = card.querySelector('[data-nar-dissolve]');
        if (!ghost || !live) return null;
        const gc = ghost.querySelector('cite').getBoundingClientRect();
        const lc = live.querySelector('cite').getBoundingClientRect();
        return {
          citeDelta: Math.abs(gc.top - lc.top),
          heightDelta: Math.abs(ghost.getBoundingClientRect().height - live.getBoundingClientRect().height),
        };
      }, year);

      expect(m, `switching to ${year} produced no dissolve clone`).not.toBeNull();
      // One line-height of drift is the failure mode; anything above a rounding wobble
      // means the clone is wrapping differently from the text it is copying.
      expect(m.citeDelta, `the ${year} clone's Source line is offset from the live one`).toBeLessThan(2);
      expect(m.heightDelta, `the ${year} clone is a different height from the live text`).toBeLessThan(2);
      await page.waitForTimeout(500);
    }
  });


  test('pressing the year already selected does nothing at all', async ({ page }) => {
    // Re-pressing the active year used to repaint the whole card: a dissolve clone over
    // an identical citation, the tiles crossfading to the wording they already had, and
    // seven numerals tweening from each value to itself. Half a second of flicker to
    // land exactly where it started.
    //
    // Asserted in a browser rather than by reading the source because the thing that
    // must not happen is a DOM side effect, and the clone is created synchronously on
    // click — so its absence is checkable the instant the handler returns.
    await page.goto('/');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-nar-owned][data-lang], [data-nar-owned][data-lang-attr]').length === 0,
    );

    const snapshot = () => page.evaluate(() => {
      const card = document.querySelector('[data-nar-chart]');
      return {
        numerals: [...card.querySelectorAll('.nar-stat__num, .nar-legend .pct, .nar-usage__note strong')].map((n) => n.textContent),
        cite: card.querySelector('[data-nar-source-link]').textContent,
        pressed: [...card.querySelectorAll('[data-nar-year]')].map((b) => b.getAttribute('aria-pressed')).join(','),
        ghosts: card.querySelectorAll('.nar-ghost').length,
        swapping: card.querySelectorAll('.nar-swap.is-swapping').length,
      };
    });

    const before = await snapshot();
    expect(before.pressed, '2025 ships selected').toBe('false,true');

    // Press the ALREADY-SELECTED year, then look immediately — before any timer could
    // have tidied a clone away, so a repaint could not hide behind its own cleanup.
    const during = await page.evaluate(() => {
      const card = document.querySelector('[data-nar-chart]');
      card.querySelector('[data-nar-year="2025"]').click();
      return {
        ghosts: card.querySelectorAll('.nar-ghost').length,
        swapping: card.querySelectorAll('.nar-swap.is-swapping').length,
      };
    });
    expect(during.ghosts, 'a dissolve clone was built for a year change that did not happen').toBe(0);
    expect(during.swapping, 'the tiles started a crossfade to the wording they already had').toBe(0);

    await page.waitForTimeout(400);
    expect(await snapshot()).toEqual(before);

    // The button is still a live control for the OTHER year — a no-op must not have
    // been implemented by deadening the group.
    await page.evaluate(() => document.querySelector('[data-nar-year="2024"]').click());
    await page.waitForTimeout(900);
    const after = await snapshot();
    expect(after.pressed).toBe('true,false');
    expect(after.cite).toContain('2024');
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
