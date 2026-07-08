// AI Designer — happy-path smoke. Drives the real /ai-designer.html in Chromium with
// the model call (/api/chat) intercepted, so there is no real AI call and no cost.
// The client branches on the RESPONSE content-type, so a plain JSON body takes the
// non-SSE path — we assert the assistant bubble renders end-to-end.
import { test, expect } from '@playwright/test';
import { TINY_PNG_DATA_URL, seedProSession } from './fixtures.js';

test.describe('AI Designer — happy path', () => {
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
