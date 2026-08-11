// Drift guard: user-facing copy uses the typographic apostrophe (’), not the
// straight ASCII one (').
//
// WHY THIS EXISTS
// The site standardised on ’ on 2026-08-10. Nothing in the app keys off the
// character — apostrophes only ever live in display copy, and both forms are
// announced identically by screen readers — so this is purely typographic. But
// ' is what a keyboard produces and what every translation hand-off produces,
// which is why the pack had drifted to 46 straight against 14 curly before the
// sweep. That ratio is the natural pull, not an accident: without a guard the
// mix comes back, so the guard IS the deliverable here, not the sweep.
//
// WHAT IS CHECKED, AND WHY EACH SURFACE IS SCOPED THE WAY IT IS
//   1. public/languages/*.json — every string VALUE. Keys are ASCII
//      identifiers and are not copy, so they are skipped.
//   2. public/**/*.html — prose and attribute values, but NOT the contents of
//      <script>/<style>. Inline script is code (and, in guides.html, exported
//      third-party data — see the demo exemption below).
//   3. public/scripts/**/*.js — DOUBLE-quoted string literals only. A bare '
//      inside a single-quoted literal is the delimiter (`return'free'`), and
//      comments are prose written for developers, not users.
//
// WHAT IS DELIBERATELY NOT CHECKED
//   - Primes. `12' × 15'` in the dorm-room article is feet, not an apostrophe,
//     so the patterns below are anchored to LETTERS on both sides (and to a
//     plural `s` for the possessive case). A digit-adjacent ' is legal.
//   - public/scripts/demo-data.js and the HowTo JSON-LD in guides.html. Both
//     are generated from to-build/demos/demos.json, which is a Supademo export
//     — hand-curling it would be undone by the next export. If that pipeline
//     ever starts emitting ’, delete the exemption rather than working around
//     it.
//
// DOUBLE QUOTES ARE ONLY HALF DONE, ON PURPOSE
// English prose uses “ ”, and the fourth test below pins that. The other ten
// packs are NOT checked, because unlike the apostrophe there is no single right
// answer: French/Russian/Italian take « », German „ “, Japanese 「 」. A blind
// curly rule would make four already-correct packs wrong. Five packs (nl, zh,
// ko, pt, es) are still internally mixed and need a per-language editorial pass
// before they can be pinned — when that happens, the check to add is per-pack
// (only that language's marks may appear), not a global one.
//
// The legal pages are exempt: terms.html, privacy.html and legal/** are 108 of
// the straight quotes on the site, and nearly all of them are defined contract
// terms ("Service", "Agreement"). Reformatting an agreement for typography is
// not a copy fix, so they keep ASCII quotes deliberately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/** letter'letter — don't, it's, l'image. Never a prime, never a delimiter. */
const INNER = /(?<=\p{L})'(?=\p{L})/gu;
/** Plural possessive: agents' listings. Anchored to a following boundary. */
const POSSESSIVE = /(?<=s)'(?=[\s.,;:!?)<]|$)/g;

/** Generated from a third-party export — see the header. */
const DEMO_EXEMPT = /demo-data\.js$/;

function walk(dir, pred, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'media-webp' || entry.name === 'fonts') continue;
      walk(full, pred, out);
    } else if (pred(full)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/** Every straight apostrophe in `text`, as `line:excerpt` strings. */
function offenders(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (!INNER.test(line) && !POSSESSIVE.test(line)) return;
    INNER.lastIndex = 0; POSSESSIVE.lastIndex = 0;
    found.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return found;
}

/** Collect every string value in a parsed pack. */
function stringValues(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) stringValues(v, out);
  return out;
}

test('language packs use the typographic apostrophe in every value', () => {
  const langs = path.join(PUBLIC, 'languages');
  const bad = [];
  for (const name of fs.readdirSync(langs).filter(n => n.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(langs, name), 'utf8'));
    for (const value of stringValues(pack)) {
      INNER.lastIndex = 0; POSSESSIVE.lastIndex = 0;
      if (INNER.test(value) || POSSESSIVE.test(value)) bad.push(`${name}: ${value.slice(0, 120)}`);
    }
  }
  assert.deepEqual(bad, [], `straight apostrophes in pack copy — use ’ (U+2019):\n${bad.join('\n')}`);
});

test('served HTML uses the typographic apostrophe outside <script>/<style>', () => {
  const bad = [];
  for (const file of walk(PUBLIC, f => f.endsWith('.html'))) {
    const src = fs.readFileSync(file, 'utf8');
    // Blank out script/style bodies so line numbers survive.
    const prose = src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, m => m.replace(/[^\n]/g, ' '));
    for (const hit of offenders(prose)) bad.push(`${rel(file)}:${hit}`);
  }
  assert.deepEqual(bad, [], `straight apostrophes in page copy — use ’ (U+2019):\n${bad.join('\n')}`);
});

test('frontend fallback copy uses the typographic apostrophe', () => {
  const bad = [];
  for (const file of walk(path.join(PUBLIC, 'scripts'), f => f.endsWith('.js') && !f.endsWith('.min.js'))) {
    if (DEMO_EXEMPT.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const [line, text] of doubleQuoted(src)) {
      INNER.lastIndex = 0;
      if (INNER.test(text)) bad.push(`${rel(file)}:${line}: "${text.slice(0, 110)}"`);
    }
  }
  assert.deepEqual(bad, [], `straight apostrophes in JS fallback copy — use ’ (U+2019):\n${bad.join('\n')}`);
});

/** terms.html, privacy.html, legal/** — see the header. */
const LEGAL = /(terms|privacy)\.html$|[\\/]legal[\\/]/i;

/**
 * Strip everything that is not English prose out of an HTML source: comments
 * (which quote code — `role="img"` — and would read as prose), script/style
 * bodies, and the tags themselves, whose quotes are attribute delimiters.
 * Newlines are preserved so reported line numbers stay true.
 */
function htmlProse(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<[^>]*>/g, blank);
}

test('English prose uses typographic double quotes', () => {
  const bad = [];

  const pack = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', 'english.json'), 'utf8'));
  for (const value of stringValues(pack)) {
    // Tags first: `<a href="x">` inside a copy value is markup, not punctuation.
    if (value.replace(/<[^>]*>/g, '').includes('"')) bad.push(`english.json: ${value.slice(0, 120)}`);
  }

  for (const file of walk(PUBLIC, f => f.endsWith('.html'))) {
    if (LEGAL.test(file)) continue;
    htmlProse(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (line.includes('"')) bad.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }

  assert.deepEqual(bad, [], `straight double quotes in English copy — use “ ” (U+201C/U+201D):\n${bad.join('\n')}`);
});

/**
 * Double-quoted string literals in JS source, as [line, body] pairs.
 *
 * Hand-rolled rather than regexed because the whole point is to tell a literal
 * from a comment from a single-quoted literal: a naive scan reads the ' in
 * `return'free'` as an apostrophe and the one in a `// don't` comment as copy.
 */
function doubleQuoted(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end < 0 ? n : end + 2);
      line += (chunk.match(/\n/g) || []).length;
      i = end < 0 ? n : end + 2; continue;
    }
    if (c === '/' && d === '/') { const end = src.indexOf('\n', i); i = end < 0 ? n : end; continue; }
    if (c === '"') {
      let j = i + 1, body = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { body += src[j]; j++; }
        if (j < n) { body += src[j]; j++; }
      }
      out.push([line, body]);
      line += (body.match(/\n/g) || []).length;
      i = j + 1; continue;
    }
    if (c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i++; }
        if (src[i] === '\n') line++;
        i++;
      }
      i++; continue;
    }
    i++;
  }
  return out;
}
