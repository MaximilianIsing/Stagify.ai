// Tier: drift guard (static analysis of public/styles/) — the phone dropdown's escape.
//
// WHAT THIS COVERS
// Below 768px `.staging-menu__panel` is `position:fixed` so that NO ancestor's
// overflow can clip it. It hangs ~134px below a ~32px nav row, and three ancestors
// clip the X axis (`.nav-center` always; `.nav` and `.site-header` on pages loading
// home.css). `overflow-x:clip` with `overflow-y:visible` must not clip vertically, and
// Chromium and Playwright's WebKit both honour that — but real iOS Safari resolves the
// pair the legacy way and erased the panel. It was reported as "opens then disappears
// after a second"; the phone's own event log showed data-open still true, opacity 1
// and the rect correct at 224x134 — logically open, never painted.
//
// `position:fixed` only escapes if nothing in the chain establishes a containing block
// for fixed descendants. `transform`, `filter`, `backdrop-filter`, `will-change`,
// `contain` and `perspective` all do. Any one of them added to the nav chain silently
// re-traps the panel and brings the bug back — on iPhones only, where nobody here can
// see it. That is what this guard is for: the failure is invisible in every emulator
// available (6 pages x 4 widths x 2 engines all render it perfectly), so a browser
// test cannot be the safety net and a static one has to be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STYLES = path.join(ROOT, 'public', 'styles');

// Every element between the panel and the viewport, by class. `.staging-menu` is the
// wrapper, the rest is the nav chain up to the sticky header.
const CHAIN_CLASSES = new Set(['staging-menu', 'nav-center', 'nav', 'site-header']);

/**
 * Does this selector STYLE a chain element, as opposed to merely mentioning one?
 *
 * Keyed on the subject — the last compound — not on the whole string. The real sheet
 * writes `.site-header .nav-center{position:relative}`, so an exact-string list misses
 * the single most likely place for someone to add a transform, while flagging
 * `.site-header .nav-link` (subject `.nav-link`) which cannot trap anything.
 *
 * A `::pseudo-element` subject is deliberately NOT a hit: the pseudo is a child box,
 * not the element, so a filter there traps nothing — that is exactly the escape hatch
 * `.site-header::before` uses to keep its blur, and flagging it would make this guard
 * forbid its own fix. A `:pseudo-class` still styles the element, so it counts.
 *
 * @param {string} selector
 */
function stylesChainElement(selector) {
  const last = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';
  if (last.includes('::')) return false;
  const base = last.split(':')[0];
  return [...base.matchAll(/\.([\w-]+)/g)].some((m) => CHAIN_CLASSES.has(m[1]));
}

// Properties that make an element the containing block for position:fixed children.
const TRAPS = ['transform', 'filter', 'backdrop-filter', 'perspective', 'will-change', 'contain'];

/**
 * Every declaration block in a sheet, comment-stripped, as {selectors, body}.
 *
 * Stripping matters: the styles.css comment explaining this fix names every one of
 * the trap properties, so a raw-text scan reports the fix's own prose as a violation.
 *
 * @param {string} file
 */
function rules(file) {
  const src = fs.readFileSync(path.join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({
      selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
      body: m[2],
    });
  }
  return out;
}

const sheets = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'));

test('nothing in the nav chain traps a position:fixed descendant', () => {
  const offenders = [];
  for (const sheet of sheets) {
    for (const rule of rules(sheet)) {
      const hits = rule.selectors.filter(stylesChainElement);
      if (!hits.length) continue;
      for (const prop of TRAPS) {
        // `-webkit-` variants count too, and `will-change:auto` / `contain:none` are
        // the inert defaults rather than a trap.
        const m = rule.body.match(new RegExp(`(^|[;\\s])(-webkit-)?${prop}\\s*:\\s*([^;]+)`));
        if (!m) continue;
        const value = m[3].trim();
        if (value === 'none' || value === 'auto') continue;
        offenders.push(`${sheet}  ${hits.join(',')}  ${prop}:${value}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A nav ancestor now establishes a containing block for position:fixed children, so '
      + 'the phone Staging panel is trapped inside the overflow boxes again and iOS Safari '
      + 'will clip it away — invisibly to every emulator here. Put the effect on a '
      + '::before/::after instead, the way .site-header does with its blur.\n  '
      + offenders.join('\n  '),
  );
});

test('the phone panel is still position:fixed, which is what does the escaping', () => {
  const found = rules('styles.css').filter(
    (r) => r.selectors.includes('.staging-menu__panel') && /(^|[;\s])position\s*:\s*fixed/.test(r.body),
  );
  assert.equal(
    found.length,
    1,
    'the mobile `.staging-menu__panel{position:fixed}` rule is gone. Reverting it to '
      + 'absolute puts the panel back inside .nav-center\'s overflow box, which is the '
      + 'iOS clipping bug. The guard above is satisfied by deleting this rule, so this '
      + 'half exists to make that fail too.',
  );
  // The offsets it needs are JS-written customs with no-JS fallbacks; a bare
  // `position:fixed` with no top/left would land the panel at its static position.
  assert.match(found[0].body, /top\s*:\s*var\(--staging-panel-top/);
  assert.match(found[0].body, /left\s*:\s*var\(--staging-panel-left/);
});
