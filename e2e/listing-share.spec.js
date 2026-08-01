// The client share gallery (`/s/<token>`) — the one surface a person WITHOUT a Stagify
// account ever sees, in a real browser.
//
// WHY THIS PAGE NEEDS E2E AND THE UNIT TESTS ARE NOT ENOUGH
// Everything else in the Listing Studio is driven by an operator who is signed in, on a
// desktop, and who will tell us when it breaks. This page is opened once, on a phone, by a
// seller deciding whether to approve their own home going on the market — and by buyers who
// will simply close the tab. Nobody reports it.
//
// The frontend unit suite mounts these modules against a hand-rolled fake document, which
// cannot observe the three things most likely to break them, all of which are properties of
// a REAL browser:
//   * the strict CSP — an inline module script silently no-ops here, and has before;
//   * module load order and `type="module"` resolution against the real static server;
//   * focus management, keyboard interaction and `[hidden]` vs `display` specificity, which
//     is exactly how the lightbox once painted over the gallery on first load.
//
// Every `/api/share/*` call is intercepted, so there is NO database, NO real listing and NO
// cost. The server is serving the static shell and nothing else — which is also the point:
// `GET /s/:token` performs no lookup, so it serves that shell for the invented token below.
import { test, expect } from '@playwright/test';
import { stubAnalytics } from './fixtures.js';

const TOKEN = 'e2e-share-token-not-a-real-one';
const SHARE = `/s/${TOKEN}`;

/** A staged listing as `GET /api/share/:token` reports it. Shape from `SharedListing`. */
const LISTING = {
  title: '14 Alderbrook Lane',
  address: '14 Alderbrook Lane, Boulder, CO',
  headline: '',
  note: 'Let me know if you would like a different look for any room.',
  showBefore: true,
  agent: { name: 'Dana Reyes', email: 'dana@example.com', phone: '+1 (303) 555-0148' },
  frameCount: 3,
  disclosure: 'Photos on this page have been virtually staged. Furniture, rugs, art and décor '
    + 'shown are digital renderings for illustration only and are not included in the sale; the '
    + 'structure, dimensions, windows, flooring and fixtures of each room are unaltered.',
  rooms: [
    {
      key: 'living-room-1',
      label: 'Living room',
      frames: [
        { renderId: 'r1', photoId: 'p1', width: 1536, height: 1024, arLabel: '3:2' },
        { renderId: 'r2', photoId: 'p2', width: 1536, height: 1024, arLabel: '3:2' },
      ],
    },
    {
      key: 'bedroom-1',
      label: 'Bedroom',
      frames: [{ renderId: 'r3', photoId: 'p3', width: 1024, height: 1024, arLabel: '1:1' }],
    },
  ],
};

// A 1x1 PNG. The page only needs the <img> to LOAD; what it depicts is irrelevant here and
// a real photograph would make the spec slow and the failure mode ambiguous.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Mock the public share API.
 * @param {import('@playwright/test').Page} page - The page.
 * @param {{ listing?: any, status?: number, feedback?: any[] }} [opts] - `status` other than
 *   200 drives the "no longer available" path, which is the ONLY failure this page can see:
 *   the server answers one identical 404 for revoked, expired and invented alike.
 */
async function mockShare(page, opts = {}) {
  const status = opts.status || 200;
  const listing = opts.listing || LISTING;
  /** @type {any[]} */
  const posted = [];

  await stubAnalytics(page);

  await page.route('**/api/share/*/feedback', async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, feedback: posted[posted.length - 1], allowance: { used: posted.length, limit: 200, full: false } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ responses: opts.feedback || [], allowance: { used: 0, limit: 200, full: false } }),
    });
  });

  // Bytes for both the staged and the original frame.
  await page.route('**/api/share/*/render/*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  await page.route('**/api/share/*/photo/*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));

  // The manifest LAST, so the two more specific patterns above win.
  await page.route('**/api/share/*', (route) => {
    if (status !== 200) {
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ listing }) });
  });

  return { posted };
}

test.describe('client share gallery', () => {
  test('a seller on a phone sees the listing, the disclosure and the agent', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockShare(page);
    await page.goto(SHARE);

    // The h1 becomes the listing, which is also what the tab says.
    await expect(page.locator('h1')).toHaveText('14 Alderbrook Lane');
    await expect(page).toHaveTitle(/14 Alderbrook Lane/);

    // THE DISCLOSURE IS THE COMPLIANCE REQUIREMENT — it is what makes this output usable by
    // a licensed agent, and it must be on the page rather than in a footer nobody reads.
    await expect(page.getByText(/virtually staged/i).first()).toBeVisible();
    await expect(page.getByText(/not included in the sale/i).first()).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Living room' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bedroom' })).toBeVisible();
    await expect(page.getByRole('link', { name: /dana@example\.com/ })).toBeVisible();

    // No horizontal scroll at 375: this page is mobile-first, unlike the desktop-only studio.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every control a THUMB must hit is at least 44px tall, including the agent links', async ({ page }) => {
    // The agent's email and phone are the only things on this page a BUYER is meant to act
    // on, and this page is opened on a phone from a text message. They were 27px tall — over
    // the WCAG 2.5.8 floor of 24px, so no automated a11y check flagged them, but under the
    // 44px every other control here holds to, and a mis-tap is the lead the broker never gets.
    //
    // Measured in a REAL browser on purpose: the fix is vertical padding on a baseline-aligned
    // flex item, and the frontend unit suite's fake document has no layout at all, so it
    // cannot tell 27px from 45px. A stylesheet assertion would only restate the CSS.
    await page.setViewportSize({ width: 375, height: 812 });
    await mockShare(page);
    await page.goto(SHARE);
    await expect(page.getByRole('link', { name: /dana@example\.com/ })).toBeVisible();

    const undersized = await page.evaluate(() => {
      const out = [];
      // The colophon credit is deliberately excluded: it is our byline, not a task the
      // visitor came to do. Everything else here is something a reader is invited to touch.
      const controls = document.querySelectorAll('button, a[href]:not(.sh-colophon__link), input, textarea');
      controls.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 44) out.push(`${el.className || el.tagName}: ${Math.round(r.height)}px`);
      });
      return { out, counted: controls.length };
    });

    // The population assertion. Without it this passes just as well when the gallery failed
    // to render and there are no controls to measure.
    expect(undersized.counted).toBeGreaterThan(8);
    expect(undersized.out).toEqual([]);
  });
  test('the before/after divider is operable by KEYBOARD, not just by dragging', async ({ page }) => {
    // A slider that only works with a pointer is unusable for part of the audience, and this
    // is the page's central interaction. The fake-document unit tests cannot observe focus.
    await mockShare(page);
    await page.goto(SHARE);

    const handle = page.getByRole('slider').first();
    await expect(handle).toBeVisible();
    await handle.focus();
    await expect(handle).toBeFocused();

    const before = await handle.getAttribute('aria-valuenow');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const after = await handle.getAttribute('aria-valuenow');
    expect(after).not.toBe(before);
  });

  test('the lightbox opens, navigates, and gives focus BACK when it closes', async ({ page }) => {
    // Focus restoration is the part that gets dropped in a refactor and that nobody notices
    // with a mouse: without it a keyboard user is returned to the top of the document.
    await mockShare(page);
    await page.goto(SHARE);

    const opener = page.getByRole('button', { name: /full screen/i }).first();
    await opener.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const firstLabel = await dialog.textContent();

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => dialog.textContent()).not.toBe(firstLabel);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('a link that is no longer available says so calmly, and shows nothing else', async ({ page }) => {
    // Revoked, expired and invented are ONE indistinguishable 404 by design, so the page has
    // exactly one failure state and must not speculate about which it hit.
    await mockShare(page, { status: 404 });
    await page.goto(SHARE);

    // The h1 itself BECOMES the state, so the phrase legitimately appears twice (heading and
    // body). Scope to the heading rather than loosening the assertion.
    await expect(page.getByRole('heading', { name: /no longer available/i })).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.locator('img')).toHaveCount(0);
    // …and it must not leak a reason.
    await expect(page.getByText(/revoked|expired|not found/i)).toHaveCount(0);
  });

  test('with before/after off, the original photo is never requested at all', async ({ page }) => {
    // The privacy decision has to hold at the NETWORK, not merely in what is rendered — an
    // unstaged room is the seller's private property and the broker turned this off.
    /** @type {string[]} */
    const asked = [];
    await mockShare(page, { listing: { ...LISTING, showBefore: false, rooms: LISTING.rooms.map((r) => ({ ...r, frames: r.frames.map((f) => ({ ...f, photoId: null })) })) } });
    page.on('request', (req) => {
      if (req.url().includes('/photo/')) asked.push(req.url());
    });

    await page.goto(SHARE);
    await expect(page.getByRole('heading', { name: 'Living room' })).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0, { timeout: 5000 });
    expect(asked, 'no /photo/ request may be made').toEqual([]);
  });

  test('…and with before/after ON the original IS requested, so the check above means something', async ({ page }) => {
    // The negative assertion in the previous test is only evidence if the positive case
    // genuinely fires. Without this pair, a page that never requested /photo/ at all — a
    // broken "before" layer — would look like a privacy win.
    /** @type {string[]} */
    const asked = [];
    await mockShare(page);
    page.on('request', (req) => {
      if (req.url().includes('/photo/')) asked.push(req.url());
    });

    await page.goto(SHARE);
    await expect(page.getByRole('slider').first()).toBeVisible();
    await expect.poll(() => asked.length, { timeout: 5000 }).toBeGreaterThan(0);
  });

  test('a seller can approve a room, and the answer reaches the API', async ({ page }) => {
    const { posted } = await mockShare(page);
    await page.goto(SHARE);

    const approve = page.getByRole('button', { name: /approve Living room/i }).first();
    await expect(approve).toBeVisible();
    await approve.click();

    await expect.poll(() => posted.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(posted[0]).toMatchObject({ roomKey: 'living-room-1', verdict: 'approved' });
    // And the page reflects it rather than silently accepting the click.
    await expect(page.getByText(/looks great/i).first()).toBeVisible();
  });

  test('a big listing does NOT fetch every image on load — the buyer is on cellular', async ({ page }) => {
    // A 40-frame listing is 80 images (staged + original). Fetching them all on load is
    // tens of megabytes onto a phone data plan for photos below the fold that the viewer may
    // never scroll to. The markup carries loading="lazy" + width/height, but attributes are
    // a claim; this counts what the browser ACTUALLY requests above the fold.
    const rooms = Array.from({ length: 8 }, (_, r) => ({
      key: `room-${r}`,
      label: `Room ${r + 1}`,
      frames: Array.from({ length: 5 }, (_, f) => ({
        renderId: `r${r}-${f}`, photoId: `p${r}-${f}`, width: 1536, height: 1024, arLabel: '3:2',
      })),
    }));
    const frameCount = 40;

    /** @type {string[]} */
    const fetched = [];
    await mockShare(page, { listing: { ...LISTING, rooms, frameCount } });
    page.on('request', (req) => {
      if (/\/(render|photo)\//.test(req.url())) fetched.push(req.url());
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(SHARE);
    await expect(page.getByRole('heading', { name: 'Room 1' })).toBeVisible();
    // Give the browser a beat to issue anything it intends to issue eagerly.
    await page.waitForTimeout(1200);

    expect(fetched.length,
      `fetched ${fetched.length} of ${frameCount * 2} images on load`).toBeLessThan(frameCount);
    // …and the gallery really did render all 40 frames, so the low count is laziness and
    // not a page that quietly dropped most of the listing.
    expect(await page.locator('img').count()).toBeGreaterThanOrEqual(frameCount);
  });

  test('the page runs under the real CSP with no console errors', async ({ page }) => {
    // The whole reason this spec exists. An inline module script silently no-ops under this
    // app's CSP — it has happened here before — and a fake document cannot see it.
    /** @type {string[]} */
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(msg.text());
    });
    page.on('pageerror', (err) => problems.push(String(err)));

    await mockShare(page);
    await page.goto(SHARE);
    await expect(page.getByRole('heading', { name: 'Living room' })).toBeVisible();

    const csp = problems.filter((p) => /Content Security Policy|Refused to (execute|load)/i.test(p));
    expect(csp, 'the page must not violate its own CSP').toEqual([]);
    expect(problems, 'and must not throw').toEqual([]);
  });

  test('the social preview is generic — never the address, never a staged photo', async ({ page }) => {
    // Two reasons, both hard requirements: the shell must stay byte-identical for every
    // token (or it becomes an oracle for which tokens are real), and a seller's home must
    // not auto-expand in a group chat.
    await mockShare(page);
    await page.goto(SHARE);

    const og = await page.evaluate(() =>
      [...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')]
        .map((m) => `${m.getAttribute('property') || m.getAttribute('name')}=${m.getAttribute('content')}`)
        .join('\n'));

    expect(og).toMatch(/og:image=/);
    expect(og).not.toMatch(/Alderbrook/);
    expect(og).not.toMatch(/Boulder/);
    expect(og).not.toMatch(/\/s\//);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});
