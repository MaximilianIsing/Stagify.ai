// Tier: drift guard — every Stagify+ tool in the nav is actually SOLD on the Stagify+ page.
//
// WHY THIS EXISTS
// The Exterior Studio shipped complete — route, gate, studio page, eleven language packs,
// its own row in the Staging dropdown — and `stagify-plus.html` said nothing about it. The
// one page whose entire job is to convince somebody to pay for Stagify+ did not mention
// the newest reason to. Nothing failed, because nothing connects the two: the nav is built
// from markup, the sales page is hand-written copy, and neither knows the other exists.
//
// WHY IT IS A LEDGER AND NOT A NAME MATCH
// The obvious guard — "the row's label must appear on the sales page" — is wrong twice
// over:
//
//   1. It would pass VACUOUSLY. The shared site-header is copied onto stagify-plus.html
//      too, so every row's label is already on that page, inside the nav. A whole-file
//      grep is satisfied by the very markup it is meant to be checking against. (The
//      header is stripped below for exactly this reason; without that, this file would
//      pass with the entire feature grid deleted.)
//   2. Marketing copy legitimately renames things. "Basic Mask" is sold as the "Masking
//      tool" card — "Paint over any area to change or restyle just that part of the
//      photo" — and no reasonable page would call it Basic Mask. A guard that demanded it
//      would be wrong more often than the page.
//
// So the mapping is stated explicitly. Adding a fifth Stagify+ tool forces whoever adds it
// to say where it is sold — or to write down, on purpose, that it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const PLUS_PAGE = 'stagify-plus.html';

/**
 * Each Stagify+ nav row, keyed by its href, mapped to a phrase that sells it on
 * stagify-plus.html.
 *
 * The phrase is deliberately a piece of the COPY rather than a `data-lang` key: a key
 * proves a string was wired up, this proves a human wrote something about the feature.
 * Keep it short and distinctive enough not to match by accident.
 */
const SOLD_AS = {
  // Sold as the "Masking tool" card — the product name never appears, on purpose.
  'index.html#basic-mask': 'Paint over any area',
  'ai-designer.html': 'AI Designer',
  'masking-studio.html': 'Masking Studio',
  'exterior-studio.html': 'Exterior Studio',
};

/** The Stagify+ page with the shared site-header removed. */
function salesCopy() {
  const html = fs.readFileSync(path.join(PUBLIC, PLUS_PAGE), 'utf8');
  const start = html.indexOf('<header class="site-header">');
  const end = html.indexOf('</header>');
  assert.ok(start !== -1 && end > start, 'the shared header moved — this guard must still strip it');
  return html.slice(0, start) + html.slice(end + '</header>'.length);
}

/** Every Stagify+ row in the Staging dropdown, by href. */
function proRowHrefs() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const start = html.indexOf('<div class="staging-menu"');
  assert.notEqual(start, -1, 'the staging menu moved');
  const block = html.slice(start, html.indexOf('</div>', html.indexOf('staging-menu__panel')));
  return [...block.matchAll(/<a\b([^>]*)>/g)]
    .filter((m) => m[1].includes('data-staging-pro'))
    .map((m) => /href="([^"]+)"/.exec(m[1])?.[1])
    .filter(Boolean);
}

test('the ledger lists exactly the Stagify+ tools the nav offers', () => {
  // Fails in both directions: a new Pro row with no entry, and a stale entry for a tool
  // that no longer exists.
  const hrefs = proRowHrefs();
  assert.ok(hrefs.length >= 4, `expected the Stagify+ rows, found ${hrefs.length}`);
  assert.deepEqual(
    [...hrefs].sort(),
    Object.keys(SOLD_AS).sort(),
    'a Stagify+ tool was added to or removed from the nav — say where it is sold',
  );
});

/** Just the feature grid — the pitch, as opposed to the comparison table. */
function featureGrid() {
  const copy = salesCopy();
  const start = copy.indexOf('<div class="sp-feature-grid">');
  assert.notEqual(start, -1, 'the feature grid moved — update this guard');
  const end = copy.indexOf('</section>', start);
  const grid = copy.slice(start, end);
  assert.ok(grid.includes('sp-feature glass'), 'sanity: the grid still holds feature cards');
  return grid;
}

test('every Stagify+ tool is PITCHED in the feature grid', () => {
  // Scoped to the grid, not the whole page, and that scoping is the assertion. Searching
  // the whole page let a deleted feature card pass because the tool's name still appeared
  // in the comparison table one section below — so the pitch could vanish while the guard
  // stayed green. Grid and table are checked separately because they do different jobs.
  const grid = featureGrid();
  const missing = Object.entries(SOLD_AS).filter(([, phrase]) => !grid.includes(phrase));
  assert.deepEqual(
    missing.map(([href, phrase]) => `${href} (looked for "${phrase}")`),
    [],
    `${PLUS_PAGE}'s feature grid no longer pitches: `,
  );
});

test('the guard reads the SALES COPY, not the nav that is copied onto the same page', () => {
  // The failure mode this whole file is built around. Every product name is already
  // present inside the shared header, so a check that forgot to strip it would pass with
  // the entire feature grid deleted — and would keep passing forever.
  const html = fs.readFileSync(path.join(PUBLIC, PLUS_PAGE), 'utf8');
  assert.ok(html.includes('Masking Studio'), 'sanity: the whole file mentions it');
  assert.ok(!salesCopy().includes('staging-menu__item'), 'the nav must be gone from what we search');
  // And prove the strip actually removes something rather than silently no-opping.
  assert.ok(salesCopy().length < html.length - 1000, 'the header strip removed a real block');
});

test('the plan comparison covers every Stagify+ tool too', () => {
  // The feature grid is the pitch; the comparison table is what someone reads when they
  // are deciding. A tool that appears in one and not the other reads as an oversight in
  // whichever they looked at second.
  const copy = salesCopy();
  const table = copy.slice(copy.indexOf('sp-feature-table'), copy.indexOf('</table>'));
  assert.ok(table.length > 200, 'the comparison table moved — update this guard');
  const rows = [...table.matchAll(/<th scope="row"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.ok(rows.length >= 8, `expected the comparison rows, found ${rows.length}`);

  // Matched loosely against the row labels, because the table abbreviates ("Masking
  // Studio (multi-area)") where the grid does not.
  for (const [href, phrase] of Object.entries(SOLD_AS)) {
    if (href === 'index.html#basic-mask') continue; // sold as "Masking tool" in the table
    const name = phrase;
    assert.ok(
      rows.some((r) => r.includes(name)),
      `no comparison row for ${href} — expected one mentioning "${name}", got: ${rows.join(' | ')}`,
    );
  }
});
