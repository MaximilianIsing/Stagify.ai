// Tier: frontend gate behaviour — public/scripts/session-class.js and the CSS pair it
// switches on.
//
// The Gallery tab ships hidden, which is right: signed-out is the no-JS default and what a
// crawler should see. The cost was that a signed-in visitor could only be given the tab
// once /api/auth/me answered, so it popped into the middle of the nav a round trip late and
// shoved the links beside it along as it arrived.
//
// Unlike the plan, "is there a session" IS knowable before paint — the bearer token is
// already in localStorage — so this script closes the gap with one class. Three properties
// hold it together, and each fails silently on its own:
//
//   • it arms from the TOKEN only, and never navigates (this is a nav tweak, not a gate);
//   • the CSS must beat `.hidden` (display:none!important) yet still LOSE to the phone
//     rule, because the gallery is desktop-only and gallery-gate.js bounces phones;
//   • every nav-bearing page must load it, or the tab still pops in on the pages that
//     were missed — the exact drift the shared header suffers from generally.
//
// Like the other classic head scripts this runs the SHIPPED SOURCE with `document` and
// `localStorage` injected as parameters that shadow the globals inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SCRIPT = path.join(PUBLIC, 'scripts', 'session-class.js');
const CSS = path.join(PUBLIC, 'styles', 'styles.css');

const source = fs.readFileSync(SCRIPT, 'utf8');

/**
 * Run the real script against stored state.
 *
 * @param {{ token?: string|null, throws?: boolean }} opts
 * @returns {{ armed: boolean, className: string, navigated: string[] }}
 */
function run({ token = null, throws = false } = {}) {
  let className = 'existing-class';
  const html = { get className() { return className; }, set className(v) { className = v; } };
  /** @type {string[]} */
  const navigated = [];
  const win = { location: { replace: (t) => navigated.push(String(t)), assign: (t) => navigated.push(String(t)) } };
  const storage = {
    getItem: (k) => {
      if (throws) throw new Error('storage unavailable');
      return k === 'stagifyAuthToken' ? token : null;
    },
  };

  const fn = new Function('window', 'document', 'location', 'localStorage', 'setTimeout', source);
  fn(win, { documentElement: html }, win.location, storage, () => 0);
  return {
    armed: className.split(/\s+/).includes('has-session'),
    className,
    navigated,
  };
}

// ── arming ───────────────────────────────────────────────────────────────────

test('a stored token arms the class before paint', () => {
  assert.equal(run({ token: 'tok' }).armed, true);
});

test('no token leaves the markup exactly as it ships', () => {
  const r = run({ token: null });
  assert.equal(r.armed, false);
  assert.equal(r.className, 'existing-class', 'nothing is added for a signed-out visitor or a crawler');
});

test('an empty token is no token', () => {
  assert.equal(run({ token: '' }).armed, false);
});

test('it keeps the classes already on <html>', () => {
  // It appends to className rather than assigning, and other pre-paint scripts
  // (home-reveal.js, aurora-scrollbar.js) write their own classes to the same element.
  assert.match(run({ token: 'tok' }).className, /^existing-class\b/);
});

test('unreadable storage falls back to the shipped markup instead of throwing', () => {
  // A throw aborts a render-blocking script in <head>. The tab simply appears late, which
  // is the behaviour that existed before this script.
  let r;
  assert.doesNotThrow(() => { r = run({ throws: true }); });
  assert.equal(r.armed, false);
});

test('it never navigates', () => {
  // Every other render-blocking script on these pages is a redirect gate. This one only
  // reshapes the nav, and it runs on index.html — a redirect here would be catastrophic
  // and is worth pinning rather than assuming.
  for (const token of ['tok', null, '']) {
    assert.deepEqual(run({ token }).navigated, [], `navigated for token ${JSON.stringify(token)}`);
  }
});

// ── the CSS half ─────────────────────────────────────────────────────────────

test('the stylesheet reveals the tab through `.hidden`, and still hides it on phones', () => {
  const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');

  // `.hidden{display:none!important}` can only be beaten by another !important rule with
  // more specificity, so the reveal must carry !important — and matching `.hidden` in the
  // selector is what makes the rule go inert once the writer removes the class.
  assert.match(
    css,
    /html\.has-session\.site-header\.nav-link\.hidden\[data-nav-gallery\]\{display:inline-block!important\}/,
    'the pre-paint reveal rule is gone — session-class.js now sets a class that does nothing',
  );

  // …which unavoidably also outranks `.desktop-only`, hence the re-hide.
  assert.match(
    css,
    /@media\(max-width:\d+px\)\{html\.has-session\.site-header\.nav-link\.hidden\[data-nav-gallery\]\{display:none!important\}\}/,
    'the phone re-hide is gone — a signed-in phone visitor is now offered a tab whose page redirects them away',
  );
});

// ── every page that has the tab ──────────────────────────────────────────────

test('every page carrying the Gallery tab loads the script, render-blocking', () => {
  // The header is hand-copied onto twelve pages with no partial — the drift this repo has
  // already had. A page with the tab but no script is not broken, just silently back to the
  // late pop-in, which is exactly the kind of miss nobody notices.
  const missing = [];
  for (const name of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    if (!html.includes('data-nav-gallery')) continue;

    const head = html.split('</head>')[0];
    const tag = /<script[^>]*\bsrc="[^"]*session-class\.js"[^>]*>/.exec(head);
    if (!tag) { missing.push(`${name} (no script in <head>)`); continue; }
    if (/\b(defer|async)\b|type="module"/.test(tag[0])) {
      missing.push(`${name} (deferred — it would run after the paint it exists to beat)`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
  // Sanity floor: the sweep found the pages at all.
  const withTab = fs.readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').includes('data-nav-gallery'));
  assert.ok(withTab.length >= 12, `expected the nav-bearing pages, found ${withTab.length}`);
});
