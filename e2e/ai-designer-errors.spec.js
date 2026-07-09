// AI Designer — error paths (the counterpart to ai-designer.spec.js's happy path).
// The client must never hang or crash on a failed /api/chat: a server error surfaces a
// retryable assistant bubble, Retry actually re-sends and can recover, and a non-retryable
// auth failure (403) shows NO Retry button. Every /api/chat is intercepted, so there is no
// real AI call and no cost; we assert on the DOM the client renders.
import { test, expect } from '@playwright/test';
import { seedProSession } from './fixtures.js';

test.describe('AI Designer — error handling', () => {
  test.beforeEach(async ({ page }) => {
    await seedProSession(page);
  });

  async function sendMessage(page, text) {
    await page.goto('/ai-designer.html');
    const input = page.locator('#chat-input');
    await expect(input).toBeVisible(); // both auth gates passed
    await input.fill(text);
    await page.locator('#send-btn').click();
  }

  test('a 500 from /api/chat renders a retryable assistant error bubble (no crash, no hang)', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server exploded' }) }),
    );

    await sendMessage(page, 'stage my living room');

    // An assistant-styled error bubble appears, carrying a Retry affordance (server errors
    // are classified as retryable). We assert on structure/roles, not exact localized copy.
    const errorBubble = page.locator('.message.assistant', { has: page.locator('.chat-retry-btn') });
    await expect(errorBubble).toBeVisible();
    await expect(page.locator('.chat-retry-btn')).toBeVisible();
    // The input is released again so the user can retry/edit — not stuck in a sending state.
    await expect(page.locator('#chat-input')).toBeEnabled();
  });

  test('Retry re-sends and recovers when the next /api/chat succeeds', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/chat', (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'transient' }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ response: 'Recovered on retry.', memories: { stores: [], forgets: [] } }),
      });
    });

    await sendMessage(page, 'make it cozy');

    const retry = page.locator('.chat-retry-btn');
    await expect(retry).toBeVisible();
    await retry.click();

    await expect(page.locator('.message.assistant .message-content').last()).toContainText('Recovered on retry.');
    expect(calls).toBe(2); // the failed send + the successful retry
  });

  test('a 403 (not Stagify+) shows an error bubble with NO Retry button (retry would not help)', async ({ page }) => {
    await page.route('**/api/chat', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'pro required' }) }),
    );

    await sendMessage(page, 'stage this');

    // The assistant surfaces an error, but an auth failure is deliberately non-retryable.
    await expect(page.locator('.message.assistant .message-content').last()).toBeVisible();
    await expect(page.locator('.chat-retry-btn')).toHaveCount(0);
  });
});
