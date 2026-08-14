// TEMPORARY — visual check of the exterior result UI. Deleted after the screenshot.
import fs from 'node:fs';
import { test } from '@playwright/test';
import { PRO_ME, seedProSession } from './fixtures.js';

const before = fs.readFileSync('public/media-webp/Homepage/Exterior/Before.webp');
const after = fs.readFileSync('public/media-webp/Homepage/Exterior/After.webp');
const afterUrl = `data:image/webp;base64,${after.toString('base64')}`;

test('shot', async ({ page }) => {
  await seedProSession(page);
  await page.route('**/api/enhance-exterior', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, image: afterUrl, user: PRO_ME.user }),
  }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/exterior-studio.html');
  await page.setInputFiles('#ex-file', { name: 'house.webp', mimeType: 'image/webp', buffer: before });
  await page.check('#ex-clutter');
  await page.click('#ex-enhance');
  await page.waitForSelector('#ex-result:visible');
  await page.waitForTimeout(600);
  await page.locator('.ex-result__head').screenshot({ path: process.env.SHOT_PATH });
});
