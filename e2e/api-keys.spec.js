// The developer surface in a real browser: public/api-keys.html and public/developers.html.
//
// What a browser checks that the unit specs cannot is the wiring — that the composition
// roots (api-keys-app.js, developers-pricing.js) actually mount, that the signed-in and
// signed-out branches paint the right half of the page, and that the create-key dialog's
// one-time reveal really reaches the screen. The islands underneath all have unit specs
// in test/frontend/api-keys/; this is the assembly.
//
// Every /api/* call is stubbed, as everywhere in this suite: no key is minted, no credit
// is spent, and no Stripe session is created.
import { test, expect } from '@playwright/test';
import { seedProSession, stubAnalytics } from './fixtures.js';

const PACKS = {
  packs: [
    { id: 'api_20', credits: 20, amountCents: 300, currency: 'usd' },
    { id: 'api_50', credits: 50, amountCents: 700, currency: 'usd' },
    { id: 'api_100', credits: 100, amountCents: 1300, currency: 'usd' },
    { id: 'api_500', credits: 500, amountCents: 6000, currency: 'usd' },
  ],
};

const KEYS = {
  keys: [
    { id: 'ak_live', name: 'Production', prefix: 'stg_live_abc', createdAt: Date.UTC(2026, 7, 1), lastUsedAt: Date.UTC(2026, 7, 15), revokedAt: null },
    { id: 'ak_dead', name: 'Old laptop', prefix: 'stg_live_xyz', createdAt: Date.UTC(2026, 5, 1), lastUsedAt: null, revokedAt: Date.UTC(2026, 6, 1) },
  ],
};

const CREDITS = {
  balance: 87,
  lifetimePurchased: 100,
  lifetimeSpent: 13,
  suspended: false,
  keyCount: 1,
  ledger: [
    { id: 'cl1', delta: -1, reason: 'debit', balanceAfter: 87, createdAt: Date.UTC(2026, 7, 16) },
    { id: 'cl2', delta: 100, reason: 'purchase', balanceAfter: 100, createdAt: Date.UTC(2026, 7, 1) },
  ],
};

// Three days of traffic, which is enough for the chart to have a shape and for the
// by-key table to have two rows that do not agree with each other.
const DAY = 24 * 60 * 60 * 1000;
const TODAY = Math.floor(Date.now() / DAY) * DAY;
const USAGE = {
  since: TODAY - 2 * DAY,
  days: 3,
  durationSample: 300,
  buckets: [
    { day: TODAY - 2 * DAY, delivered: 40, refunded: 0 },
    { day: TODAY - DAY, delivered: 100, refunded: 10 },
    { day: TODAY, delivered: 20, refunded: 0 },
  ],
  keys: [
    { keyId: 'ak_live', delivered: 3102, refunded: 19, inFlight: 0, creditsSpent: 3102, delivered7d: 791, lastRequestAt: TODAY, medianMs: 14200 },
    { keyId: 'ak_dead', delivered: 421, refunded: 8, inFlight: 0, creditsSpent: 421, delivered7d: 0, lastRequestAt: TODAY - 2 * DAY, medianMs: 15800 },
  ],
  totals: { delivered: 3523, refunded: 27, inFlight: 0, creditsSpent: 3523, delivered7d: 791, medianMs: 14600 },
};

const json = (body) => (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Stub the whole developer API surface. */
async function stubApi(page, { credits = CREDITS, keys = KEYS, usage = USAGE } = {}) {
  await page.route('**/api/api-credits/packs', json(PACKS));
  await page.route('**/api/api-credits', json(credits));
  await page.route('**/api/api-keys', json(keys));
  await page.route('**/api/api-usage*', json(usage));
}

test.describe('Developer docs', () => {
  // The docs page is PC-only: scripts/developers-gate.js redirects a phone-sized
  // viewport to the home page before paint, so on mobile-chrome every assertion below
  // would be made against index.html. The gate's own behaviour is covered in
  // test/frontend/developers/developers-gate-mobile.test.js, and the footer link that
  // points here is checked on both viewports further down.
  test.skip(({ isMobile }) => !!isMobile, 'developers.html is desktop-only');

  test('the pricing grid is filled from the live pack table', async ({ page }) => {
    await stubAnalytics(page);
    await stubApi(page);
    await page.goto('/developers.html');

    const packs = page.locator('#dev-packs .dev-pack');
    await expect(packs).toHaveCount(4);
    // The per-image figure is the number a developer compares between packs, so it is
    // the one that has to be right rather than merely present.
    await expect(packs.first()).toContainText('$3.00');
    await expect(packs.first()).toContainText('$0.150 an image');
    await expect(packs.nth(3)).toContainText('$0.120 an image');

    // The docs page never sells directly — its CTA goes to the dashboard.
    await expect(page.locator('#dev-packs [data-buy-pack]')).toHaveCount(0);
  });

  test('the quickstart ships a copy-pasteable curl, with straight quotes', async ({ page }) => {
    await stubAnalytics(page);
    await stubApi(page);
    await page.goto('/developers.html');

    const code = await page.locator('#quickstart .dev-code').innerText();
    expect(code).toContain('Authorization: Bearer');
    expect(code).toContain('Idempotency-Key');
    // A curly quote here would be a command that does not run.
    expect(code).not.toMatch(/[“”‘’]/);
  });
});

test.describe('The Developers footer link', () => {
  test('is visible on desktop', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile half is the next test');
    await stubAnalytics(page);
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('footer a[href="developers.html"]')).toBeVisible();
  });

  test('is hidden on a phone, and takes its separator with it', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'this is the mobile half');
    await stubAnalytics(page);
    await stubApi(page);
    await page.goto('/');

    await expect(page.locator('footer a[href="developers.html"]')).toBeHidden();
    // The separator has to go too, or the footer shows an orphan "·" between Status and
    // the copyright. It lives inside the same span precisely so it cannot be forgotten.
    const footer = await page.locator('footer').innerText();
    expect(footer).not.toContain('Developers');
    expect(footer.match(/·/g) || []).toHaveLength(3);
  });
});

// The dashboard is a master/detail inspector, and PC-ONLY: api-keys-gate.js sends a
// phone-sized viewport to the home page before anything paints. Every test below is
// therefore desktop-only, and the phone half is asserted once, at the end — the same
// pairing the AI Designer and gallery specs use, so nothing is weakened to go green.
test.describe('API keys dashboard', () => {
  test.skip(({ isMobile }) => isMobile, 'PC-only page — the phone half is the redirect test below');

  test('a signed-out visitor is asked to sign in, not shown an empty dashboard', async ({ page }) => {
    await stubAnalytics(page);
    await stubApi(page);
    await page.goto('/api-keys.html');

    await expect(page.locator('#ak-signedout')).toBeVisible();
    await expect(page.locator('#ak-app')).toBeHidden();
  });

  test('a signed-in account gets a list of everything it owns, and lands on a live key', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.goto('/api-keys.html');

    await expect(page.locator('#ak-signedout')).toBeHidden();
    // Two account rows plus both keys — a revoked key stays listed, because it is the
    // one you want to recognise in an access log.
    await expect(page.locator('#ak-list .ak-item')).toHaveCount(4);
    await expect(page.locator('[data-ak-select="billing"]')).toBeVisible();
    await expect(page.locator('[data-ak-select="ak_dead"]')).toContainText('revoked');

    // The default selection is the first live key, and the URL says so, so the pane is
    // linkable and a reload comes back to the same place.
    await expect(page.locator('[data-ak-select="ak_live"]')).toHaveAttribute('aria-current', 'page');
    expect(page.url()).toContain('#key/ak_live');
    await expect(page.locator('#ak-detail-title')).toContainText('Production');
    // Numbers from /api/api-usage, not from the key record.
    await expect(page.locator('#ak-detail')).toContainText('99.4%');
    await expect(page.locator('#ak-detail')).toContainText('14.2s');
  });

  test('a deep link opens that key, and a revoked one offers nothing to press', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.goto('/api-keys.html#key/ak_dead');

    await expect(page.locator('#ak-detail-title')).toContainText('Old laptop');
    await expect(page.locator('#ak-detail [data-revoke-key]')).toHaveCount(0);
    await expect(page.locator('#ak-detail [data-ak-rename]')).toHaveCount(0);
    await expect(page.locator('#ak-detail')).toContainText('Revoked on');
  });

  test('the billing row shows the balance, the packs and the ledger', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.goto('/api-keys.html');

    await page.locator('[data-ak-select="billing"]').click();
    await expect(page.locator('#ak-detail-title')).toContainText('Credits');
    await expect(page.locator('#ak-detail')).toContainText('87');
    await expect(page.locator('#ak-packs .dev-pack')).toHaveCount(4);
    await expect(page.locator('#ak-ledger tr')).toHaveCount(2);
    await expect(page.locator('#ak-ledger')).toContainText('Credits purchased');
  });

  test('the usage row breaks the account down by key, and a row selects one', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.goto('/api-keys.html');

    await page.locator('[data-ak-select="usage"]').click();
    await expect(page.locator('#ak-detail-title')).toHaveText('Usage');
    // One column per day in the window, which is what makes a quiet week look quiet
    // rather than broken.
    await expect(page.locator('#ak-detail .ak-chart__col')).toHaveCount(3);
    await expect(page.locator('#ak-detail')).toContainText('Production');

    await page.locator('#ak-detail [data-ak-select="ak_live"]').click();
    await expect(page.locator('#ak-detail-title')).toContainText('Production');
  });

  test('searching hides keys but never the way back to the balance', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.goto('/api-keys.html');

    await page.locator('#ak-search').fill('laptop');
    await expect(page.locator('[data-ak-select="ak_dead"]')).toBeVisible();
    await expect(page.locator('[data-ak-select="ak_live"]')).toHaveCount(0);
    await expect(page.locator('[data-ak-select="billing"]')).toBeVisible();
  });

  test('renaming a key PATCHes it and the list picks up the new name', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);

    let patched = null;
    await page.route('**/api/api-keys/*', (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      patched = JSON.parse(route.request().postData() || '{}');
      return json({ record: { ...KEYS.keys[0], name: patched.name } })(route);
    });
    // The refresh after the PATCH has to see the new name, or the list would snap back.
    await page.route('**/api/api-keys', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const renamed = patched
        ? { keys: [{ ...KEYS.keys[0], name: patched.name }, KEYS.keys[1]] }
        : KEYS;
      return json(renamed)(route);
    });

    await page.goto('/api-keys.html');
    await page.locator('#ak-detail [data-ak-rename]').click();
    await page.locator('#ak-rename-input').fill('Batch worker');
    await page.locator('.ak-rename button[type=submit]').click();

    await expect.poll(() => patched).toEqual({ name: 'Batch worker' });
    await expect(page.locator('[data-ak-select="ak_live"]')).toContainText('Batch worker');
  });

  test('creating a key reveals it once, and lands on the key it made', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);

    let created = false;
    await page.route('**/api/api-keys', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            key: 'stg_live_TESTKEYVALUE',
            record: { id: 'ak_new', name: 'CI', prefix: 'stg_live_TES', createdAt: Date.now(), revokedAt: null },
          }),
        });
      }
      const withNew = created
        ? { keys: [{ id: 'ak_new', name: 'CI', prefix: 'stg_live_TES', createdAt: Date.now(), lastUsedAt: null, revokedAt: null }, ...KEYS.keys] }
        : KEYS;
      return json(withNew)(route);
    });
    await page.goto('/api-keys.html');

    await page.locator('#ak-create').click();
    await expect(page.locator('#ak-modal')).toBeVisible();
    await page.locator('#ak-name').fill('CI');
    await page.locator('#ak-confirm').click();

    await expect(page.locator('#ak-reveal-key')).toHaveText('stg_live_TESTKEYVALUE');
    await expect(page.locator('#ak-modal-reveal')).toContainText('only time');
    await expect(page.locator('#ak-modal-form')).toBeHidden();

    // Escape must NOT dismiss an unrecoverable secret.
    await page.keyboard.press('Escape');
    await expect(page.locator('#ak-modal')).toBeVisible();

    await page.locator('#ak-done').click();
    await expect(page.locator('#ak-modal')).toBeHidden();
    // And it is gone from the page, not merely hidden.
    await expect(page.locator('#ak-reveal-key')).toHaveText('');
    // The pane follows the new key, so creating one visibly did something.
    await expect(page.locator('#ak-detail-title')).toContainText('CI');
  });

  test('a suspended account is told, in the pane that is about money', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page, { credits: { ...CREDITS, balance: 0, suspended: true } });
    await page.goto('/api-keys.html');

    await page.locator('[data-ak-select="billing"]').click();
    await expect(page.locator('#ak-suspended')).toBeVisible();
    await expect(page.locator('#ak-suspended')).toContainText('suspended');
  });

  test('buying a pack posts the pack id to checkout', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);

    let posted = null;
    await page.route('**/api/api-credits/checkout', (route) => {
      posted = JSON.parse(route.request().postData() || '{}');
      // A url the browser will not actually follow, so the test ends here rather than
      // navigating off to a stub page.
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'stubbed' }) });
    });
    await page.goto('/api-keys.html');

    await page.locator('[data-ak-select="billing"]').click();
    page.once('dialog', (d) => d.dismiss().catch(() => {}));
    await page.locator('#ak-packs [data-buy-pack="api_500"]').click();
    await expect.poll(() => posted).toEqual({ packId: 'api_500' });
  });

  test('an account with no keys lands on billing rather than an empty pane', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page, { keys: { keys: [] } });
    await page.goto('/api-keys.html');

    await expect(page.locator('#ak-list')).toContainText('No keys yet');
    await expect(page.locator('[data-ak-select="billing"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#ak-detail-title')).toContainText('Credits');
  });

  test('the usage endpoint failing does not take the page with it', async ({ page }) => {
    await stubAnalytics(page);
    await seedProSession(page);
    await stubApi(page);
    await page.route('**/api/api-usage*', (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.goto('/api-keys.html');

    // Keys and balance come from other endpoints and are unaffected; the pane says so
    // rather than printing zeros that would read as "you have never rendered".
    await expect(page.locator('#ak-detail-title')).toContainText('Production');
    await expect(page.locator('#ak-detail')).toContainText('usage unavailable');
    await page.locator('[data-ak-select="billing"]').click();
    await expect(page.locator('#ak-detail')).toContainText('87');
  });
});

test.describe('API keys dashboard — phone', () => {
  test('a phone is sent to the home page before the dashboard paints', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'this is the mobile half of the PC-only rule');
    await stubAnalytics(page);
    await stubApi(page);

    await page.goto('/api-keys.html');
    await expect(page).toHaveURL(/\/(index\.html)?$/);
    // A real browser is the only place this can be proved: the gate reads the LAYOUT
    // viewport, so a stubbed matchMedia would pass even with the script above the
    // viewport <meta>, which is exactly the mistake that makes it fire for nobody.
    await expect(page.locator('#ak-app')).toHaveCount(0);
  });
});
