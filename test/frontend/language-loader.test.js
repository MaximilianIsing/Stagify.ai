// Unit tests for public/scripts/language-loader.js — the site-wide i18n runtime.
//
// WHAT THIS COVERS
// `getText`'s miss contract, which ~20 call sites across the frontend depend on and
// which nothing tested before. A miss is `undefined`; it used to be the literal
// string 'Loading...', and that cost twice over:
//
//   1. It reserved a translation — any pack string whose real text was "Loading..."
//      was indistinguishable from a miss and thrown away.
//   2. It is truthy, so every `getText(key) || 'English default'` call rendered
//      "Loading..." instead of its default — on any missing key, and on *every* key
//      during the window before the pack finishes loading.
//
// Both directions are pinned below, because a fix that only handled (1) would leave
// the visible bug in place.
//
// The module is an IIFE that assigns window.LanguageSystem at import and then defers
// its own init() to DOMContentLoaded. Setting readyState to 'loading' before import
// means init never runs, so the tests drive loadLanguage/getText/applyLanguageToElements
// directly against a minimal DOM shim rather than a real page.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── minimal DOM shim ─────────────────────────────────────────────────────────
// Only what the loader touches. Elements are plain objects with the handful of
// methods it calls; `document.querySelectorAll` serves whatever the test registered.

function makeEl(attrs = {}, tagName = 'SPAN') {
  return {
    tagName,
    attrs: { ...attrs },
    textContent: '',
    innerHTML: '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

/** @type {{ '[data-lang]': any[], '[data-lang-html]': any[], '[data-lang-attr]': any[] }} */
let registry;

function installDom() {
  registry = { '[data-lang]': [], '[data-lang-html]': [], '[data-lang-attr]': [] };
  globalThis.document = {
    readyState: 'loading', // keeps init() from firing on import
    title: '',
    body: { classList: { add() {} } },
    querySelectorAll: (sel) => registry[sel] || [],
    querySelector: () => null, // no <title data-lang> / JSON-LD in these tests
    addEventListener() {},
    getElementById: () => null,
  };
  globalThis.window = {
    dispatchEvent() {},
    addEventListener() {},
    location: { pathname: '/', assign() {} },
  };
  // i18n-routing's localizeLinks (called at the end of applyLanguageToElements)
  // reads a BARE `location`, not `window.location`. Path '/' is the English root,
  // where it returns before touching the DOM.
  globalThis.location = { pathname: '/' };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.Node = { ELEMENT_NODE: 1 };
}

/** Load a pack through the real loadLanguage(), via a stubbed fetch. */
async function loadPack(pack) {
  globalThis.fetch = async () => ({ ok: true, json: async () => pack });
  await globalThis.window.LanguageSystem.loadLanguage('english');
}

before(async () => {
  installDom();
  await import('../../public/scripts/language-loader.js');
});

beforeEach(() => {
  // Reset only the per-test DOM registry; the module is imported once and keeps
  // its own translations, which each test overwrites via loadPack.
  registry = { '[data-lang]': [], '[data-lang-html]': [], '[data-lang-attr]': [] };
  globalThis.document.querySelectorAll = (sel) => registry[sel] || [];
});

// ── the miss contract ────────────────────────────────────────────────────────

// MUST RUN FIRST: `translations` starts null and no test can put it back, so this is
// the only chance to exercise the not-yet-loaded branch — which is the state every
// page passes through on first paint, and where the old sentinel was most visible.
test('before any pack loads, every key misses and an explicit fallback still wins', () => {
  const { getText, isLoaded } = globalThis.window.LanguageSystem;
  assert.equal(isLoaded(), false, 'guard: this test has to run before any loadPack');

  assert.equal(getText('anything.at.all'), undefined);
  assert.equal(getText('anything.at.all') || 'English default', 'English default');
  assert.equal(getText('hero.catchphrase', 'Upload. Stage. Imagine.'), 'Upload. Stage. Imagine.',
    'a caller-supplied fallback is honoured before the pack arrives, not swallowed');
});

test('a missing key resolves to undefined, not to a sentinel string', async () => {
  await loadPack({ hero: { catchphrase: 'Upload. Stage. Imagine.' } });
  const { getText } = globalThis.window.LanguageSystem;

  assert.equal(getText('hero.nope'), undefined);
  assert.equal(getText('nope.entirely'), undefined);
  // A path that runs through a non-object mid-segment is a miss too.
  assert.equal(getText('hero.catchphrase.deeper'), undefined);
});

test('an explicit fallback still wins over undefined', async () => {
  await loadPack({ hero: {} });
  const { getText } = globalThis.window.LanguageSystem;

  assert.equal(getText('hero.nope', 'English default'), 'English default');
  assert.equal(getText('hero.nope', null), null, 'a caller asking for null gets null');
});

test('`getText(key) || default` reaches its default — the visible half of the bug', async () => {
  // The sentinel was truthy, so this extremely common shape never fell through and
  // the UI rendered the literal "Loading...". ~20 call sites are written this way.
  await loadPack({ modal: {} });
  const { getText } = globalThis.window.LanguageSystem;

  assert.equal(getText('modal.staging.progress.staging') || 'AI is staging your room…',
    'AI is staging your room…');
});

test('a falsy translation is a real value, not a miss', async () => {
  // Same class of bug as the sentinel: `current || fallback` would discard a
  // deliberately-empty string (used to blank a label) or a numeric zero. Only
  // `undefined` means "not there".
  await loadPack({ ui: { spacer: '', count: 0, off: false } });
  const { getText } = globalThis.window.LanguageSystem;

  assert.equal(getText('ui.spacer', 'FALLBACK'), '');
  assert.equal(getText('ui.count', 'FALLBACK'), 0);
  assert.equal(getText('ui.off', 'FALLBACK'), false);
});

test('a translation whose real text is "Loading..." survives', async () => {
  // The flagged bug: this exact string was the miss value, so a pack that
  // legitimately used it was silently discarded.
  await loadPack({ common: { loading: 'Loading...' } });
  const { getText } = globalThis.window.LanguageSystem;

  assert.equal(getText('common.loading'), 'Loading...');
  assert.equal(getText('common.loading', 'fallback'), 'Loading...', 'a real value beats the fallback');
});

test('non-string values pass through — several keys hold arrays', async () => {
  await loadPack({ maskingStudio: { loadingMessages: ['one', 'two'] } });
  const { getText } = globalThis.window.LanguageSystem;
  assert.deepEqual(getText('maskingStudio.loadingMessages'), ['one', 'two']);
});

// ── what the DOM does with a miss ────────────────────────────────────────────

test('applying translations writes hits and leaves misses untouched', async () => {
  const hit = makeEl({ 'data-lang': 'nav.home' });
  const miss = makeEl({ 'data-lang': 'nav.notTranslatedYet' });
  hit.textContent = 'ORIGINAL';
  miss.textContent = 'ORIGINAL';
  registry['[data-lang]'] = [hit, miss];

  await loadPack({ nav: { home: 'Inicio' } });
  globalThis.window.LanguageSystem.applyLanguageToElements();

  assert.equal(hit.textContent, 'Inicio');
  assert.equal(miss.textContent, 'ORIGINAL', 'an untranslated node keeps its markup text');
});

test('a "Loading..." translation is applied to the DOM like any other string', async () => {
  const el = makeEl({ 'data-lang': 'common.loading' });
  el.textContent = 'ORIGINAL';
  registry['[data-lang]'] = [el];

  await loadPack({ common: { loading: 'Loading...' } });
  globalThis.window.LanguageSystem.applyLanguageToElements();

  assert.equal(el.textContent, 'Loading...');
});

test('text inputs and textareas take the placeholder, other elements textContent', async () => {
  const input = makeEl({ 'data-lang': 'form.name' }, 'INPUT');
  input.type = 'text';
  const area = makeEl({ 'data-lang': 'form.notes' }, 'TEXTAREA');
  registry['[data-lang]'] = [input, area];

  await loadPack({ form: { name: 'Nombre', notes: 'Notas' } });
  globalThis.window.LanguageSystem.applyLanguageToElements();

  assert.equal(input.placeholder, 'Nombre');
  assert.equal(area.placeholder, 'Notas');
});

test('[data-lang-html] and [data-lang-attr] follow the same miss rule', async () => {
  const htmlHit = makeEl({ 'data-lang-html': 'rich.body' });
  const htmlMiss = makeEl({ 'data-lang-html': 'rich.missing' });
  htmlMiss.innerHTML = 'ORIGINAL';
  const attrHit = makeEl({ 'data-lang-attr': 'a11y.close|aria-label' });
  const attrMiss = makeEl({ 'data-lang-attr': 'a11y.missing|aria-label' });
  registry['[data-lang-html]'] = [htmlHit, htmlMiss];
  registry['[data-lang-attr]'] = [attrHit, attrMiss];

  await loadPack({ rich: { body: '<b>hola</b>' }, a11y: { close: 'Cerrar' } });
  globalThis.window.LanguageSystem.applyLanguageToElements();

  assert.equal(htmlHit.innerHTML, '<b>hola</b>');
  assert.equal(htmlMiss.innerHTML, 'ORIGINAL');
  assert.equal(attrHit.getAttribute('aria-label'), 'Cerrar');
  assert.equal(attrMiss.getAttribute('aria-label'), null, 'a miss must not write "undefined"');
});

// ── drift guard ──────────────────────────────────────────────────────────────

test('no script compares a translation against the "Loading..." sentinel', () => {
  // The finding was not one bad line, it was one magic string copied into seven
  // files: getText returned it, six consumers hard-coded the same literal to detect
  // a miss, and each copy silently discarded any translation that matched. The
  // behavioural tests above only cover the loader and two of those consumers —
  // `app/stage-mask-editor.js`, `masking-studio-app.js` and
  // `profile-menu/dom-utils.js` have no unit tests, and mutation testing confirmed
  // that re-adding their comparison was otherwise invisible. This scan covers them
  // and anything written next.
  //
  // Deliberately narrow: it flags a COMPARISON against the literal, not the literal
  // itself, so a script may still display "Loading..." as ordinary UI text.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'scripts');
  const offenders = [];
  const compare = /[!=]==?\s*(['"`])Loading\.\.\.\1|(['"`])Loading\.\.\.\2\s*[!=]==?/;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) return; // the comments explaining this
          if (compare.test(line)) offenders.push(`${path.relative(root, p)}:${i + 1}: ${t}`);
        });
      }
    }
  };
  walk(root);

  assert.deepEqual(offenders, [], 'a miss is `undefined` — compare against that, never a magic string:\n' + offenders.join('\n'));
});

test('the drift guard detects the shapes the codebase actually had', () => {
  const compare = /[!=]==?\s*(['"`])Loading\.\.\.\1|(['"`])Loading\.\.\.\2\s*[!=]==?/;
  for (const bad of [
    "  if (template && template !== 'Loading...') {",
    "        return v && v !== 'Loading...' ? v : def;",
    '    if (typeof got === "string" && got !== "Loading...") text = got;',
    "      if (value !== config.fallbackText || v == 'Loading...') {",
    "if ('Loading...' === v) return def;",
  ]) {
    assert.ok(compare.test(bad), `guard missed a real shape: ${bad}`);
  }
  for (const ok of [
    "  const label = 'Loading...';",
    "  el.textContent = 'Loading...';",
    '  if (value !== undefined) el.textContent = value;',
  ]) {
    assert.ok(!compare.test(ok), `guard fired on a safe line: ${ok}`);
  }
});
