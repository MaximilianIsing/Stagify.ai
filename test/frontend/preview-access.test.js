// Tier: frontend island logic — public/scripts/preview-access.js and the three pages bound
// to it.
//
// WHAT THIS COVERS
// Four Stagify+ surfaces now show one of three views on a single URL instead of redirecting
// everyone without a token. That arrangement is the only reason those pages are worth
// indexing, and every part of it fails SILENTLY:
//
//   • REVERSIBILITY — signing out has to put the public pitch back. auth.js calls these
//     writers on every auth change, so a one-way writer leaves the tool on screen for a
//     signed-out visitor, whose every click then 401s.
//   • THE IN-FLIGHT WINDOW — each page pre-paints the Pro shape from a CACHED plan and must
//     hold that guess until the real answer lands, but no longer. Wrong in the permissive
//     direction and the flash the gate exists to prevent comes straight back; wrong the
//     other way and a free account keeps a tool it cannot use.
//   • THE BINDINGS — the writer finds its regions by id. A page that renames one gets no
//     error, just a region that never changes: `getElementById` returns null and the writer
//     no-ops on it, which is exactly what it is supposed to do on the ten pages that are
//     not this one. So the ids are checked against the SHIPPED MARKUP rather than listed
//     here, or a rename would satisfy the test and the page together.
//
// None of it is a security boundary; requireProAccount on each render route is. These
// assertions are about what a visitor SEES, never about what they may do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewView, applyPreviewView, createPreviewAccess, settlePreview } from '../../public/scripts/preview-access.js';
import { syncMaskingStudioAccess } from '../../public/scripts/masking-studio/access.js';
import { syncDesignerAccess } from '../../public/scripts/ai-designer/access.js';
import { syncBasicMaskAccess } from '../../public/scripts/basic-mask/access.js';
import { syncExteriorAccess } from '../../public/scripts/exterior-studio/access.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const PRO = { plan: 'pro' };
const FREE = { plan: 'free' };

/**
 * Every page bound to the shared writer, with the ids its module names.
 *
 * ALL FOUR preview pages are here now. exterior-studio.html was the last one running its
 * own copy of the predicate, the writer and the pre-paint gate — it invented the pattern
 * and was left behind when the other three were folded in. Four copies of a rule this
 * subtle is four chances to fix a bug in one of them, so this list being complete is the
 * point: a preview page missing from it is a page nothing below checks.
 *
 * `pitch` is `ex-features` on the exterior page rather than `ex-pitch`. That name predates
 * the shared convention and is load-bearing in exterior-studio/pitch.test.js; the writer
 * takes ids as arguments precisely so a page may keep its own.
 */
const PAGES = [
  { file: 'masking-studio.html', sync: syncMaskingStudioAccess, module: 'masking-studio/access.js', pending: 'ms-pro-pending', tool: 'ms-tool', pitch: 'ms-pitch', hero: 'ms-hero-actions' },
  { file: 'ai-designer.html', sync: syncDesignerAccess, module: 'ai-designer/access.js', pending: 'ai-pro-pending', tool: 'ai-tool', pitch: 'ai-pitch', hero: 'ai-hero-actions' },
  // Basic Mask names NO pitch, and that is the shape rather than an omission: the page is
  // a pitch end to end, so there is no region to take away from a subscriber, only a
  // button to swap. createPreviewAccess treats the id as optional for exactly this case.
  { file: 'basic-mask.html', sync: syncBasicMaskAccess, module: 'basic-mask/access.js', pending: 'bm-pro-pending', tool: 'bm-tool', pitch: null, hero: 'bm-hero-actions' },
  { file: 'exterior-studio.html', sync: syncExteriorAccess, module: 'exterior-studio/access.js', pending: 'ex-pro-pending', tool: 'ex-tool', pitch: 'ex-features', hero: 'ex-hero-actions' },
];

/** The stylesheets a page links, as absolute paths. */
function stylesheetsOf(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  return [...html.matchAll(/href="[^"]*styles\/([a-z0-9-]+\.css)"/g)]
    .map((m) => path.join(PUBLIC, 'styles', m[1]))
    .filter((p) => fs.existsSync(p));
}

/** A minimal element stand-in: the surface the writer actually touches. */
function fakeEl(id, hidden = false) {
  return { id, hidden };
}

/**
 * Stand up a document exposing exactly the ids one page carries, each element starting in
 * the state its markup ships it in.
 *
 * `token` and `pending` model the pre-paint gate: it arms `html.<x>-pro-pending` from a
 * CACHED plan, and the writer only takes it off once the live plan is known — which it
 * decides by asking whether a token is still awaiting an answer.
 */
function mount(page, { user = null, token = undefined, pending = false } = {}) {
  const hidden = shippedHidden(page.file);
  const els = {};
  for (const id of [page.tool, page.pitch, page.hero].filter(Boolean)) els[id] = fakeEl(id, hidden.has(id));

  let className = pending ? page.pending : '';
  const root = {
    classList: {
      contains: (c) => className.split(/\s+/).filter(Boolean).includes(c),
      remove: (c) => {
        className = className.split(/\s+/).filter(Boolean).filter((x) => x !== c).join(' ');
      },
    },
  };
  const storedToken = token === undefined ? (user ? 'tok' : null) : token;

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = /** @type {any} */ ({
    documentElement: root,
    getElementById: (id) => els[id] || null,
  });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: { user, getToken: () => storedToken },
  });
  return {
    els,
    armed: () => root.classList.contains(page.pending),
    restore() { globalThis.document = prevDoc; globalThis.window = prevWin; },
  };
}

/** Ids whose element ships with the `hidden` attribute, read from the real page. */
function shippedHidden(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    // The `|$` in the lookahead is load-bearing: the captured attribute string stops BEFORE
    // the closing `>`, so a bare `hidden` written LAST — which is where it usually ends up —
    // has nothing after it to match.
    if (id && /\shidden(?=[\s>]|$)/.test(attrs)) ids.add(id);
  }
  return ids;
}

// ---- the pure rule ---------------------------------------------------------

test('previewView maps every visitor to exactly one of the three views', () => {
  assert.equal(previewView(null), 'anonymous');
  assert.equal(previewView(undefined), 'anonymous');
  assert.equal(previewView(FREE), 'free');
  assert.equal(previewView(PRO), 'pro');
});

test('previewView treats an unknown plan as not Pro', () => {
  // Degrading to the pitch is the safe direction: the server refuses the render anyway, so
  // the worst case is a paying customer seeing a marketing page, not a free account getting
  // a paid feature.
  assert.equal(previewView({ plan: 'trialing' }), 'free');
  assert.equal(previewView({}), 'free');
});

// ---- the writer ------------------------------------------------------------

test('the writer is idempotent and REVERSIBLE — signing out puts the pitch back', () => {
  const els = { pitch: fakeEl('p'), tool: fakeEl('t', true), heroActions: fakeEl('h') };

  applyPreviewView('pro', els);
  applyPreviewView('pro', els);
  assert.equal(els.tool.hidden, false, 'running twice changes nothing');
  assert.equal(els.pitch.hidden, true);
  assert.equal(els.heroActions.hidden, true, 'no offer to sell what they already bought');

  applyPreviewView('anonymous', els);
  assert.equal(els.tool.hidden, true, 'the tool goes away again');
  assert.equal(els.pitch.hidden, false, 'and the pitch comes back');
  assert.equal(els.heroActions.hidden, false, 'along with the button that sells it');

  // free → pro is the upgrade path: someone who subscribes in another tab and comes back
  // must get the tool, not the pitch they just paid to skip.
  applyPreviewView('free', els);
  assert.equal(els.tool.hidden, true);
  assert.equal(applyPreviewView('pro', els), true, 'upgrading reveals the tool');
});

test('signed-in free is byte for byte the page an anonymous visitor gets', () => {
  // Signing up must not change these pages. On the Masking Studio it used to: creating an
  // account swapped the tool for a full-screen dialog about not having paid.
  const shape = (view) => {
    const els = { pitch: fakeEl('p'), tool: fakeEl('t', true), heroActions: fakeEl('h') };
    applyPreviewView(view, els);
    return [els.pitch.hidden, els.tool.hidden, els.heroActions.hidden];
  };
  assert.deepEqual(shape('free'), shape('anonymous'));
});

test('a missing region is a no-op, not a throw', () => {
  // The writers run from applyUserToUI() on every nav-bearing page, and all but one of them
  // has none of these elements.
  assert.doesNotThrow(() => applyPreviewView('pro', { pitch: null, tool: null, heroActions: null }));
});

test('a page with no tool element is not this page — the writer bails', () => {
  const prevDoc = globalThis.document;
  globalThis.document = /** @type {any} */ ({ getElementById: () => null });
  const sync = createPreviewAccess({ toolId: 'nope', pitchId: 'x', pendingClass: 'y' });
  assert.doesNotThrow(() => sync());
  assert.equal(sync(), false);
  globalThis.document = prevDoc;
});

// ---- handing back from the pre-paint guess ---------------------------------

for (const page of PAGES) {
  test(`${page.file}: the shipped markup is the ANONYMOUS view`, () => {
    // If the tool shipped visible, every visitor would see it for a moment before JS took
    // it away — and a crawler, which runs no auth, would index the wrong page.
    const hidden = shippedHidden(page.file);
    assert.ok(hidden.has(page.tool), `${page.tool} must ship hidden`);
    if (page.pitch) assert.ok(!hidden.has(page.pitch), `${page.pitch} must ship visible`);
    assert.ok(!hidden.has(page.hero), `${page.hero} must ship visible`);
  });

  test(`${page.file}: the ids its module names are really in the markup`, () => {
    // The writer resolves by id and silently no-ops on a null, so a rename is invisible.
    // Read from the SHIPPED page, and from the module's own source, so neither can drift
    // without the other.
    const html = fs.readFileSync(path.join(PUBLIC, page.file), 'utf8');
    const mod = fs.readFileSync(path.join(PUBLIC, 'scripts', page.module), 'utf8');
    for (const id of [page.tool, page.pitch, page.hero].filter(Boolean)) {
      assert.ok(html.includes(`id="${id}"`), `${page.file} has no #${id}`);
      assert.ok(mod.includes(`'${id}'`), `${page.module} does not bind ${id}`);
    }
    assert.ok(mod.includes(`'${page.pending}'`), `${page.module} does not name ${page.pending}`);
    assert.ok(html.includes(`data-pending-class="${page.pending}"`)
      || html.includes(`'${page.pending}'`)
      || fs.readFileSync(path.join(PUBLIC, 'scripts', 'ai-designer-gate.js'), 'utf8').includes(`'${page.pending}'`),
    `nothing arms ${page.pending} before paint on ${page.file}`);
  });

  test(`${page.file}: the optimistic first sync leaves the guess alone; the answer takes it off`, () => {
    // Each page's entry point syncs BEFORE /api/auth/me is even sent, and at that moment the
    // writer reads "anonymous" for a subscriber. If that call stripped the class the pitch
    // would paint, which is the exact bug the pre-paint gate exists to prevent.
    const inFlight = mount(page, { user: null, token: 'tok', pending: true });
    page.sync();
    assert.ok(inFlight.armed(), 'the cached guess must stand until the plan is actually known');
    inFlight.restore();

    const answered = mount(page, { user: PRO, token: 'tok', pending: true });
    page.sync();
    assert.ok(!answered.armed(), 'the live plan takes over');
    assert.equal(answered.els[page.tool].hidden, false, 'and it agrees with what was painted');
    if (page.pitch) assert.equal(answered.els[page.pitch].hidden, true);
    answered.restore();
  });

  test(`${page.file}: a stale cached plan is CORRECTED, not honoured`, () => {
    // Someone who cancelled still has `stagifyPlan: 'pro'` in storage until /api/auth/me
    // answers, so they get the tool for one round trip. Cosmetic — the server refuses the
    // render — but the correction has to actually land.
    const p = mount(page, { user: FREE, token: 'tok', pending: true });
    assert.equal(page.sync(), false);
    assert.ok(!p.armed(), 'the CSS override must stop applying');
    assert.equal(p.els[page.tool].hidden, true, 'and the tool goes away with it');
    if (page.pitch) assert.equal(p.els[page.pitch].hidden, false, 'leaving the pitch');
    p.restore();
  });

  test(`${page.file}: signing out disarms the class as well as restoring the pitch`, () => {
    // clear() drops the token, the user AND the cached plan together, so this is the "no
    // token" branch of settled — the one that must not wait for an answer never coming.
    const p = mount(page, { user: null, token: null, pending: true });
    assert.equal(page.sync(), false);
    assert.ok(!p.armed());
    if (page.pitch) assert.equal(p.els[page.pitch].hidden, false);
    p.restore();
  });

  test(`${page.file}: the pre-paint CSS covers all three regions, with display`, () => {
    // The pre-paint half is HALF CSS, and the class arming is worth nothing without it.
    // preview-gate.test.js checks a rule for the class exists at all; these are the two
    // ways a rule that exists can still be wrong, both of which look fine in review:
    //
    //  1. `visibility` instead of `display`. styles.css's i18n anti-FOUC rule
    //     (`body.language-loaded [data-lang] { visibility: visible }`, specificity (0,2,1))
    //     matches every translatable element on these pages, so anything suppressed with
    //     `visibility` is silently un-hidden the moment the language pack lands. The class
    //     is applied, the pitch paints anyway, and nothing fails. Written up at length in
    //     home.css after it bit three times.
    //  2. a selector with no id. Each page hides its tool with an id-or-class `[hidden]`
    //     rule; a class-only override ties and loses on source order.
    const rules = [];
    for (const sheet of stylesheetsOf(page.file)) {
      const css = fs.readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      rules.push(...css.matchAll(new RegExp(`([^{}]*\\b${page.pending}\\b[^{}]*)\\{([^}]*)\\}`, 'g')));
    }
    assert.ok(rules.length >= 2, `${page.file} arms .${page.pending} but its stylesheets barely rule on it`);

    const covered = rules.flatMap(([, sel]) => sel.split(',')).map((s) => s.trim());
    // `.filter(Boolean)` for basic-mask.html, which names no pitch: the page is a pitch end
    // to end, so there is no region to take away and nothing for a rule to cover.
    for (const id of [page.tool, page.pitch, page.hero].filter(Boolean)) {
      assert.ok(covered.some((s) => s.includes(`#${id}`)), `#${id} is not covered by a pre-paint rule on ${page.file}`);
    }

    for (const [, sel, body] of rules) {
      assert.ok(!/visibility\s*:/.test(body), `"${sel.trim()}" uses visibility — the i18n anti-FOUC rule outranks it`);
      assert.match(body, /display\s*:/, `"${sel.trim()}" must switch display`);
      for (const one of sel.split(',')) {
        assert.match(one, /#/, `"${one.trim()}" has no id, so it ties with the [hidden] rule and loses on source order`);
      }
    }

    // And the tool is revealed THROUGH its shipped `hidden` attribute — the markup still
    // ships anonymous, which is what the crawler and the no-JS visitor get.
    assert.ok(
      rules.some(([, sel]) => sel.includes(`#${page.tool}[hidden]`)),
      `${page.file} must reveal #${page.tool} through its [hidden] attribute, not by dropping it`,
    );
  });
}

// ---- settling around the plan check ----------------------------------------

test('settlePreview paints before AND after the plan check', () => {
  const calls = [];
  let user = null;
  const prevWin = globalThis.window;
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: {
      get user() { return user; },
      fetchMe: async () => { user = PRO; },
    },
  });
  const sync = () => { calls.push(user ? 'pro' : 'anon'); return !!user; };

  return settlePreview(sync).then((pro) => {
    globalThis.window = prevWin;
    // The first call is the whole point: without it a subscriber whose plan is cached loses
    // the pre-painted tool for the length of a round trip.
    assert.deepEqual(calls, ['anon', 'pro'], 'paint from the cache, then from the answer');
    assert.equal(pro, true);
  });
});

test('a failed plan check still repaints, and never throws', async () => {
  // These pages used to redirect on this path. The public view is already on screen and is
  // the correct page for someone whose plan could not be confirmed — but the second sync
  // must still run, or a cancelled account keeps a pre-painted tool the server will 403.
  let calls = 0;
  const prevWin = globalThis.window;
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: { user: null, fetchMe: async () => { throw new Error('offline'); } },
  });
  const pro = await settlePreview(() => { calls += 1; return false; });
  globalThis.window = prevWin;
  assert.equal(calls, 2, 'the answer-side paint is not skipped on the error path');
  assert.equal(pro, false);
});

test('settlePreview works on a page with no auth at all', async () => {
  const prevWin = globalThis.window;
  globalThis.window = /** @type {any} */ ({});
  let calls = 0;
  await settlePreview(() => { calls += 1; return false; });
  globalThis.window = prevWin;
  assert.equal(calls, 2);
});

// ---- the writers are wired to the one place that runs them -----------------

test('auth.js calls every preview writer, and does it BEFORE the signed-out return', () => {
  // applyUserToUI() returns early for a signed-out visitor. A writer called after that
  // return never runs on sign-OUT, which is precisely when the pitch has to come back.
  const src = fs.readFileSync(path.join(PUBLIC, 'scripts', 'auth.js'), 'utf8');
  const body = src.slice(src.indexOf('applyUserToUI'));
  const earlyReturn = body.indexOf('if (!u) {');
  assert.notEqual(earlyReturn, -1, 'the early return moved — this guard needs rewriting');

  for (const name of ['syncExteriorAccess', 'syncMaskingStudioAccess', 'syncDesignerAccess']) {
    assert.ok(src.includes(`import { ${name} }`), `auth.js does not import ${name}`);
    const called = body.indexOf(`${name}();`);
    assert.notEqual(called, -1, `auth.js never calls ${name}`);
    assert.ok(called < earlyReturn, `${name}() is called after the signed-out return`);
  }
  // basic-mask.html is the exception, and deliberately: it does not load auth.js's UI
  // writers on a schedule of its own — its entry point settles once at load, and the page
  // has no in-page sign-in to change the answer under it.
});
