// A throttled LCP harness for the homepage. NOT part of the normal e2e run.
//
//   PERF_LCP=1 npx playwright test e2e/perf-lcp.spec.js --project=chromium
//
// WHY IT IS OPT-IN. It emulates PageSpeed's desktop profile (10,240 Kbps, 40 ms RTT) and
// loads the page five times, so it takes about a minute — too slow for a smoke run, and
// its numbers are a measurement rather than a pass/fail property. Without PERF_LCP it
// skips immediately.
//
// HOW TO READ THE NUMBERS. Do not quote the absolute LCP as if it were PageSpeed's.
// Localhost is HTTP/1.1, so the 6-connection cap exaggerates a 60-file module waterfall
// that HTTP/2 multiplexes on the real origin, and there is no TTFB to speak of. What this
// harness is good for is DELTAS and, above all, the two structural facts it prints, which
// no Lighthouse report will give you:
//
//   gapMs   — LCP render time minus the moment the hero photo finished downloading. This
//             is the JS gate, in milliseconds. While `is-on` was added only by
//             hero-picker.js, the preloaded, fetchpriority=high photo sat downloaded and
//             invisible until the whole document had parsed, five stylesheets had arrived
//             and the module had run. With the class in the markup this should be roughly
//             one frame. It is the cleanest before/after proof of that change there is.
//   videoBeforeLcp — whether background.mp4 started transferring inside the LCP window.
//             1.28 MB on a 1.28 MB/s link is a full second of contention, so this must
//             stay false.
//
// AND CHECK THE ELEMENT. If `element` is not the hero <img>, the LCP number is measuring
// something else and is not comparable to the previous run — see
// test/frontend/lcp-poster-entropy.test.js for the way that happens by accident.

import { test, expect } from '@playwright/test';

const RUNS = Number(process.env.PERF_LCP_RUNS || 5);

/** PageSpeed's desktop lab profile. */
const DESKTOP_THROTTLE = {
  offline: false,
  downloadThroughput: (10 * 1024 * 1024) / 8, // 10 Mbps
  uploadThroughput: (10 * 1024 * 1024) / 8,
  latency: 40,
};

test.describe('homepage LCP (throttled)', () => {
  test.skip(!process.env.PERF_LCP, 'set PERF_LCP=1 to run the throttled perf harness');
  test.skip(({ isMobile }) => isMobile, 'this harness emulates the DESKTOP PageSpeed profile');

  test.setTimeout(180_000);

  test('measures LCP, the JS gate, and video contention', async ({ browser }) => {
    /** @type {Array<{ lcp: number, gapMs: number|null, element: string, videoBeforeLcp: boolean }>} */
    const samples = [];

    for (let run = 0; run < RUNS; run += 1) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();

      // Record LCP from the very first byte — `buffered: true` alone is not enough,
      // because the observer has to exist before the candidate is chosen.
      await p.addInitScript(() => {
        /** @type {any} */ (window).__lcp = null;
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          /** @type {any} */ (window).__lcp = {
            renderTime: last.renderTime || last.startTime,
            size: /** @type {any} */ (last).size,
            element: /** @type {any} */ (last).element
              ? `${/** @type {any} */ (last).element.tagName.toLowerCase()}.${/** @type {any} */ (last).element.className}`
              : '(none)',
            url: /** @type {any} */ (last).url || '',
          };
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });

      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', DESKTOP_THROTTLE);
      // PageSpeed's desktop profile does not throttle the CPU; state it rather than
      // leaving it to whatever the host machine happens to do.
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

      await p.goto('/index.html', { waitUntil: 'load' });
      // LCP is only final once the page stops producing candidates; a short settle is
      // enough here because nothing above the fold loads late by design.
      await p.waitForTimeout(1500);

      const sample = await p.evaluate(() => {
        const lcp = /** @type {any} */ (window).__lcp;
        const res = /** @type {PerformanceResourceTiming[]} */ (
          performance.getEntriesByType('resource')
        );
        const hero = res.find((r) => /example\/[a-z-]+\.webp/.test(r.name) && !/-\d+\.webp/.test(r.name))
          || res.find((r) => /example\//.test(r.name));
        const video = res.find((r) => /background\.mp4/.test(r.name));
        return {
          lcp: lcp ? lcp.renderTime : -1,
          element: lcp ? lcp.element : '(no LCP entry)',
          heroEnd: hero ? hero.responseEnd : null,
          videoStart: video ? video.startTime : null,
          resourceCount: res.length,
          transferred: res.reduce((n, r) => n + (r.transferSize || 0), 0),
        };
      });

      samples.push({
        lcp: Math.round(sample.lcp),
        gapMs: sample.heroEnd === null ? null : Math.round(sample.lcp - sample.heroEnd),
        element: sample.element,
        videoBeforeLcp: sample.videoStart !== null && sample.videoStart < sample.lcp,
        resourceCount: sample.resourceCount,
        transferredKB: Math.round(sample.transferred / 1024),
      });

      await ctx.close();
    }

    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    console.table(samples);
    console.log(
      `median LCP ${median(samples.map((s) => s.lcp))} ms  |  ` +
        `median gap (LCP - hero downloaded) ${median(samples.map((s) => s.gapMs ?? 0))} ms  |  ` +
        `median transferred ${median(samples.map((s) => s.transferredKB))} KB`
    );

    // The only hard assertions, because they are properties rather than timings.
    expect(samples.every((s) => s.element.includes('hp-canvas__img')), 'LCP element drifted off the hero photo: ' + samples.map((s) => s.element).join(', ')).toBe(true);
    expect(samples.every((s) => !s.videoBeforeLcp), 'background.mp4 started transferring inside the LCP window').toBe(true);
  });
});
