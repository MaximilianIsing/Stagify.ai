// Tier: markup drift guard — the blog's own footer (Home · Blog · Guides · About ·
// Contact · ©), across the hub and all fifteen articles.
//
// WHY THIS EXISTS
// The same argument as test/frontend/site-footer-parity.test.js, one directory over.
// lib/i18n/render-page.js is a pure string transform over static English HTML, so a
// footer built by client-side JS would never be server-side translated — the markup
// has to be literal in every file, hand-copied sixteen times, and the only thing
// standing between that and drift is a test. The shared site footer got its guard
// only AFTER it had drifted (four pages shipping an untranslated footer to eleven
// locales). The blog footer had no guard at all; this is that guard, written before
// the drift rather than after it.
//
// It is also load-bearing for SEO now. /about had exactly one inbound link on the
// whole site — the shared footer — and the blog, the most crawled surface here,
// linked to it zero times. The About link added to this row is those sixteen inbound
// links. If it silently disappears from a file or two, nothing else would notice.
//
// Whitespace is collapsed before comparing, so a re-indent is not a failure; every
// attribute, href, key and text node is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = path.join(ROOT, 'public', 'blog');
const PACKS = path.join(ROOT, 'public', 'languages');

/** The link keys the row must carry, in order. */
const KEYS = [
  'navigation.home',
  'navigation.blog',
  'navigation.guides',
  'navigation.about',
  'navigation.contactUs',
];

/** @returns {{ name: string, footer: string }[]} every blog page's footer, CRLF normalized. */
function blogFooters() {
  return fs.readdirSync(BLOG)
    .filter((f) => f.endsWith('.html'))
    .map((name) => {
      const html = fs.readFileSync(path.join(BLOG, name), 'utf8').replace(/\r\n/g, '\n');
      const m = html.match(/<footer class="blog-footer">[\s\S]*?<\/footer>/);
      assert.ok(m, `${name} has no .blog-footer`);
      return { name, footer: m[0].replace(/\s+/g, ' ').trim() };
    });
}

/** Resolve a dot-path key against a parsed pack. @param {any} pack @param {string} key */
function resolve(pack, key) {
  return key.split('.').reduce((cur, part) => (cur == null ? cur : cur[part]), pack);
}

test('every blog page carries the identical footer', () => {
  const footers = blogFooters();
  assert.equal(footers.length, 16, 'expected the hub plus fifteen articles');

  const [first, ...rest] = footers;
  for (const { name, footer } of rest) {
    assert.equal(footer, first.footer, `${name}'s footer has drifted from ${first.name}'s`);
  }
});

test('the footer links the five pages it is supposed to, in order', () => {
  const { footer } = blogFooters()[0];
  const found = [...footer.matchAll(/data-lang="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(found, KEYS, 'the footer link set or its order changed');

  // The hrefs are root-absolute so they survive both /blog/<slug>.html and the
  // locale prefixes rewriteAnchors() adds.
  for (const href of ['/', '/blog/', '/guides.html', '/about.html', '/contact.html']) {
    assert.ok(footer.includes(`href="${href}"`), `the footer no longer links ${href}`);
  }
  assert.ok(/class="footer-year"/.test(footer), 'the © year span is gone');
});

test('every footer key is translated in all eleven packs', () => {
  // A link keyed to a missing string renders its English fallback on ten locales,
  // which is exactly the failure the site footer guard was written after.
  const files = fs.readdirSync(PACKS).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 11, 'expected the eleven language packs');

  for (const file of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(PACKS, file), 'utf8'));
    for (const key of KEYS) {
      assert.equal(typeof resolve(pack, key), 'string', `${file} does not define ${key}`);
    }
  }
});
