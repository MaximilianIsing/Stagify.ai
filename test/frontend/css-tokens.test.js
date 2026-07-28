// Tier: drift guard (static analysis of public/styles/) — the design tokens.
//
// WHAT THIS COVERS
// A review found the tokens were being ignored: ai-designer.css had 1 var() in 2,034
// lines, and 994 colour literals sat across the sheets. The cause was not laziness —
// the token set described a palette the app did not paint with. #2563eb appeared 183
// times across 16 files with no token at all, while --primary (#1e40af) appeared 22.
// admin.css had independently named the same two blues in a private --adm-* namespace,
// which is why it looked "properly tokenized".
//
// The one-time substitution is not the deliverable; these guards are. Three rules:
//
//   1. A sheet may only use a token that is actually in scope on every page serving
//      it. This is the failure mode a naive sweep causes: `color: var(--brand)` in a
//      sheet on a page without styles.css resolves to nothing and the whole
//      declaration is DROPPED — silently, and only on that page.
//   2. A sheet that has the tokens in scope must not hard-code a colour that has one.
//   3. Every var() must resolve to a token defined somewhere in scope (catches typos,
//      which fail exactly as silently).
//
// Deliberately NOT guarded — see docs/guides/frontend.md: duplicate top-level
// selectors, and !important. Both were in the same finding, and both are legitimate
// CSS more often than not here (`a,b {shared} b {specialize}` reads as a "duplicate"
// to any scanner), so a test would cry wolf rather than catch a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'public');
const STYLES = path.join(PUB, 'styles');

// Copies of a build source, or generated: excluded from the "use the tokens" rule
// because editing the served file is undone by the next export.
// to-build/demos/README.md maps demo-player.css → public/styles/demo-player.css.
const GENERATED = new Set(['demo-player.css']);

const norm = (h) => {
  const s = h.toLowerCase();
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
};

/** Every .html under public/, excluding asset dirs. */
function htmlPages() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['styles', 'scripts', 'fonts', 'media-webp', 'languages'].includes(e.name)) walk(p);
      } else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(PUB);
  return out;
}

/** sheet filename -> Set of pages that link it (any href form: relative or root-absolute). */
function sheetUsage() {
  const usage = new Map();
  for (const page of htmlPages()) {
    const src = fs.readFileSync(page, 'utf8');
    for (const m of src.matchAll(/href="[^"]*?styles\/([a-z0-9-]+\.css)"/g)) {
      if (!usage.has(m[1])) usage.set(m[1], new Set());
      usage.get(m[1]).add(path.relative(PUB, page).replace(/\\/g, '/'));
    }
  }
  return usage;
}

/** Custom properties DEFINED by a sheet, as name -> value. */
function definedTokens(file) {
  const src = fs.readFileSync(path.join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map();
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) map.set(m[1], m[2].trim());
  return map;
}

/**
 * Custom properties a sheet USES and depends on. `var(--x, fallback)` is excluded:
 * a fallback means the declaration survives an undefined token, so it cannot cause
 * the silent drop this guard exists to prevent.
 */
function usedTokens(file) {
  // Comment-blanked: this file's own prose explains the rule using `var(--token)`,
  // and the first run duly reported `--token` as an unresolvable reference.
  const src = codeLines(file).join('\n');
  return new Set(
    [...src.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)].filter((m) => m[2] === ')').map((m) => m[1]),
  );
}

/**
 * Custom properties written at runtime — `el.style.setProperty('--ar', …)`. They are
 * never declared in a sheet, so a purely static scan reads them as unresolvable.
 * demo-player.js drives four of them.
 */
function runtimeSetTokens() {
  const found = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(PUB, 'scripts'));
  return found;
}

/**
 * Lines of a sheet with block comments blanked IN PLACE, so reported line numbers
 * match the file. Stripping comments before splitting shifted every number after the
 * first multi-line comment — which sent the first run of this guard chasing the wrong
 * lines entirely.
 */
function codeLines(file) {
  const src = fs.readFileSync(path.join(STYLES, file), 'utf8');
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return blanked.split('\n');
}

const allSheets = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'));
const usage = sheetUsage();
const runtimeSet = runtimeSetTokens();

// The shared palette: colour tokens declared in styles.css's :root.
const sharedColorTokens = new Map(
  [...definedTokens('styles.css')]
    .filter(([, v]) => /^#[0-9a-fA-F]{3,6}$/.test(v))
    .map(([n, v]) => [norm(v), n]),
);

test('the shared palette is defined and covers the colours actually in use', () => {
  // Sanity: if styles.css stops defining these, every guard below silently passes.
  assert.ok(sharedColorTokens.size >= 15, `expected a real palette, found ${sharedColorTokens.size} colour tokens`);
  for (const hex of ['#2563eb', '#1e3a8a', '#1d4ed8']) {
    assert.ok(sharedColorTokens.has(hex), `${hex} is one of the most-used colours in the app and needs a token`);
  }
});

test('every var() resolves to a token in scope on every page serving that sheet', () => {
  // A var() that resolves to nothing drops its whole declaration — no console error,
  // no build failure, just a wrong colour on one page.
  const problems = [];
  for (const sheet of allSheets) {
    const used = usedTokens(sheet);
    if (!used.size) continue;
    const pages = usage.get(sheet);
    if (!pages) continue; // not served by any page

    for (const page of pages) {
      const pageSrc = fs.readFileSync(path.join(PUB, page), 'utf8');
      const sheetsOnPage = [...pageSrc.matchAll(/href="[^"]*?styles\/([a-z0-9-]+\.css)"/g)].map((m) => m[1]);
      const inScope = new Set();
      for (const s of sheetsOnPage) for (const name of definedTokens(s).keys()) inScope.add(name);

      for (const name of used) {
        // A sheet may define a token for its own use (blog.css carries its own :root).
        if (inScope.has(name) || runtimeSet.has(name)) continue;
        problems.push(`${sheet} uses ${name} but ${page} does not load a sheet defining it`);
      }
    }
  }
  assert.deepEqual(problems, [], `unresolvable token reference(s):\n${problems.join('\n')}`);
});

test('sheets with the palette in scope do not hard-code a colour that has a token', () => {
  // Scoped to sheets served ONLY by pages that load styles.css — the rest keep
  // literals on purpose, since the tokens are not in scope there.
  const offenders = [];
  for (const sheet of allSheets) {
    if (GENERATED.has(sheet) || sheet === 'styles.css') continue;
    const pages = usage.get(sheet);
    if (!pages || pages.size === 0) continue;
    const everyPageHasPalette = [...pages].every((p) =>
      /href="[^"]*?styles\/styles\.css"/.test(fs.readFileSync(path.join(PUB, p), 'utf8')));
    if (!everyPageHasPalette) continue;

    codeLines(sheet).forEach((line, i) => {
      // A sheet's OWN token block may hold literals — that is where a local palette
      // is spelled out (`--adm-ink: #0f172a` has no site-wide counterpart). But a
      // definition whose value duplicates a shared token is still a duplicate, and
      // is reported: that is how `.adm-stat--blue { --adm-tone: #2563eb }` — a
      // fourth copy of the brand blue, inline rather than in the token block —
      // turned up. Only whole-line definitions of a NON-shared colour are skipped.
      const definition = line.match(/^\s*--[\w-]+\s*:\s*(.*)$/);
      if (definition) {
        const hexes = definition[1].match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
        if (!hexes.some((h) => sharedColorTokens.has(norm(h)))) return;
      }
      if (/url\(/i.test(line)) return; // a hex inside an SVG data URI is not a CSS value
      for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        const token = sharedColorTokens.get(norm(m[0]));
        if (token) offenders.push(`${sheet}:${i + 1}  ${m[0]} → var(${token})`);
      }
    });
  }
  assert.deepEqual(offenders, [], `hard-coded colour(s) that already have a token:\n${offenders.join('\n')}`);
});

test('styles.css itself uses its own tokens', () => {
  // The palette's own sheet is the easiest place for a literal to creep back in.
  const offenders = [];
  codeLines('styles.css').forEach((line, i) => {
    if (/^\s*--[\w-]+\s*:/.test(line) || /url\(/i.test(line)) return;
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
      const token = sharedColorTokens.get(norm(m[0]));
      if (token) offenders.push(`styles.css:${i + 1}  ${m[0]} → var(${token})`);
    }
  });
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the served demo-player.css is still byte-identical to its build source', () => {
  // It is excluded from tokenization for this reason: to-build/demos/ is the master
  // and the next export overwrites the served copy. Nothing guarded that before, so
  // the exclusion could have quietly stopped being necessary — or been ignored.
  const served = fs.readFileSync(path.join(STYLES, 'demo-player.css'), 'utf8');
  const master = fs.readFileSync(path.join(ROOT, 'to-build', 'demos', 'demo-player.css'), 'utf8');
  assert.equal(served, master, 'edit to-build/demos/demo-player.css and re-export — not the served copy');
});
