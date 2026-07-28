// Tier: drift guard — the ledger of frontend modules no test ever loads.
//
// WHY THIS EXISTS: `npm run test:coverage` enforces product-source floors
// (scripts/test-coverage.js), but V8 coverage only reports files the run actually
// LOADED. A module under public/scripts/ that no test ever imports contributes to
// neither the numerator nor the denominator — it is invisible to those floors, not
// averaged into them. So raising the coverage floors can never surface it, and a
// brand-new untested frontend file lands with the aggregate percentage unmoved.
//
// This test closes that hole the only way run-based coverage allows: by pinning the
// exact set of never-loaded modules. The list below is a DEBT LEDGER, and the
// assertion is set equality, so it fails in three useful directions:
//   1. a new frontend module arrives with no test  -> must be added here (visible debt)
//   2. a listed module gains a test                -> must be removed here (ratchet)
//   3. a listed module is deleted/renamed          -> must be removed here (no stale rot)
// Only ever shrink this list. Adding an entry is allowed but is a deliberate,
// reviewable act — that is the whole point.
//
// HOW "loaded" IS DETERMINED: statically, by walking the import graph from every
// file under test/ into public/scripts/ and taking the transitive closure. That was
// validated against the real thing — an lcov run of the full suite on 2026-07-28
// reported exactly 39 loaded frontend files, and this walk finds exactly the same
// 39, with zero false positives and zero false negatives. It is checked here rather
// than in the coverage script because `npm test` (which gates the deploy) does not
// run coverage at all; only the separate CI `npm run test:coverage` job does.
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
const SCRIPTS = `${ROOT}/public/scripts`;
const TESTS = `${ROOT}/test`;

// Third-party bundles are excluded from the ledger: they are vendored artifacts,
// not our source, and writing tests for them is not the debt we are tracking.
const EXCLUDED_PREFIXES = ['vendor/'];

// ── the ledger ───────────────────────────────────────────────────────────────
// public/scripts-relative paths, sorted. SHRINK ONLY. See the header.
const UNTESTED = [
  'ai-designer-app.js',
  'ai-designer-gate.js',
  'ai-designer-model-selector.js',
  'ai-designer/chat-messages.js',
  'ai-designer/chat-response.js',
  'ai-designer/image-viewer.js',
  'ai-designer/mask-editor.js',
  'ai-designer/thumbnail-strip.js',
  'app.js',
  'app/background-video.js',
  'app/empty-room-viewer.js',
  'app/furniture-refs.js',
  'app/hero-stats.js',
  'app/stage-mask-editor.js',
  'app/tilt-effect.js',
  'aurora-scrollbar.js',
  'auth.js',
  'card-spotlight.js',
  'carousel.js',
  'demo-data.js',
  'demo-player.js',
  'designer-demo.js',
  'enterprise.js',
  'faq-redirect.js',
  'footer-year.js',
  'getpro.js',
  'gtag.js',
  'guides.js',
  'home-reveal.js',
  'home-text-animate.js',
  'hover-glow.js',
  'index-inline.js',
  'index-lazy-css.js',
  'language-detect.js',
  'language-switcher.js',
  'masking-studio-app.js',
  'masking-studio-gate.js',
  'masking-studio/draw-tools.js',
  'masking-studio/generate-pipeline.js',
  'masking-studio/layers-ui.js',
  'masking-studio/seg-wand.js',
  'masking-studio/session-store.js',
  'masking-studio/snap-refine.js',
  'masking-studio/upload.js',
  'masking-studio/viewer.js',
  'nav-pill.js',
  'plus-cta-auth.js',
  'plus-welcome-confetti.js',
  'print-button.js',
  'reset-password.js',
  'sponsors-scroll.js',
  'stagify-plus-blackhole.js',
  'stagify-plus.js',
  'staging-studio.js',
  'star-border.js',
  'status.js',
];

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
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

/** Absolute paths of every public/scripts module reachable from the test suite. */
function reachableFromTests() {
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
  walkJs(TESTS).forEach(visit);
  while (queue.length) visit(queue.pop());
  return seen;
}

const toRel = (abs) => abs.slice(SCRIPTS.length + 1);
const isExcluded = (rel) => EXCLUDED_PREFIXES.some((p) => rel.startsWith(p));

// ── assertions ───────────────────────────────────────────────────────────────

test('the untested-frontend ledger matches reality exactly (shrink only)', () => {
  const reachable = reachableFromTests();
  const onDisk = walkJs(SCRIPTS).map(toRel).filter((r) => !isExcluded(r));
  const actual = onDisk.filter((r) => !reachable.has(`${SCRIPTS}/${r}`)).sort();

  const pinned = new Set(UNTESTED);
  const actualSet = new Set(actual);
  const newlyUntested = actual.filter((r) => !pinned.has(r));
  const nowTestedOrGone = UNTESTED.filter((r) => !actualSet.has(r));

  assert.deepEqual(
    { newlyUntested, nowTestedOrGone },
    { newlyUntested: [], nowTestedOrGone: [] },
    'The untested-frontend ledger in this file is out of date.\n' +
      `  newlyUntested  -> a frontend module no test loads. Write a test for it, or\n` +
      `                    add it to UNTESTED to record the debt deliberately.\n` +
      `  nowTestedOrGone -> now covered (or deleted/renamed). Remove it from UNTESTED;\n` +
      `                    the ledger only ever shrinks.\n` +
      `  currently ${actual.length} untested of ${onDisk.length} frontend modules.`,
  );
});

test('the ledger is sorted and free of duplicates, so diffs stay readable', () => {
  assert.deepEqual(UNTESTED, [...UNTESTED].sort(), 'UNTESTED must be sorted');
  assert.equal(new Set(UNTESTED).size, UNTESTED.length, 'UNTESTED has duplicate entries');
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
