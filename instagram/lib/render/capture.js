// Chromium-based capture. One browser and one asset server per renderer, reused across
// every slide of a carousel and every frame of a reel.
//
// The three checks in shot() exist because each has a silent failure mode:
//   * document.fonts.check  — a missing woff2 renders the post in the system stack and
//     nothing else complains. The post just looks subtly wrong forever.
//   * the 4xx/failed-request tally — a mistyped image path paints an empty box, and a
//     poster with a hole in it is worse than a crash.
//   * the dimension assert — a template that overflows silently produces the wrong
//     aspect, which Instagram then crops for you.
import { chromium } from '@playwright/test';
import { startAssetServer } from './assets-server.js';

const FONT_PROBE = '700 100px Inter';

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

/**
 * Every root-relative image the document asks for, read out of the source rather than the
 * DOM.
 *
 * This exists because of a real failure: a `url("...")` inside a double-quoted `style`
 * attribute closes the attribute early, so the browser never requests the image and paints
 * an empty box. There is no 404 and no console error to catch, and the poster renders
 * looking deliberate. Comparing what the markup asked for against what Chromium actually
 * fetched is the only check that sees it.
 *
 * Fonts are excluded on purpose: @font-face carries unicode-range, so Chromium correctly
 * fetches only the subsets it paints and the rest would look like false misses.
 * @param {string} html
 */
function expectedImageUrls(html) {
  const found = new Set();
  for (const m of html.matchAll(/url\(\s*['"]?(\/[^'")\s]+)['"]?\s*\)/g)) found.add(m[1]);
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](\/[^"']+)["']/gi)) found.add(m[1]);
  return [...found].filter((u) => IMAGE_EXT.test(u));
}

/**
 * @param {{ rootDir: string, scale?: number, headless?: boolean }} options
 */
export async function createRenderer({ rootDir, scale = 2, headless = true }) {
  const assets = await startAssetServer(rootDir);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ deviceScaleFactor: scale });
  let counter = 0;

  /**
   * Render one HTML document to a PNG buffer.
   * @param {string} html
   * @param {{ width: number, height: number, id?: string, settleMs?: number }} opts
   * @returns {Promise<Buffer>} PNG at width*scale x height*scale
   */
  async function shot(html, { width, height, id, settleMs = 0 }) {
    const pageId = id ?? `p${counter++}`;
    const url = assets.put(pageId, html);
    const page = await context.newPage();

    /** @type {string[]} */
    const broken = [];
    /** @type {Set<string>} */
    const requested = new Set();
    page.on('request', (req) => {
      try {
        requested.add(new URL(req.url()).pathname);
      } catch { /* data: and blob: URLs have no pathname; they are never the ones we check */ }
    });
    page.on('response', (res) => {
      if (res.status() >= 400) broken.push(`${res.status()} ${res.url()}`);
    });
    page.on('requestfailed', (req) => {
      broken.push(`failed ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`);
    });

    try {
      await page.setViewportSize({ width, height });
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      const fontLoaded = await page.evaluate((probe) => document.fonts.check(probe), FONT_PROBE);
      if (!fontLoaded) {
        throw new Error(
          'Inter did not load. The post would render in a fallback face and look off-brand. ' +
          'Check that /public/fonts/*.woff2 resolve and that brand-css.js rewrote the URLs.',
        );
      }
      if (broken.length) {
        throw new Error(`Assets failed to load:\n  ${broken.join('\n  ')}`);
      }

      const neverFetched = expectedImageUrls(html).filter((u) => !requested.has(u));
      if (neverFetched.length) {
        throw new Error(
          `The markup asks for images Chromium never requested:\n  ${neverFetched.join('\n  ')}\n` +
          'This is not a 404. The declaration was malformed, so it painted nothing silently. ' +
          'Check for a quote that closed a style attribute early.',
        );
      }

      // A photo element that laid out at zero size. The image loaded fine, so nothing above
      // fires, and the poster renders a clean empty panel that looks like a design choice.
      // This happens whenever a card lands in a flex or grid parent without a height, and
      // it has already shipped once. Cheap to check, invisible otherwise.
      const collapsed = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
        .filter((el) => getComputedStyle(el).backgroundImage !== 'none')
        .map((el) => ({
          rect: el.getBoundingClientRect(),
          where: `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`,
        }))
        .filter(({ rect }) => rect.width < 2 || rect.height < 2)
        .map(({ where }) => where));
      if (collapsed.length) {
        throw new Error(
          `Element(s) with a background image laid out at zero size:\n  ${collapsed.join('\n  ')}\n` +
          'The photo would be invisible. Usually a card in a flex or grid parent with no height.',
        );
      }

      // Catch a template that overflows its frame before we bake it into a JPEG.
      const overflow = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
      }));
      if (overflow.w > width || overflow.h > height) {
        throw new Error(
          `Content overflows the frame: content is ${overflow.w}x${overflow.h}, frame is ${width}x${height}. ` +
          'Something is too long for its slot.',
        );
      }

      // Text that is actually cut off. Playbook rule 9, which nothing else enforces:
      // html, body and .frame all set overflow:hidden, so a headline one word too long is
      // silently trimmed with no error, no failed request and no scrollbar.
      //
      // Two distinct cases, and the predicate matters. Comparing scrollHeight to
      // clientHeight alone is WRONG: a tight line-height makes Inter's line box exceed the
      // element by a couple of pixels on every headline in the library, and with
      // `overflow: visible` that spills harmlessly rather than clipping. Only a clipping
      // container can clip.
      const clipped = await page.evaluate((frame) => {
        const out = [];
        const describe = (el) => {
          const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
          return `${el.tagName.toLowerCase()}.${el.className || '(no class)'}: "${text}"`;
        };

        for (const el of document.querySelectorAll('*')) {
          const text = el.textContent?.trim();
          if (!text) continue;

          // 1. The element clips its own content.
          const style = getComputedStyle(el);
          const clips = style.overflow !== 'visible' && style.overflow !== '';
          if (clips && el.children.length <= 1
              && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
            out.push(`${describe(el)} (cut off by its own box)`);
            continue;
          }

          // 2. A leaf text box sitting outside the frame, cut off by an ancestor. This is
          //    the common failure: copy too long for a fixed-height poster.
          if (el.children.length === 0) {
            const r = el.getBoundingClientRect();
            if (r.width && r.height
                && (r.left < -1 || r.top < -1 || r.right > frame.w + 1 || r.bottom > frame.h + 1)) {
              out.push(`${describe(el)} (outside the frame)`);
            }
          }
        }
        return out;
      }, { w: width, h: height });

      if (clipped.length) {
        throw new Error(
          `Text is cut off:\n  ${clipped.join('\n  ')}\n` +
          'Shorten the copy. Do not shrink the type below the template scale.',
        );
      }

      if (settleMs) await page.waitForTimeout(settleMs);
      return await page.screenshot({ type: 'png' });
    } finally {
      await page.close();
    }
  }

  /**
   * Render one document many times, mutating CSS custom properties between shots. Used by
   * the reel renderer: setContent once, pay the image decode once, then walk the timeline.
   * @param {string} html
   * @param {{ width: number, height: number, frames: number, vars: (t: number) => Record<string, string> }} opts
   * @returns {Promise<Buffer[]>}
   */
  async function shotSequence(html, { width, height, frames, vars }) {
    const url = assets.put(`seq${counter++}`, html);
    const page = await context.newPage();
    /** @type {Buffer[]} */
    const out = [];
    try {
      await page.setViewportSize({ width, height });
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      for (let i = 0; i < frames; i += 1) {
        const t = frames === 1 ? 0 : i / (frames - 1);
        await page.evaluate((entries) => {
          for (const [name, value] of entries) {
            document.documentElement.style.setProperty(name, value);
          }
        }, Object.entries(vars(t)));
        out.push(await page.screenshot({ type: 'png' }));
      }
      return out;
    } finally {
      await page.close();
    }
  }

  async function close() {
    await context.close();
    await browser.close();
    await assets.close();
  }

  return { shot, shotSequence, close, origin: assets.origin };
}
