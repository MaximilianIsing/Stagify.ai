// Every page's document outline starts at exactly one <h1>.
//
// WHY A TEST AND NOT A LINT RULE: nothing in the pipeline reads these pages as
// documents. `ai-designer.html` shipped with **no** h1 at all — its outline began
// at h2 — and so did `guides.html`, an indexed marketing page. Neither breaks a
// render, a type-check, or a browser, so both survived every gate we have. The
// cost is quiet: a screen-reader user's "jump to heading 1" finds nothing, and a
// crawler gets no primary heading to weigh against the <title>.
//
// The rule is applied to EVERY page rather than just the indexable ones, because
// the assistive-tech half applies to the internal pages too. The three exemptions
// below are deliberate and each carries its reason — and the list is asserted to be
// exact, so a page that grows a proper h1 must be removed from it rather than
// silently sitting there as a permanent excuse.
//
// Nested `public/` HTML (the blog) is covered too: it is the same crawlable surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/**
 * Pages that legitimately have no single h1. Keyed by path relative to public/,
 * with the reason — anything not listed must have exactly one.
 */
const EXEMPT = new Map([
  ['faq.html', 'redirect stub: meta-refresh + canonical to index.html#faq, no content of its own'],
  ['pro.html', 'redirect stub: meta-refresh + canonical to stagify-plus.html, no content of its own'],
  ['admin.html', 'two mutually-exclusive view shells (#adm-login / #adm-dash) — only one is ever rendered'],
]);

function htmlPages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlPages(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(PUBLIC, file).replace(/\\/g, '/');
}

/** Every `<h1 …>…</h1>` on the page, as its inner markup. */
function h1s(html) {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1]);
}

const PAGES = htmlPages(PUBLIC).map((file) => ({ rel: relative(file), html: fs.readFileSync(file, 'utf8') }));

test('the scan actually finds the pages it claims to check', () => {
  // A broken walk would make every assertion below vacuously pass.
  assert.ok(PAGES.length >= 15, `expected the public pages, found ${PAGES.length}`);
  for (const name of ['index.html', 'ai-designer.html', 'masking-studio.html', 'guides.html']) {
    assert.ok(PAGES.some((p) => p.rel === name), `${name} must be in the scan`);
  }
});

test('every page has exactly one <h1>', () => {
  const wrong = PAGES
    .filter((p) => !EXEMPT.has(p.rel))
    .map((p) => ({ page: p.rel, count: h1s(p.html).length }))
    .filter((r) => r.count !== 1);

  assert.deepEqual(
    wrong,
    [],
    'each of these pages needs exactly one <h1> (or an entry in EXEMPT with a reason)',
  );
});

test('the h1 is not empty — a blank one satisfies a counter but nothing else', () => {
  const blank = PAGES
    .filter((p) => !EXEMPT.has(p.rel))
    .filter((p) => h1s(p.html).some((inner) => !inner.replace(/<[^>]*>/g, '').trim()));

  assert.deepEqual(blank.map((p) => p.rel), [], 'these pages have an <h1> with no text in it');
});

test('the exemption list is exact — no page sits on it that now has an h1', () => {
  // Keeps the list honest: fixing a page forces its removal here, so the list can
  // only ever shrink by accident, never grow by neglect.
  const stale = [];
  for (const [rel, reason] of EXEMPT) {
    const page = PAGES.find((p) => p.rel === rel);
    assert.ok(page, `EXEMPT lists ${rel}, which no longer exists — drop it`);
    assert.ok(reason.length > 20, `EXEMPT[${rel}] needs a real reason, not a placeholder`);
    if (h1s(page.html).length === 1) stale.push(rel);
  }
  assert.deepEqual(stale, [], 'these pages now have exactly one h1 — remove them from EXEMPT');
});

test("the AI Designer's h1 is the hidden one, and survives the chat clearing itself", () => {
  // The page is a full-height chat app: its h1 is visually hidden because there is
  // no title bar to put one in. The obvious alternative — reusing the chat's
  // "AI Designer" empty-state heading — is wrong, because chat-messages.js REMOVES
  // that node on the first message, which would take the page's only h1 with it.
  const page = PAGES.find((p) => p.rel === 'ai-designer.html');
  const [inner] = h1s(page.html);

  assert.ok(page.html.includes('<h1 class="sr-only"'), 'the h1 is the visually-hidden one');
  assert.ok(!/class="empty-state"[\s\S]{0,400}?<h1/.test(page.html),
    'the h1 must not live inside .empty-state — that node is removed on the first message');
  assert.match(inner, /AI Designer/, 'and it names the page');
});

test('a translated h1 uses a key that exists in the English pack', () => {
  // The h1s carry data-lang, so the localized URLs (/es, /fr/…) render a translated
  // one. A typo'd key would silently fall back to the English text and never be
  // translated — invisible in every other test.
  const english = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', 'english.json'), 'utf8'));
  const lookup = (key) => key.split('.').reduce((node, part) => (node == null ? node : node[part]), english);

  const missing = [];
  for (const page of PAGES) {
    for (const match of page.html.matchAll(/<h1\b[^>]*\bdata-lang="([^"]+)"/gi)) {
      if (typeof lookup(match[1]) !== 'string') missing.push(`${page.rel} → ${match[1]}`);
    }
  }

  assert.deepEqual(missing, [], 'these h1 data-lang keys are not in public/languages/english.json');
});
