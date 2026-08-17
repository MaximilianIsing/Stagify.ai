// Tier: frontend gate behaviour — public/scripts/preview-gate.js, the pre-paint half of
// the public-preview pattern, and the pages that mount it.
//
// A preview page ships in the ANONYMOUS state (pitch visible, tool hidden) so that a
// crawler and a signed-out visitor both get a real page. That default is right for everyone
// except the people who already paid, who would watch the sales pitch paint and then
// disappear a round trip later when /api/auth/me finally answered. This gate closes that
// window by pre-applying the Pro shape from the plan auth.js cached last visit.
//
// Three properties are load-bearing, and all three are silent when broken:
//   • it NEVER navigates. Every redirecting *-gate.js `location.replace`s a visitor with no
//     token; a preview page has a public view that must stay reachable AND indexable. The
//     assertion is a negative, so it is paired with a positive (the class really arms) —
//     "no redirect" passes just as happily on a gate that does nothing at all.
//   • it needs BOTH stored facts. The plan cache alone would pre-paint the tool for someone
//     who signed out in another tab; the token alone cannot tell free from Pro.
//   • it reads its class from its OWN <script> tag. That is what makes one file serve
//     several pages, and it is the part with no equivalent in the per-page gate this
//     replaced — a page that mounts it without `data-pending-class`, or with a class its
//     stylesheet does not define, gets no error and no pre-paint, just the flash back.
//
// Like ai-designer/ai-designer-gate-mobile.test.js this runs the SHIPPED SOURCE with `document`,
// `localStorage` and `setTimeout` passed in as parameters that shadow the globals of the
// same name inside it — the gate is a classic render-blocking IIFE with no exports, so
// there is nothing to import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const gateSource = fs.readFileSync(path.join(PUBLIC, 'scripts', 'preview-gate.js'), 'utf8');

/** Every page that mounts the shared gate, as {file, pendingClass, stylesheet}. */
function mountingPages() {
  const out = [];
  for (const name of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const tag = /<script[^>]*src="[^"]*preview-gate\.js"[^>]*>/.exec(src);
    if (!tag) continue;
    out.push({
      file: name,
      src,
      tag: tag[0],
      pendingClass: /data-pending-class="([^"]+)"/.exec(tag[0])?.[1] ?? null,
      sheets: [...src.matchAll(/href="[^"]*styles\/([a-z0-9-]+\.css)"/g)].map((m) => m[1]),
    });
  }
  return out;
}

/**
 * Run the real gate against stored state.
 *
 * @param {{ token?: string|null, plan?: string|null, throws?: boolean, pendingClass?: string|null }} opts - What localStorage holds, whether reading it throws at all (Safari private mode, a blocked third-party context), and what the mounting <script> tag declares.
 * @returns {{ armed: boolean, classes: string[], timers: number[], fire: () => void, navigated: string[] }}
 */
function runGate({ token = null, plan = null, throws = false, pendingClass = 'ms-pro-pending' } = {}) {
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

  // The mounting <script> element. `getAttribute` returning null for an absent attribute is
  // the case that matters — it is what a page that forgot `data-pending-class` looks like.
  const currentScript = { getAttribute: (a) => (a === 'data-pending-class' ? pendingClass : null) };

  // Anything that reaches for `location` is a bug, and the assertion has to be able to see
  // it rather than blow up on an undefined global — so hand over a recording stand-in.
  const win = { location: { replace: (t) => navigated.push(String(t)), assign: (t) => navigated.push(String(t)) } };

  const run = new Function('window', 'document', 'location', 'localStorage', 'setTimeout', gateSource);
  run(win, { documentElement: html, currentScript }, win.location, storage, (fn, ms) => {
    timers.push(ms);
    fns.push(fn);
    return timers.length;
  });

  return {
    get armed() { return html.classList.contains(pendingClass || '__never'); },
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
  // Signing out clears both, so this is the tampered / half-cleared case. Arming here would
  // pre-paint the studio for somebody who is not signed in at all.
  assert.ok(!runGate({ token: null, plan: 'pro' }).armed);
  assert.ok(!runGate({ token: '', plan: 'pro' }).armed, 'an empty token is no token');
});

test('a token with no cached plan is ignored — it cannot tell free from Pro', () => {
  assert.ok(!runGate({ token: 'tok', plan: null }).armed);
});

test('unreadable storage falls through to the public shape rather than throwing', () => {
  // Safari private mode and blocked third-party contexts both throw on getItem. A gate that
  // throws here takes the whole render-blocking script down with it.
  let g;
  assert.doesNotThrow(() => { g = runGate({ token: 'tok', plan: 'pro', throws: true }); });
  assert.ok(!g.armed, 'the public shape is always safe to show anyone');
});

// ── the property that makes one file serve several pages ─────────────────────

test('the class comes from the mounting <script> tag, not from this file', () => {
  assert.ok(runGate({ token: 'tok', plan: 'pro', pendingClass: 'ai-pro-pending' }).armed);
  const g = runGate({ token: 'tok', plan: 'pro', pendingClass: 'bm-pro-pending' });
  assert.deepEqual(g.classes, ['bm-pro-pending'], 'exactly the class the page asked for');
});

test('a page that forgets data-pending-class gets the public shape, not a crash', () => {
  // Degrading to the pitch is the safe direction: a subscriber sees it for one round trip.
  // Arming some default class instead would be worse — it would hide the pitch on a page
  // whose stylesheet has no rule to reveal the tool, leaving a blank studio.
  let g;
  assert.doesNotThrow(() => { g = runGate({ token: 'tok', plan: 'pro', pendingClass: null }); });
  assert.deepEqual(g.classes, [], 'nothing armed');
  assert.deepEqual(g.timers, [], 'and nothing scheduled to unwind');
});

// ── it never navigates ───────────────────────────────────────────────────────

test('NO path through the gate touches location — that is the whole point', () => {
  // The property that separates a preview page from every gated one. It is asserted across
  // the full input space rather than on one case, because the redirect would come back as a
  // single branch, and it is paired with the positive above (the class really does arm) so
  // it cannot pass on a gate that does nothing at all.
  for (const opts of [
    { token: null, plan: null },
    { token: 'tok', plan: null },
    { token: 'tok', plan: 'free' },
    { token: 'tok', plan: 'pro' },
    { token: null, plan: 'pro' },
    { token: 'tok', plan: 'pro', throws: true },
    { token: 'tok', plan: 'pro', pendingClass: null },
  ]) {
    const g = runGate(opts);
    g.fire();
    assert.deepEqual(g.navigated, [], `gate navigated for ${JSON.stringify(opts)}`);
  }
});

test('the source contains no navigation at all, timers included', () => {
  // The run above can only see paths its inputs reach. This one reads the file: a redirect
  // added inside a branch no fixture happens to hit would still be a redirect on a page
  // whose entire value is that it does not have one.
  const code = gateSource.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['location.replace', 'location.assign', 'location.href']) {
    assert.ok(!code.includes(banned), `preview-gate.js must never ${banned}`);
  }
});

// ── the timer restores the public page rather than bouncing anyone ───────────

test('the safety timer DROPS the class, the opposite of the redirecting gates', () => {
  // There, a stalled plan check strands a signed-in user on a hidden page, so they redirect.
  // Here the class only ever hides the public page, so dropping it restores what every
  // visitor is allowed to see.
  const g = runGate({ token: 'tok', plan: 'pro' });
  assert.ok(g.armed);
  g.fire();
  assert.ok(!g.armed, 'a stalled plan check must not leave the pitch hidden forever');
  assert.deepEqual(g.navigated, []);
});

// ── the pages that mount it ──────────────────────────────────────────────────

test('every page mounting the gate names a class its own stylesheet defines', () => {
  // The failure this catches is completely silent: a typo in `data-pending-class` arms a
  // class no rule matches, so the gate "works", the attribute looks right, and the
  // subscriber gets the flash back anyway.
  const pages = mountingPages();
  assert.ok(pages.length >= 1, 'no page mounts preview-gate.js — this guard is vacuous');

  for (const page of pages) {
    assert.ok(page.pendingClass, `${page.file} mounts the gate without data-pending-class`);
    const css = page.sheets
      .map((s) => path.join(PUBLIC, 'styles', s))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    assert.ok(
      css.includes('html.' + page.pendingClass),
      `${page.file} arms .${page.pendingClass} but none of its stylesheets rules on it`,
    );
  }
});

test('the gate is render-blocking on every page that mounts it', () => {
  // Deferred, it runs after the paint it exists to beat — and nothing would look wrong
  // except a flash on a fast connection and a long one on a slow connection.
  for (const page of mountingPages()) {
    assert.ok(!/\sdefer[\s>]/.test(page.tag), `${page.file}: the gate must not be deferred`);
    assert.ok(!/\sasync[\s>]/.test(page.tag), `${page.file}: the gate must not be async`);
    assert.ok(!/type="module"/.test(page.tag), `${page.file}: a module is deferred by definition`);
    const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(page.src)?.[1] ?? '';
    assert.ok(head.includes(page.tag), `${page.file}: the gate must be in <head>`);
  }
});
