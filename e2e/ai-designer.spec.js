// AI Designer — happy-path smoke. Drives the real /ai-designer.html in Chromium with
// the model call (/api/chat) intercepted, so there is no real AI call and no cost.
// The client branches on the RESPONSE content-type, so a plain JSON body takes the
// non-SSE path — we assert the assistant bubble renders end-to-end.
import { test, expect } from '@playwright/test';
import { TINY_PNG_DATA_URL, seedProSession, waitForHomeReady } from './fixtures.js';

test.describe('AI Designer — happy path', () => {
  // The studio is PC-only: on a phone-sized viewport the head gate replaces the URL
  // with the home page before anything paints, so there is no chat UI to drive. The
  // mobile half of that decision is asserted at the bottom of this file rather than
  // skipped — this is not weakened to go green.
  test.skip(({ isMobile }) => isMobile, 'the AI Designer is desktop-only by design');

  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  test('sends a message and renders the assistant text reply (mocked /api/chat)', async ({ page }) => {
    let chatCalls = 0;
    await page.route('**/api/chat', (route) => {
      chatCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'Hi from the mocked designer.', memories: { stores: [], forgets: [] } }),
      });
    });

    await page.goto('/ai-designer.html');

    // #chat-input only becomes visible once BOTH auth gates (token + /api/auth/me pro) pass.
    const input = page.locator('#chat-input');
    await expect(input).toBeVisible();

    await input.fill('Make my living room cozy and modern');
    await page.locator('#send-btn').click();

    await expect(page.locator('.message.assistant .message-content').last())
      .toContainText('Hi from the mocked designer.');
    expect(chatCalls).toBeGreaterThan(0);
  });

  test('every turn carries the badge language, so a labelled render is disclosed in it', async ({ page }) => {
    // The AI Designer decides the "Virtually staged" label in conversation and has no UI
    // for it — but the badge follows the SITE language, which the model has no business
    // choosing and the server cannot know. So the language rides the request instead.
    //
    // This is the only test on that link. The server side reads req.body.stampLang and is
    // covered by unit tests, but "the browser actually sends it" is a claim only a real
    // page can make — and its failure is the quiet kind: the request still succeeds, the
    // render still happens, and a German agent's disclosure comes back in English.
    await page.addInitScript(() => localStorage.setItem('selectedLanguage', 'german'));

    /** @type {string[]} */
    const bodies = [];
    await page.route('**/api/chat', (route) => {
      bodies.push(route.request().postData() || '');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'ok', memories: { stores: [], forgets: [] } }),
      });
    });

    await page.goto('/ai-designer.html');
    const input = page.locator('#chat-input');
    await expect(input).toBeVisible();
    await input.fill('stage this and label it as virtually staged');
    await page.locator('#send-btn').click();

    await expect(page.locator('.message.assistant .message-content').last()).toContainText('ok');
    expect(JSON.parse(bodies[0]).stampLang).toBe('german');
  });

  test('renders a staged image when /api/chat returns one', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'Here is your staged room.', stagedImage: TINY_PNG_DATA_URL }),
      }),
    );

    await page.goto('/ai-designer.html');
    await expect(page.locator('#chat-input')).toBeVisible();

    await page.locator('#chat-input').fill('stage this room');
    await page.locator('#send-btn').click();

    const img = page.locator('.message.assistant .ai-image-container img.ai-generated-image').last();
    await expect(img).toBeAttached();
    await expect(img).toHaveAttribute('src', TINY_PNG_DATA_URL);
  });
});

test.describe('AI Designer — phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is the mobile half of the desktop-only rule');

  // The unit test (test/frontend/ai-designer/ai-designer-gate-mobile.test.js) runs the
  // gate's source against a stubbed matchMedia. What it cannot show is the part that
  // depends on the real page: that <meta name="viewport"> is parsed before the gate, so
  // a real phone reports its device width rather than the ~980px desktop fallback. Get
  // that ordering wrong and the redirect never fires for anybody, with every unit
  // assertion still green.
  test('a Pro user who opens the URL on a phone lands on the home page', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/ai-designer.html');

    await expect(page).toHaveURL(/\/(index\.html)?$/);
    // Really the home page, not a blank document that merely has the right URL.
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('#chat-input')).toHaveCount(0);
  });

  test('and the nav stops offering the tool at all', async ({ page }) => {
    await seedProSession(page);
    await page.goto('/index.html');
    await waitForHomeReady(page);

    await page.locator('.staging-menu__trigger').click();
    await expect(page.locator('.staging-menu__item[href="ai-designer.html"]')).toBeHidden();
  });
});
