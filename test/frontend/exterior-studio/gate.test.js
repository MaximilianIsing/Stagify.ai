// Tier: frontend gate behaviour — public/scripts/exterior-studio-gate.js and the three
// CSS rules it exists to switch on.
//
// The Exterior Studio ships in the ANONYMOUS state (pitch visible, tool hidden) so that a
// crawler and a signed-out visitor both get a real page. That default is right for
// everyone except the people who already paid, who watched the sales pitch paint and then
// disappear a round trip later when /api/auth/me finally answered. This gate closes that
// window by pre-applying the Pro shape from the plan auth.js cached last visit.
//
// Two things make it different from the other three gates, and both are load-bearing:
//   • it NEVER navigates. Every other *-gate.js `location.replace`s a visitor with no
//     token; this page has a public view that must stay reachable (and indexable). The
//     no-navigation property is also pinned from the other end, in
//     test/frontend/staging-menu.test.js's data-staging-preview guard.
//   • it needs BOTH stored facts. The plan cache alone would pre-paint the tool for
//     someone who signed out in another tab; the token alone cannot tell free from Pro.
//
// Like ai-designer-gate-mobile.test.js this runs the SHIPPED SOURCE with `document`,
// `localStorage` and `setTimeout` passed in as parameters that shadow the globals of the
// same name inside it — the gate is a classic render-blocking IIFE with no exports, so
// there is nothing to import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = path.join(ROOT, 'public', 'scripts', 'exterior-studio-gate.js');
const PAGE = path.join(ROOT, 'public', 'exterior-studio.html');
const CSS = path.join(ROOT, 'public', 'styles', 'exterior-studio.css');

const gateSource = fs.readFileSync(GATE, 'utf8');

/**
 * Run the real gate against stored state.
 *
 * @param {{ token?: string|null, plan?: string|null, throws?: boolean }} opts - What localStorage holds, or whether reading it throws at all (Safari private mode, a blocked third-party context).
 * @returns {{ armed: boolean, classes: string[], timers: number[], fire: () => void, navigated: string[] }}
 */
function runGate({ token = null, plan = null, throws = false } = {}) {
  /** @type {number[]} */
  const timers = [];
  /** @type {Array<() => void>} */
  const fns = [];
  /** @type {string[]} */
  const navigated = [];

  let className = '';
  const html = {
    get className() { return className; },
    set className(v) { className = v; },
    classList: {
      contains: (c) => className.split(/\s+/).filter(Boolean).includes(c),
      remove: (c) => {
        className = className.split(/\s+/).filter(Boolean).filter((x) => x !== c).join(' ');
      },
    },
  };

  const store = { stagifyAuthToken: token, stagifyPlan: plan };
  const storage = {
    getItem: (k) => {
      if (throws) throw new Error('storage is not available');
      return k in store ? store[k] : null;
    },
  };

  // Anything that reaches for `location` is a bug, and the assertion has to be able to see
  // it rather than blow up on an undefined global — so hand over a recording stand-in.
  const win = { location: { replace: (t) => navigated.push(String(t)), assign: (t) => navigated.push(String(t)) } };

  const run = new Function('window', 'document', 'location', 'localStorage', 'setTimeout', gateSource);
  run(win, { documentElement: html }, win.location, storage, (fn, ms) => {
    timers.push(ms);
    fns.push(fn);
    return timers.length;
  });

  return {
    get armed() { return html.classList.contains('ex-pro-pending'); },
    get classes() { return className.split(/\s+/).filter(Boolean); },
    timers,
    navigated,
    fire: () => fns.forEach((fn) => fn()),
  };
}

// ── who gets the pre-painted Pro shape ───────────────────────────────────────

test('a cached Stagify+ plan plus a token arms the class before paint', () => {
  const g = runGate({ token: 'tok', plan: 'pro' });
  assert.ok(g.armed, 'the subscriber must never see the pitch');
  assert.deepEqual(g.timers, [6000], 'and the stall-safety timer is armed');
});

test('a cached FREE plan changes nothing — the shipped markup is already their page', () => {
  const g = runGate({ token: 'tok', plan: 'free' });
  assert.ok(!g.armed);
  assert.deepEqual(g.timers, [], 'nothing to unwind, so nothing to schedule');
});

test('a stale plan with no token is ignored', () => {
  // Signing out clears both, so this is the tampered / half-cleared case. Arming here
  // would pre-paint the studio for somebody who is not signed in at all.
  assert.ok(!runGate({ token: null, plan: 'pro' }).armed);
  assert.ok(!runGate({ token: '', plan: 'pro' }).armed, 'an empty token is no token');
});

test('a token with no cached plan waits — the first visit is not a guess', () => {
  // Before this shipped nobody had the key, and a token alone cannot distinguish a free
  // account from a paying one. Guessing Pro from mere sign-in would flash the TOOL at
  // every free user, which is a worse trade than the flash being fixed.
  assert.ok(!runGate({ token: 'tok', plan: null }).armed);
});

test('an anonymous visitor — and every crawler — is left with the public markup', () => {
  const g = runGate({ token: null, plan: null });
  assert.ok(!g.armed);
  assert.deepEqual(g.classes, [], 'nothing is added to <html> at all');
});

// ── the properties that make this gate safe on a public page ─────────────────

test('the gate NEVER navigates, in any state', () => {
  // The whole reason this page may carry a render-blocking gate. A redirect here would
  // strand the visitors the public view is written for, and Googlebot with them.
  for (const opts of [
    { token: 'tok', plan: 'pro' },
    { token: 'tok', plan: 'free' },
    { token: null, plan: null },
    { token: null, plan: 'pro' },
  ]) {
    const g = runGate(opts);
    g.fire();
    assert.deepEqual(g.navigated, [], `the gate navigated for ${JSON.stringify(opts)}`);
  }
});

test('the safety timer DROPS the class rather than redirecting', () => {
  // The other gates hide the whole body, so a stalled plan check strands a signed-in user
  // and they bounce out. Here the class only ever hides the PUBLIC page, so the escape is
  // simply to stop hiding it — every visitor is allowed to see what is underneath.
  const g = runGate({ token: 'tok', plan: 'pro' });
  assert.ok(g.armed);
  g.fire();
  assert.ok(!g.armed, 'a stalled plan check must fall back to the page everyone may see');
  assert.deepEqual(g.navigated, []);
});

test('unreadable storage fails to the public shape instead of throwing', () => {
  // A throw here would abort a render-blocking script in <head>.
  let g;
  assert.doesNotThrow(() => { g = runGate({ throws: true }); });
  assert.ok(!g.armed);
});

// ── the pair on the page ─────────────────────────────────────────────────────

test('the page loads the gate render-blocking, and loads no redirecting one', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const head = html.split('</head>')[0];
  const tag = /<script[^>]*\bsrc="scripts\/exterior-studio-gate\.js"[^>]*>/.exec(head);
  assert.ok(tag, 'exterior-studio.html must load the gate in <head>');
  assert.ok(
    !/\b(defer|async)\b|type="module"/.test(tag[0]),
    'deferring the gate puts it after the paint it exists to beat',
  );
});

test('the CSS the class switches on exists, and uses display — never visibility', () => {
  // styles.css's i18n anti-FOUC rule (`body.language-loaded [data-lang] { visibility:
  // visible }`, specificity (0,2,1)) matches every translatable element on this page, so a
  // `visibility: hidden` written here would be silently overridden the moment the language
  // pack lands — the trap home.css documents at length. The class would still be applied,
  // the pitch would still paint, and nothing else would fail.
  const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]*\bex-pro-pending\b[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 2, 'the pre-paint rules are gone — the gate class now does nothing');

  const covered = rules.flatMap(([, sel]) => sel.split(',')).map((s) => s.trim());
  for (const id of ['#ex-features', '#ex-hero-actions', '#ex-tool']) {
    assert.ok(covered.some((s) => s.includes(id)), `${id} is not covered by a pre-paint rule`);
  }

  for (const [, sel, body] of rules) {
    assert.ok(!/visibility\s*:/.test(body), `"${sel.trim()}" uses visibility — the i18n rule outranks it`);
    assert.match(body, /display\s*:/, `"${sel.trim()}" must switch display`);
    // An id in every selector is what beats `.ex-grid[hidden] { display: none }` (0,2,0).
    for (const one of sel.split(',')) {
      assert.match(one, /#/, `"${one.trim()}" has no id, so it ties with the [hidden] rules and loses on source order`);
    }
  }

  assert.match(
    css,
    /html\.ex-pro-pending\s+#ex-tool\[hidden\]\s*\{[^}]*display:\s*grid/,
    'the tool must be revealed THROUGH its shipped `hidden` attribute — the markup still ships anonymous',
  );
});
