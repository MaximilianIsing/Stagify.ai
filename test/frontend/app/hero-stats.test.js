// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/hero-stats.js.
//
// The homepage's two stat pills ("rooms staged", "users served") and the upgrade
// nudge under them.
//
// Two things here are more delicate than they look:
//
//   - THE NUDGE IS FOR EXACTLY ONE AUDIENCE. Signed-in FREE accounts. Showing it to a
//     paying Stagify+ subscriber sells them what they already bought; showing it to a
//     signed-out visitor is noise on a page that is already selling. The predicate has
//     three clauses and every one of them is load-bearing.
//   - THE COUNTS HAVE A LEGACY SHAPE. /api/contact-count answers `usersServed` now and
//     answered `contactCount` + `userCount` before. The fallback is what stops the
//     pills reading zero against an older deploy, and nothing else exercises it.
//
// The pills are animated by count-up.js when it is on the page (window.StagifyHeroStats)
// and written directly when it is not — both paths are covered, because the direct one
// is what runs on any page that skips the animation bundle.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import {
  updateHeroFreeGensLine,
  loadHeroStats,
} from '../../../public/scripts/app/hero-stats.js';

const REAL = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  consoleError: console.error,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.fetch = REAL.fetch;
  globalThis.window = REAL.window;
  console.error = REAL.consoleError;
});

const settle = () => new Promise((r) => setTimeout(r, 5));

/**
 * @param {object} o
 * @param {'out'|'free'|'pro'} [o.session] who is looking at the page
 */
function mount({
  session = 'out',
  hasLine = true,
  hasPills = true,
  langText = null,
  heroStats = null,
  promptBody = { promptCount: 1234 },
  contactBody = { usersServed: 56 },
  promptFails = false,
  contactFails = false,
} = {}) {
  dom = installMaskDom();

  const line = hasLine ? new FakeEl('div') : null;
  const wrap = new FakeEl('div');
  const roomsEl = new FakeEl('span');
  const usersEl = new FakeEl('span');

  dom.doc.getElementById = (id) => {
    if (id === 'hero-free-gens-today') return line;
    if (id === 'hero-stats') return wrap;
    return null;
  };
  // These three strings are copied from hero-stats.js and that is a real weakness: a stub
  // matches on the literal selector, so renaming the class in the module and the markup but
  // NOT here leaves this test green while the live hero shows two blanks. It happened. The
  // browser-level assertion in e2e/index.spec.js is what actually catches it; this stub only
  // exercises the branching around the fetch.
  dom.doc.querySelector = (sel) => {
    if (!hasPills) return null;
    if (sel === '.hp-stat__num[data-stat]') return roomsEl;
    if (sel === '.hp-stat__num[data-stat="roomsStaged"]') return roomsEl;
    if (sel === '.hp-stat__num[data-stat="usersServed"]') return usersEl;
    return null;
  };

  const auth = {
    out: null,
    free: { getToken: () => 'tok', user: { id: 1 }, isProUser: () => false },
    pro: { getToken: () => 'tok', user: { id: 1 }, isProUser: () => true },
  }[session];

  globalThis.window = /** @type {any} */ ({
    StagifyAuth: auth,
    LanguageSystem: langText ? { getText: () => langText } : null,
    StagifyHeroStats: heroStats,
  });

  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));

  globalThis.fetch = /** @type {any} */ (
    async (url) => {
      if (url === '/api/prompt-count') {
        if (promptFails) throw new Error('offline');
        return { json: async () => promptBody };
      }
      if (contactFails) throw new Error('offline');
      return { json: async () => contactBody };
    }
  );

  return { line, wrap, roomsEl, usersEl, errors };
}

// ---- the upgrade nudge -----------------------------------------------------

test('a signed-in free account is offered the upgrade', () => {
  const h = mount({ session: 'free' });

  updateHeroFreeGensLine();

  assert.equal(h.line.classList.contains('hidden'), false);
  assert.match(h.line.innerHTML, /Stagify\+/);
});

test('a paying subscriber is not sold what they already have', () => {
  const h = mount({ session: 'pro' });

  updateHeroFreeGensLine();

  assert.equal(h.line.classList.contains('hidden'), true);
});

test('a signed-out visitor is not shown an account-specific nudge', () => {
  const h = mount({ session: 'out' });

  updateHeroFreeGensLine();

  assert.equal(h.line.classList.contains('hidden'), true);
});

test('the nudge is localized when the language pack has it', () => {
  const h = mount({ session: 'free', langText: 'Probieren Sie Stagify+ heute' });

  updateHeroFreeGensLine();

  assert.equal(h.line.innerHTML, 'Probieren Sie Stagify+ heute');
});

test('the nudge falls back to English rather than going blank', () => {
  const h = mount({ session: 'free', langText: '' });

  updateHeroFreeGensLine();

  assert.match(h.line.innerHTML, /Try Stagify\+ today/);
  assert.match(h.line.innerHTML, /stagify-plus\.html/, 'and it still links somewhere');
});

test('a page without the nudge element is a no-op', () => {
  mount({ session: 'free', hasLine: false });

  assert.doesNotThrow(() => updateHeroFreeGensLine());
});

// ---- the counts ---------------------------------------------------------------

test('a page with no stat pills never calls the count endpoints', async () => {
  // auth.js calls this on every sign-in, on every page. Firing two requests from the
  // contact page for pills that are not there is pure waste.
  let called = 0;
  mount({ hasPills: false });
  globalThis.fetch = /** @type {any} */ (async () => { called += 1; return { json: async () => ({}) }; });

  loadHeroStats();
  await settle();

  assert.equal(called, 0);
});

test('the counts are handed to the animator when one is present', async () => {
  const seen = [];
  mount({ heroStats: { setCounts: (counts, opts) => seen.push({ counts, opts }) } });

  loadHeroStats();
  await settle();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].counts, { roomsStaged: 1234, usersServed: 56 });
  assert.equal(seen[0].opts.refresh, false);
});

test('a refresh is passed through so the animation does not replay from zero', async () => {
  const seen = [];
  mount({ heroStats: { setCounts: (counts, opts) => seen.push({ counts, opts }) } });

  loadHeroStats({ refresh: true });
  await settle();

  assert.equal(seen[0].opts.refresh, true);
});

test('without the animator the pills are written directly and revealed', async () => {
  const h = mount();

  loadHeroStats();
  await settle();

  assert.equal(h.roomsEl.textContent, '1234');
  assert.equal(h.usersEl.textContent, '56');
  assert.equal(h.wrap.classList.contains('is-ready'), true);
});

test('an older deploy answering the legacy shape still produces a number', async () => {
  // /api/contact-count used to answer contactCount + userCount. Without the fallback
  // the pill would read as missing against any server that has not caught up.
  const h = mount({ contactBody: { contactCount: 40, userCount: 12 } });

  loadHeroStats();
  await settle();

  assert.equal(h.usersEl.textContent, '52');
});

test('a legacy body with no user count still counts the contacts', async () => {
  const h = mount({ contactBody: { contactCount: 40 } });

  loadHeroStats();
  await settle();

  assert.equal(h.usersEl.textContent, '40');
});

test('a response with no counts at all leaves the pills alone', async () => {
  // Writing "null" or "NaN" into the pill is worse than leaving the placeholder.
  const h = mount({ promptBody: {}, contactBody: {} });

  loadHeroStats();
  await settle();

  assert.equal(h.roomsEl.textContent, '');
  assert.equal(h.usersEl.textContent, '');
});

test('a failed request reveals the pills without numbers rather than hiding them', async () => {
  // The pills are part of the hero layout; leaving them invisible collapses it.
  let revealed = 0;
  mount({ promptFails: true, heroStats: { setCounts: () => {}, revealWithoutCounts: () => { revealed += 1; } } });

  loadHeroStats();
  await settle();

  assert.equal(revealed, 1);
});

test('a failed request without an animator does not throw', async () => {
  const h = mount({ contactFails: true });

  loadHeroStats();
  await settle();

  assert.equal(h.wrap.classList.contains('is-ready'), false);
  assert.equal(h.errors.length, 1, 'and the failure is logged rather than swallowed');
});
