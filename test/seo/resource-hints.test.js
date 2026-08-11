// Drift guards for three resource hints that are copy-pasted across every page, and so
// drift silently. None of them changes what a page looks like, which is exactly why a
// missing one survives review indefinitely.
//
// 1. LANGUAGE-SWITCHER FLAGS. The switcher ships 12 flag SVGs: one visible current flag
//    plus 11 dropdown entries that are not displayed until the menu opens. index.html
//    lazy-loaded its 11; the other seven marketing pages carried byte-identical markup
//    with no `loading` attribute at all, so each made 11 extra image requests on load for
//    a closed dropdown, competing with the LCP image. The visible flag must stay EAGER —
//    lazy-loading it would delay a flag that is on screen immediately.
//
// 2. ANALYTICS PRECONNECT. scripts/gtag.js injects the googletagmanager.com loader at
//    runtime, so that origin appears nowhere in the markup and the preload scanner cannot
//    discover it. A `preconnect` is the only way to warm DNS/TCP/TLS before the deferred
//    script runs. Only index.html had one.
//
// 3. LANGUAGE-PACK PRELOAD. The English sources preload `languages/english.json`. That is
//    correct for the static English pages and WRONG for every localized render, which
//    fetches its own pack — see the localized assertion in test/i18n/, and the rewrite in
//    lib/i18n/render-page.js. Here we only pin the English side: the tag must name
//    english.json, so a future edit can't point the static pages at a locale pack.
//
// Comments are stripped before scanning, so commented-out markup cannot satisfy a check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const GTM_ORIGIN = 'https://www.googletagmanager.com';

/**
 * faq.html loads gtag but is a zero-delay meta-refresh stub: it unloads before a warmed
 * connection could be reused, so a preconnect there would hold a socket for nothing.
 * @type {string[]}
 */
const PRECONNECT_EXEMPT = ['faq.html'];

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Every served HTML page, repo-relative with POSIX separators. */
const PAGES = walk(PUBLIC).map((p) => path.relative(PUBLIC, p).split(path.sep).join('/')).sort();
const read = (page) => stripComments(fs.readFileSync(path.join(PUBLIC, page), 'utf8'));

/** Every `<img>` tag whose src is a switcher flag. */
function flagImgs(html) {
  return (html.match(/<img\b[^>]*media-webp\/flags\/[^>]*>/gi) || []);
}

test('the page inventory is non-empty', () => {
  assert.ok(PAGES.length >= 30, `expected 30+ HTML pages, found ${PAGES.length}`);
});

test('switcher dropdown flags are lazy and the visible flag is eager', () => {
  const withSwitcher = PAGES.filter((p) => flagImgs(read(p)).length > 0);
  assert.ok(withSwitcher.length >= 8, `expected 8+ pages with a switcher, found ${withSwitcher.length}`);

  for (const page of withSwitcher) {
    const imgs = flagImgs(read(page));
    const visible = imgs.filter((t) => /class="[^"]*\blang-switch__flag\b/.test(t));
    const dropdown = imgs.filter((t) => !/class="[^"]*\blang-switch__flag\b/.test(t));

    assert.equal(visible.length, 1, `${page}: expected exactly 1 visible .lang-switch__flag, got ${visible.length}`);
    assert.ok(
      !/loading\s*=\s*"lazy"/i.test(visible[0]),
      `${page}: the VISIBLE .lang-switch__flag must stay eager — it paints immediately, so lazy-loading `
        + 'it only delays it.',
    );

    assert.ok(dropdown.length >= 10, `${page}: expected 10+ dropdown flags, got ${dropdown.length}`);
    for (const tag of dropdown) {
      assert.match(
        tag, /loading\s*=\s*"lazy"/i,
        `${page}: a dropdown flag is missing loading="lazy" — ${tag}. The dropdown is closed on load, so `
          + 'these 11 requests compete with the LCP image for nothing.',
      );
    }
  }
});

test('every page loading gtag.js preconnects to the analytics origin', () => {
  const gtagPages = PAGES.filter((p) => /<script[^>]+src="\/?scripts\/gtag\.js"/i.test(read(p)));
  assert.ok(gtagPages.length >= 20, `expected 20+ gtag pages, found ${gtagPages.length}`);

  for (const page of gtagPages) {
    if (PRECONNECT_EXEMPT.includes(page)) continue;
    const html = read(page);
    assert.ok(
      new RegExp(`<link\\b[^>]*rel="preconnect"[^>]*href="${GTM_ORIGIN}"`, 'i').test(html)
        || new RegExp(`<link\\b[^>]*href="${GTM_ORIGIN}"[^>]*rel="preconnect"`, 'i').test(html),
      `${page} loads gtag.js but has no preconnect to ${GTM_ORIGIN}. That origin is injected by JS, so `
        + 'the preload scanner never sees it and the handshake cannot start early without this hint.',
    );
  }
});

test('the exempt stub really is a redirect stub', () => {
  // Guards the exemption itself: if faq.html ever becomes a real page, it should be
  // required to carry the preconnect like everything else.
  for (const page of PRECONNECT_EXEMPT) {
    assert.ok(PAGES.includes(page), `${page} is exempt from the preconnect rule but no longer exists.`);
    assert.match(
      read(page), /<meta\s+http-equiv="refresh"\s+content="0;/i,
      `${page} is exempt from the preconnect rule only because it redirects immediately. It no longer `
        + 'does, so either restore the redirect or drop the exemption and add the preconnect.',
    );
  }
});

test('static English pages preload the English language pack', () => {
  const preloaders = PAGES.filter((p) => /<link\b[^>]*rel="preload"[^>]*languages\//i.test(read(p)));
  assert.ok(preloaders.length >= 7, `expected 7+ pages preloading a language pack, found ${preloaders.length}`);

  for (const page of preloaders) {
    const tag = read(page).match(/<link\b[^>]*rel="preload"[^>]*languages\/[^>]*>/i)[0];
    assert.match(
      tag, /href="languages\/english\.json"/,
      `${page}: the static English page must preload english.json — ${tag}. Localized renders get this `
        + 'href rewritten to their own pack by lib/i18n/render-page.js; the source must stay English.',
    );
  }
});
