// i18n MutationObserver re-entrancy — the one thing a unit test cannot prove.
//
// language-loader.js watches document.body and re-runs the whole translation pass when
// a node carrying [data-lang*] is added. That pass sets innerHTML on every
// [data-lang-html] element, which is itself a childList mutation of the watched
// subtree — so a translated value containing a data-lang makes the callback see its own
// output as new work and re-apply forever, freezing the tab in an infinite microtask
// loop. The fix is one line (`observer.takeRecords()` after the pass).
//
// The unit guard (test/frontend/language-loader-observer.test.js) can only scan for that
// call; whether draining actually stops the feedback needs a real DOM and a real
// MutationObserver, which is what this does.
//
// No pack ships a nested data-lang, so the hazard is served here deliberately: the
// English pack is intercepted and one [data-lang-html] value is rewritten to contain a
// [data-lang] span. That is exactly the edit a translator could make.
//
// CIRCUIT BREAKER: without the fix this loop never yields, so page.evaluate would hang
// and the test would fail by timeout — slow and vague. Instead an init script wraps the
// innerHTML setter, counts writes to [data-lang-html] elements, and after a threshold
// stops writing and raises a flag. Not writing queues no further mutation records, so
// the runaway terminates itself, the page stays responsive, and the failure is a clean
// assertion rather than a timeout.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { stubAnalytics } from './fixtures.js';

// A [data-lang-html] key that exists on index.html, and a [data-lang] key to nest in it.
const HTML_KEY = ['home', 'designer', 'subtitle'];
const NESTED_HTML = '<span data-lang="home.designer.title">nested</span>';

// index.html carries 19 [data-lang-html] elements, so one full pass writes ~19. The
// breaker sits far above a handful of legitimate passes and far below "forever".
const BREAKER = 400;

test.describe('i18n observer re-entrancy', () => {
  test('a translated value nesting a data-lang does not re-trigger the pass forever', async ({ page }) => {
    await stubAnalytics(page);

    await page.addInitScript((limit) => {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (!desc || !desc.set) return; // nothing to instrument; the assertions will say so
      window.__langHtmlWrites = 0;
      window.__runaway = false;
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(value) {
          if (this.hasAttribute && this.hasAttribute('data-lang-html')) {
            window.__langHtmlWrites += 1;
            if (window.__langHtmlWrites > limit) {
              // Stop writing: no write, no new mutation record, so the loop unwinds
              // and the page survives to be asserted against.
              window.__runaway = true;
              return;
            }
          }
          desc.set.call(this, value);
        },
      });
    }, BREAKER);

    // Serve a pack whose rich-text value nests a translated element.
    const pack = JSON.parse(fs.readFileSync('public/languages/english.json', 'utf8'));
    const leaf = HTML_KEY[HTML_KEY.length - 1];
    const parent = HTML_KEY.slice(0, -1).reduce((o, k) => o[k], pack);
    expect(parent[leaf], 'the probe key must exist in the pack').toBeTruthy();
    parent[leaf] = NESTED_HTML;

    await page.route('**/languages/english.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pack) }),
    );

    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('language-loaded'));

    // The initial pass runs before the observer is installed, so kick it explicitly
    // rather than relying on whatever else the page happens to insert.
    const baseline = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.setAttribute('data-lang', 'home.designer.title');
      document.body.appendChild(probe);
      return window.__langHtmlWrites;
    });

    // Let the observer callback (and anything it would trigger) run to completion.
    await page.waitForTimeout(1000);

    const { writes, runaway } = await page.evaluate(() => ({
      writes: window.__langHtmlWrites,
      runaway: window.__runaway,
    }));

    expect(
      runaway,
      'the observer re-applied translations without bound — its own innerHTML writes are re-triggering it',
    ).toBe(false);
    expect(writes).toBeLessThan(BREAKER);

    // The nested value really was applied, so the hazard was genuinely exercised and
    // the assertion above is not passing because nothing happened.
    expect(writes, 'the observer must have run at least one pass after the probe insert')
      .toBeGreaterThan(baseline);
    await expect(page.locator('[data-lang-html="home.designer.subtitle"] [data-lang]')).toHaveCount(1);

    // And the page is still alive — a frozen tab cannot answer this.
    await expect(page.locator('body')).toBeVisible();
  });
});
