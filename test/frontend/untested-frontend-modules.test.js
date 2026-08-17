// Tier: drift guard — the ledger of frontend modules no `node --test` run ever loads.
//
// WHY THIS EXISTS: `npm run test:coverage` enforces product-source floors
// (scripts/test-coverage.js), but V8 coverage only reports files the run actually
// LOADED. A module under public/scripts/ that no test ever imports contributes to
// neither the numerator nor the denominator — it is invisible to those floors, not
// averaged into them. So raising the coverage floors can never surface it, and a
// brand-new untested frontend file lands with the aggregate percentage unmoved.
//
// This test closes that hole the only way run-based coverage allows: by pinning the
// exact set of never-loaded modules. The assertion is set equality, so it fails in
// three useful directions:
//   1. a new frontend module arrives with no test  -> must be listed (visible debt)
//   2. a listed module gains a test                -> must be delisted (ratchet)
//   3. a listed module is deleted/renamed          -> must be delisted (no stale rot)
// The lists only ever shrink. Adding an entry is allowed but is a deliberate,
// reviewable act — that is the whole point.
//
// WHAT "LOADED" MEANS HERE, AND WHAT IT DOES NOT MEAN. This is measured statically,
// by walking the import graph from every file under test/ into public/scripts/ and
// taking the transitive closure. That was validated against the real thing — an lcov
// run of the full suite on 2026-07-28 reported exactly the same set the walk finds,
// with zero false positives and zero false negatives. It is checked here rather than
// in the coverage script because `npm test` (which gates the deploy) does not run
// coverage at all; only the separate CI `npm run test:coverage` job does.
//
// The walk is rooted at test/ ONLY. e2e/ is a sibling directory it never enters, so
// Playwright coverage is invisible to it BY CONSTRUCTION. That is not a bug — lcov
// cannot see a browser run either — but it means a flat list of everything this walk
// misses is not a list of untested code, and reading it as one is a mistake that has
// already been made once in review. Hence three lists rather than one:
//
//   UNTESTED        real, recoverable debt: exported logic nothing exercises.
//   E2E_COVERED     side-effect entry points and composition roots with no unit-
//                   testable surface, driven by the Playwright suite instead. Held
//                   to a guard below so this cannot become a rubber stamp.
//   BLOCKED_CLASSIC classic <script> files (IIFEs, no exports). node cannot import
//                   these AT ALL; they are blocked on ESM conversion, not on someone
//                   getting around to writing a test.
//
// Comments are stripped before scanning: a commented-out import must NOT count as
// coverage, or the ledger could silently under-report. Mis-stripping fails safe —
// it can only make a file look untested, which trips the set-equality assertion
// loudly rather than hiding debt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ROOT = path.resolve(HERE, '../..').replace(/\\/g, '/');
const PUBLIC = `${ROOT}/public`;
const SCRIPTS = `${PUBLIC}/scripts`;
const TESTS = `${ROOT}/test`;
const E2E = `${ROOT}/e2e`;

// Third-party bundles are excluded from the ledger: they are vendored artifacts,
// not our source, and writing tests for them is not the debt we are tracking.
const EXCLUDED_PREFIXES = ['vendor/'];

// ── list 1: the debt ─────────────────────────────────────────────────────────
// public/scripts-relative paths, sorted. SHRINK ONLY. See the header.
//
// Everything here exports something a test could call. Nothing is blocked; these
// simply have no suite yet.
const UNTESTED = [
  'aurora-scrollbar.js',
  'card-spotlight.js',
  'designer-demo.js',
  'enterprise.js',
  'footer-year.js',
  'getpro.js',
  'home-reveal.js',
  'home-text-animate.js',
  'hover-glow.js',
  'language-detect.js',
  'language-switcher.js',
  'lazy-css.js',
  'nav-pill.js',
  'plus-cta-auth.js',
  'plus-welcome-confetti.js',
  'print-button.js',
  'reset-password.js',
  'sponsors-scroll.js',
  'stagify-plus-blackhole.js',
  'staging-studio.js',
  'star-border.js',
  'status.js',
];

// ── list 2: covered by the browser suite, not by this walk ───────────────────
// Sorted by `module`. SHRINK ONLY.
//
// Each of these is either a page's script entry or a composition root. The first
// three end in a literal `export {}` — zero exported API, nothing for a unit test
// to call but side effects. The rest inject collaborators into islands that each
// have their own suite; asserting on the wiring in node would mean rebuilding a
// whole page's DOM to re-prove what the islands already prove and what a real
// browser proves better.
//
// `page` is the page whose script graph must contain the module. It is not
// decoration — the guard below resolves the page's <script src> entries and walks
// their imports, so an exemption whose module is no longer loaded by that page
// fails here rather than quietly outliving the coverage it claims.
const E2E_COVERED = [
  // The AI Designer's composition root, and the mask editor it mounts. The editor
  // is 729 lines of wiring over the shared mask/* slices — createMaskFit,
  // createMaskViewport, createMaskOverlay, createMaskReference, createMaskBrush,
  // maskGrowths, requestMaskEdit, maskCopy — every one of which has a suite in
  // test/frontend/mask/. Driven by ai-designer{,-a11y,-errors,-mask-fit,
  // -mask-reference}.spec.js.
  { module: 'ai-designer-app.js', page: 'ai-designer.html' },
  { module: 'ai-designer/mask-editor.js', page: 'ai-designer.html' },
  // The main tool: 18 island imports plus a DOMContentLoaded mount. Eleven of
  // those islands already have suites under test/frontend/app/. Its mask editor is
  // the same story as the AI Designer's — wiring over the tested mask/* slices.
  // Driven by index.spec.js, basic-mask.spec.js, the six stage-mask-*.spec.js and
  // staging-nav.spec.js, among others.
  { module: 'app.js', page: 'index.html' },
  { module: 'app/stage-mask-editor.js', page: 'index.html' },
  // The Basic Mask preview page's entry point: four lines with no exports, which settle the
  // plan through the shared writer and stop. Both halves it depends on ARE unit-tested
  // (preview-access.test.js covers the writer and this page's binding of it), so what is
  // left here is the side effect of running at module load, which only a browser has.
  // Driven by basic-mask-preview.spec.js.
  { module: 'basic-mask-page.js', page: 'basic-mask.html' },
  // The homepage carousel. It runs at PARSE time rather than on DOMContentLoaded
  // because the <img> it injects is the page's LCP element, so there is not even a
  // mount function to call. Asserted in index.spec.js, basic-mask.spec.js and
  // report-issue.spec.js.
  { module: 'carousel.js', page: 'index.html' },
  // The Exterior Studio's composition root: wiring, and its three islands (access,
  // compare, enhance) each have their own suite. Driven by exterior-studio.spec.js.
  { module: 'exterior-studio-app.js', page: 'exterior-studio.html' },
  // The Masking Studio's composition root. Its islands are the eight
  // masking-studio/* entries — several still on UNTESTED above, which is the debt
  // worth paying rather than testing this file. Driven by the six
  // masking-studio*.spec.js.
  { module: 'masking-studio-app.js', page: 'masking-studio.html' },
];

// ── list 3: not importable by node at all ────────────────────────────────────
// Sorted. SHRINK ONLY.
//
// Classic <script> files: bare IIFEs that talk to `window`, with no export
// statement anywhere. `await import()` of one of these throws or, worse, silently
// evaluates against a global environment node does not have. Testing any of them
// means converting it to ESM first (or building an eval-in-sandbox harness), so
// they are tracked apart from UNTESTED — the blocker is structural, not effort.
// The guard below re-derives this classification from the source rather than
// trusting the list, so converting one to ESM fails here until it is delisted.
const BLOCKED_CLASSIC = [
  'ai-designer-gate.js',
  'ai-designer-model-selector.js',
  'demo-data.js',
  'demo-player.js',
  'faq-redirect.js',
  'gallery-gate.js',
  'gtag.js',
  // The shared reshaping gate, behaviourally covered by test/frontend/preview-gate.test.js
  // on the same `new Function` harness. Two entries used to sit beside it and are DELETED,
  // not delisted for coverage: `masking-studio-gate.js`, because that page became a public
  // preview and the gate that redirected everyone without a token had nothing left to do,
  // and `exterior-studio-gate.js`, which was a copy of this file for the one page that had
  // not been folded onto it yet.
  'preview-gate.js',
  // Same story as the two gates above: behaviourally covered by
  // test/frontend/gallery/session-class.test.js through `new Function`, but an IIFE with
  // no exports is not something node can import, which is what this list tracks.
  'session-class.js',
];

/** Every module on the ledger, whichever list it sits on. */
const LEDGER = [...UNTESTED, ...E2E_COVERED.map((e) => e.module), ...BLOCKED_CLASSIC];

// ── machinery ────────────────────────────────────────────────────────────────

const walkJs = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkJs(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
};

// Replace comment bodies with spaces, leaving string/template literals intact so a
// URL like 'https://x' is never mistaken for a line comment. Regex literals are not
// tracked; the worst case is an under-reported import, which fails loudly (see header).
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null; // "'" | '"' | '`' when inside a string
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

// Every relative module specifier in a file: `from '...'` covers static import and
// re-export, plus bare `import '...'` side-effect imports and `import('...')`.
//
// The last pattern is the cache-busted dynamic form, `` import(`../x.js?v=${tag}`) ``.
// A module whose side effects run at EVAL can only be re-tested by defeating the ESM
// cache, so its test has no choice but to write the specifier that way — and without
// this pattern the walk saw no edge and reported the module as untested even though a
// suite exercises it. That is a false positive in the loud direction (it fails the
// build rather than hiding debt), but it pushed toward listing a tested module in
// UNTESTED, which would have been a lie in the ledger. Only the literal PREFIX is
// captured; the `?v=` suffix is stripped by resolveSpecifier, and a fully dynamic
// specifier (`` import(`${VAR}?v=${tag}`) ``) is still invisible here by construction.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*`(\.[^`$?]+)(?:\?[^`]*)?`\s*\)/g,
];

function relativeSpecifiers(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const found = [];
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of src.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  return found.filter((s) => s.startsWith('.'));
}

function resolveSpecifier(fromFile, spec) {
  const p = path.resolve(path.dirname(fromFile), spec).replace(/\\/g, '/');
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

/**
 * Transitive closure of public/scripts modules reachable from a set of seed files.
 * Seeds outside public/scripts (test files, page entry points) are walked but not
 * themselves reported.
 */
function closureFrom(seedFiles) {
  const seen = new Set();
  const queue = [];
  const visit = (fromFile) => {
    for (const spec of relativeSpecifiers(fromFile)) {
      const resolved = resolveSpecifier(fromFile, spec);
      if (resolved && resolved.startsWith(`${SCRIPTS}/`) && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  };
  seedFiles.forEach(visit);
  while (queue.length) visit(queue.pop());
  return seen;
}

/** Absolute paths of every public/scripts module reachable from the test suite. */
const reachableFromTests = () => closureFrom(walkJs(TESTS));

/**
 * Absolute paths of every public/scripts module a page pulls in — its own
 * `<script src>` entries plus everything those transitively import.
 */
function scriptsLoadedByPage(page) {
  const html = fs.readFileSync(`${PUBLIC}/${page}`, 'utf8');
  const direct = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => src.includes('scripts/'))
    .map((src) => `${PUBLIC}/${src.replace(/^\//, '')}`)
    .filter((p) => fs.existsSync(p));
  return new Set([...direct, ...closureFrom(direct)]);
}

const toRel = (abs) => abs.slice(SCRIPTS.length + 1);
const isExcluded = (rel) => EXCLUDED_PREFIXES.some((p) => rel.startsWith(p));

/** A module with no `import`/`export` statement is a classic script, not ESM. */
const isClassicScript = (rel) =>
  !/^\s*(?:import|export)\b/m.test(stripComments(fs.readFileSync(`${SCRIPTS}/${rel}`, 'utf8')));

// ── assertions ───────────────────────────────────────────────────────────────

test('the untested-frontend ledger matches reality exactly (shrink only)', () => {
  const reachable = reachableFromTests();
  const onDisk = walkJs(SCRIPTS).map(toRel).filter((r) => !isExcluded(r));
  const actual = onDisk.filter((r) => !reachable.has(`${SCRIPTS}/${r}`)).sort();

  const pinned = new Set(LEDGER);
  const actualSet = new Set(actual);
  const newlyUntested = actual.filter((r) => !pinned.has(r));
  const nowTestedOrGone = LEDGER.filter((r) => !actualSet.has(r)).sort();

  assert.deepEqual(
    { newlyUntested, nowTestedOrGone },
    { newlyUntested: [], nowTestedOrGone: [] },
    'The frontend ledger in this file is out of date.\n' +
      '  newlyUntested   -> a frontend module no test loads. Write a test for it, or add\n' +
      '                     it to UNTESTED / E2E_COVERED / BLOCKED_CLASSIC deliberately.\n' +
      '  nowTestedOrGone -> now covered (or deleted/renamed). Delist it; the ledger only\n' +
      '                     ever shrinks.\n' +
      `  currently ${actual.length} of ${onDisk.length} frontend modules are unreachable from test/:\n` +
      `    ${UNTESTED.length} untested, ${E2E_COVERED.length} e2e-covered, ${BLOCKED_CLASSIC.length} blocked-classic.`,
  );
});

test('the three lists are sorted, duplicate-free and disjoint', () => {
  const e2eModules = E2E_COVERED.map((e) => e.module);
  for (const [name, list] of [
    ['UNTESTED', UNTESTED],
    ['E2E_COVERED', e2eModules],
    ['BLOCKED_CLASSIC', BLOCKED_CLASSIC],
  ]) {
    assert.deepEqual(list, [...list].sort(), `${name} must be sorted`);
    assert.equal(new Set(list).size, list.length, `${name} has duplicate entries`);
  }
  // A module on two lists would be counted twice by the set-equality test above and
  // could then be delisted from one while silently living on in the other.
  assert.equal(new Set(LEDGER).size, LEDGER.length, 'a module appears on more than one list');
});

// ── the guard that stops E2E_COVERED becoming a rubber stamp ─────────────────
//
// An exemption nothing checks is worse than the flat list it replaced: it reads as
// "covered" forever, including after the coverage goes away. Both directions are
// asserted — the page really loads the module, and the browser suite really visits
// the page.

test('every E2E_COVERED module is actually loaded by the page it names', () => {
  for (const { module: rel, page } of E2E_COVERED) {
    const loaded = scriptsLoadedByPage(page);
    assert.ok(
      loaded.has(`${SCRIPTS}/${rel}`),
      `${rel} claims coverage via ${page}, but that page's script graph does not ` +
        'include it. Either the page dropped the script (the exemption is now false ' +
        'and must be delisted) or the module moved (point it at the right page).',
    );
  }
});

test('every page named by E2E_COVERED is visited by the browser suite', () => {
  const specs = fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, src: fs.readFileSync(`${E2E}/${f}`, 'utf8') }));

  for (const page of new Set(E2E_COVERED.map((e) => e.page))) {
    const hits = specs.filter((s) => s.src.includes(page)).map((s) => s.file);
    assert.ok(
      hits.length > 0,
      `no file under e2e/ mentions ${page}, so nothing in E2E_COVERED that names it ` +
        'is actually covered by a browser run. Write the spec, or move those modules ' +
        'to UNTESTED.',
    );
  }
});

test('BLOCKED_CLASSIC holds only genuinely non-ESM files, and UNTESTED holds none', () => {
  for (const rel of BLOCKED_CLASSIC) {
    assert.ok(
      isClassicScript(rel),
      `${rel} is on BLOCKED_CLASSIC but has an import/export statement — it is a module ` +
        'node can load. Move it to UNTESTED (or write the test).',
    );
  }
  // The inverse, so the classification cannot rot in the other direction either: a
  // classic script parked on UNTESTED would read as "just needs a test" when in fact
  // no test can be written for it as-is.
  const misfiled = UNTESTED.filter(isClassicScript);
  assert.deepEqual(misfiled, [], 'these are classic scripts and belong on BLOCKED_CLASSIC');
});

// Sanity floor: if the import walk ever breaks (a bad regex, a comment-stripper bug,
// a moved directory) it would report ~nothing reachable and the ledger would balloon.
// The set-equality test above would catch that, but only as a confusing 39-entry diff.
// These assert the machinery itself still works, so the failure names the real cause.
test('the import walk still resolves a known-tested module (guard is not vacuous)', () => {
  const reachable = reachableFromTests();
  assert.ok(
    reachable.has(`${SCRIPTS}/app/download-menu.js`),
    'app/download-menu.js has a dedicated test (test/frontend/app/download-menu.test.js) ' +
      'and must resolve as reachable — the import walk is broken',
  );
  assert.ok(
    reachable.size >= 30,
    `only ${reachable.size} frontend modules resolved as reachable (expected >= 30) — ` +
      'the import walk is probably broken rather than coverage having collapsed',
  );
});

test('the page walk resolves a module only reachable through an entry point', () => {
  // app/download-menu.js is imported by app.js, never by a <script src> of its own.
  // If scriptsLoadedByPage stopped following imports it would still find app.js and
  // the E2E_COVERED assertions would keep passing, so pin the transitive step here.
  const loaded = scriptsLoadedByPage('index.html');
  assert.ok(loaded.has(`${SCRIPTS}/app.js`), 'index.html loads app.js directly');
  assert.ok(
    loaded.has(`${SCRIPTS}/app/download-menu.js`),
    'the page walk must follow imports, not just <script src> — app.js imports this',
  );
});

test('stripComments ignores comment bodies but preserves string literals', () => {
  assert.equal(relativeSpecifiers.length, 1); // arity guard: signature unchanged
  const stripped = stripComments("import x from './real.js'; // import y from './fake.js'");
  assert.ok(stripped.includes('./real.js'));
  assert.ok(!stripped.includes('./fake.js'), 'a commented-out import must not count as coverage');
  assert.ok(
    stripComments("const u = 'https://example.com/a'; /* c */").includes('https://example.com/a'),
    'a // inside a string literal must not start a comment',
  );
  assert.ok(
    !stripComments('/* import a from "./blocked.js" */').includes('./blocked.js'),
    'block comments must be stripped too',
  );
});
