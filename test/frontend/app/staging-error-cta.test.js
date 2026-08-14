// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/staging-error-cta.js.
//
// The writer that puts the Exterior Studio button under a rejection message. Two things
// here are worth more than they look:
//
// 1. The CLEARING. Six call sites reach showStagingError(); exactly one of them ever
//    wants a button. If this writer did not actively hide the anchor for every other
//    verdict, an EXTERIOR rejection followed by a bad-prompt error would leave "Open the
//    Exterior Studio" sitting under "That prompt can't be used".
// 2. Moving the data-lang KEY, not just the text. applyLanguageToElements() wipes
//    textContent on every [data-lang] node when the language changes, so a label written
//    without moving the key is silently replaced by the OTHER plan's copy — a free
//    account left holding an "Open the Exterior Studio" button aimed at the pricing page.
//
// Exercised against a minimal fake DOM (no jsdom), matching the other island suites. The
// browser-level proof is e2e/stage-reject.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---- Minimal fake DOM ------------------------------------------------------

function makeAnchor() {
  const classes = new Set(['hidden']);
  const attrs = /** @type {Record<string, string>} */ ({ 'data-lang': 'errors.unstageableCta.exteriorOpen' });
  return {
    id: 'staging-error-viewer-cta',
    href: 'exterior-studio.html',
    textContent: 'Open the Exterior Studio',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    get hidden() { return classes.has('hidden'); },
  };
}

/** Install a page with the given plan, and optionally the anchor. */
function mount({ plan, withAnchor = true, pack } = {}) {
  const anchor = withAnchor ? makeAnchor() : null;
  globalThis.document = /** @type {any} */ ({
    getElementById: (id) => (id === 'staging-error-viewer-cta' ? anchor : null),
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: plan === undefined ? undefined : { isProUser: () => plan === 'pro', user: { plan } },
    LanguageSystem: pack ? { getText: (k, fb) => (k in pack ? pack[k] : fb) } : undefined,
  });
  // localizedTarget reads location.pathname; the English root keeps hrefs relative.
  /** @type {any} */ (globalThis).location = { pathname: '/index.html', hash: '' };
  return anchor;
}

const { syncStagingErrorCta } = await import('../../../public/scripts/app/staging-error-cta.js');

const EXTERIOR = { valid: false, code: 'EXTERIOR', reason: 'server English' };

// ---- Painting --------------------------------------------------------------

test('a Stagify+ account gets a button to the Exterior Studio', () => {
  const a = mount({ plan: 'pro' });
  assert.equal(syncStagingErrorCta(EXTERIOR), true);
  assert.equal(a.hidden, false);
  assert.equal(a.href, 'exterior-studio.html');
  assert.equal(a.getAttribute('data-lang'), 'errors.unstageableCta.exteriorOpen');
  assert.equal(a.textContent, 'Open the Exterior Studio');
});

test('a free account gets a button to Stagify+, under the OTHER label and key', () => {
  const a = mount({ plan: 'free' });
  assert.equal(syncStagingErrorCta(EXTERIOR), true);
  assert.equal(a.hidden, false);
  assert.equal(a.href, 'stagify-plus.html');
  assert.equal(a.getAttribute('data-lang'), 'errors.unstageableCta.exteriorUpgrade');
  assert.equal(a.textContent, 'Get Stagify+');
});

test('the two plan states differ in the data-lang KEY, not only in the text', () => {
  // The mutation guard for the wipe trap. A writer that set textContent and left the
  // shipped key in place passes every "the label is right" assertion above and still
  // breaks on the first language switch.
  const pro = mount({ plan: 'pro' });
  syncStagingErrorCta(EXTERIOR);
  const proKey = pro.getAttribute('data-lang');

  const free = mount({ plan: 'free' });
  syncStagingErrorCta(EXTERIOR);
  const freeKey = free.getAttribute('data-lang');

  assert.notEqual(proKey, freeKey, 'each plan must carry its own key, or a repaint swaps the copy');
  assert.notEqual(pro.textContent, free.textContent);
});

test('the label comes from the language pack when there is one', () => {
  const a = mount({ plan: 'pro', pack: { 'errors.unstageableCta.exteriorOpen': 'Außen-Studio öffnen' } });
  syncStagingErrorCta(EXTERIOR);
  assert.equal(a.textContent, 'Außen-Studio öffnen');
});

test('with no LanguageSystem the button still reads in English, never blank', () => {
  const a = mount({ plan: 'free' });
  syncStagingErrorCta(EXTERIOR);
  assert.ok(a.textContent && a.textContent.length > 0);
  assert.equal(a.hidden, false, 'a label-less button would be an unexplained blue rectangle');
});

// ---- Clearing --------------------------------------------------------------

test('every other rejection category hides the button', () => {
  const a = mount({ plan: 'pro' });
  syncStagingErrorCta(EXTERIOR);
  assert.equal(a.hidden, false, 'sanity: it was up');

  for (const code of ['FOOD', 'PERSON_PORTRAIT', 'ANIMAL', 'DOCUMENT', 'VEHICLE', 'UNRELATED_OBJECT', 'UNSTAGEABLE']) {
    syncStagingErrorCta(EXTERIOR);
    assert.equal(syncStagingErrorCta({ valid: false, code }), false, `${code} must not keep a CTA`);
    assert.equal(a.hidden, true, `${code} left a stale CTA on screen`);
  }
});

test('a null verdict — the panel closing, or a non-rejection error — hides the button', () => {
  // hideStagingError() passes null, and it is reached from the retry button, the daily
  // limit teardown and every fresh upload.
  const a = mount({ plan: 'pro' });
  syncStagingErrorCta(EXTERIOR);
  assert.equal(syncStagingErrorCta(null), false);
  assert.equal(a.hidden, true);
  assert.equal(syncStagingErrorCta(undefined), false);
  assert.equal(a.hidden, true);
});

test('an anonymous page state still resolves to the upgrade button, not a crash', () => {
  const a = mount({ plan: undefined });
  assert.equal(syncStagingErrorCta(EXTERIOR), true);
  assert.equal(a.href, 'stagify-plus.html');
});

test('a page without the anchor is a no-op, not a throw', () => {
  // Only index.html ships this markup; the module must survive being imported anywhere.
  mount({ plan: 'pro', withAnchor: false });
  assert.equal(syncStagingErrorCta(EXTERIOR), false);
  assert.equal(syncStagingErrorCta(null), false);
});

// ---- The shipped markup ----------------------------------------------------

test('index.html ships the anchor hidden, as a link, with a key the English pack has', () => {
  // Derived from the shipped page rather than restated here, so page and writer cannot
  // agree with this test while disagreeing with each other.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const m = html.match(/<a\s[^>]*id="staging-error-viewer-cta"[^>]*>/);
  assert.ok(m, 'index.html must ship #staging-error-viewer-cta as an <a>');
  const tag = m[0];

  assert.match(tag, /class="[^"]*\bhidden\b[^"]*"/, 'it must ship hidden — most rejections have no hand-off');
  assert.match(tag, /class="[^"]*\bstaging-limit-viewer__cta\b[^"]*"/, 'it must reuse the panel CTA class that stops .btn stretching it below 480px');
  assert.match(tag, /href="/, 'a no-JS visitor must still get a real link');
  assert.ok(!/\bplus-cta\b/.test(tag), 'plus-cta is intercepted by plus-cta-auth.js for signed-OUT users; everyone here is signed in');

  const keyMatch = tag.match(/data-lang="([^"]+)"/);
  assert.ok(keyMatch, 'it must ship a data-lang key');
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'languages', 'english.json'), 'utf8'));
  const value = keyMatch[1].split('.').reduce((o, k) => (o == null ? o : o[k]), /** @type {any} */ (pack));
  assert.equal(typeof value, 'string', `english.json has no ${keyMatch[1]}`);
});

test('index.html wraps the panel buttons in the row that lets them wrap', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // Between the panel's own id and its CTA anchor, so the row is proven to wrap THIS
  // panel's buttons rather than merely to exist somewhere on the page.
  const from = html.indexOf('id="staging-error-viewer"');
  const to = html.indexOf('id="staging-error-viewer-cta"');
  assert.ok(from > -1 && to > from, 'the CTA must live inside the rejection panel');
  assert.match(html.slice(from, to), /staging-limit-viewer__actions/, 'the button sits in the centred flex row');

  // No retry button beside it. "Upload Another" (#new-upload) is in the viewer header
  // and stays live behind this panel, so a retry here was the same action twice — and a
  // reviewer re-adding one would be re-adding the duplication, not fixing an omission.
  assert.ok(!html.includes('staging-error-retry-btn'), 'the rejection panel must not regrow a retry button');
  assert.ok(html.includes('id="new-upload"'), 'and the header control it defers to must still exist');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'styles.css'), 'utf8');
  assert.match(css, /\.staging-limit-viewer__actions\s*\{/, 'and the row needs its rule, or they stack full-width');
});
