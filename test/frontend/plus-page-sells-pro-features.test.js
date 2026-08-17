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
//
// WHERE THE PITCH LIVES NOW
// There used to be a feature grid above the comparison table, and this file checked the
// grid and the table separately because they did different jobs. The grid is gone: it
// restated six of the table's rows as cards, so every Stagify+ tool was described twice on
// one page and the two descriptions could drift apart. The long copy moved INTO the row it
// explains, behind the ⓘ button, which is why the pitch check below reads the tooltips.
// Row label and tooltip are still checked separately, for the same reason grid and table
// were: a row whose explanation quietly disappears still LOOKS complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const PLUS_PAGE = 'stagify-plus.html';

/**
 * Each Stagify+ nav row, keyed by its href, mapped to how it is sold on
 * stagify-plus.html: `row` is a phrase from the comparison row's LABEL, `tip` a phrase
 * from the explanation behind that row's ⓘ button.
 *
 * Both are deliberately pieces of the COPY rather than `data-lang` keys: a key proves a
 * string was wired up, a phrase proves a human wrote something about the feature. Keep
 * them short and distinctive enough not to match by accident.
 */
const SOLD_AS = {
  // Sold as the "Masking tool" row — the product name never appears, on purpose.
  'index.html#basic-mask': { row: 'Masking tool', tip: 'Paint over part of a result' },
  'ai-designer.html': { row: 'AI Designer', tip: 'plain language' },
  'masking-studio.html': { row: 'Masking Studio', tip: 'several areas in different colors' },
  'exterior-studio.html': { row: 'Exterior Studio', tip: 'time of day' },
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

/** The comparison table's body, with the site-header already stripped. */
function tableBody() {
  const copy = salesCopy();
  const start = copy.indexOf('<tbody>', copy.indexOf('sp-feature-table'));
  const end = copy.indexOf('</tbody>', start);
  assert.ok(start !== -1 && end > start, 'the comparison table moved — update this guard');
  return copy.slice(start, end);
}

/**
 * The rows, as `{ label, tip }`. A row is only counted if it has BOTH halves, so a row
 * that loses its explanation reads as a missing row here rather than as a complete one.
 */
function rows() {
  const first = (re, header) => (re.exec(header) || ['', ''])[1].trim();
  return [...tableBody().matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map((m) => ({
    label: first(/<span class="sp-row-label"[^>]*>([^<]+)</, m[1]),
    tip: first(/<span class="sp-tip-text"[^>]*>([^<]+)</, m[1]),
  }));
}

test('every comparison row carries an explanation, and every explanation a row', () => {
  // The three parts of a row header are only useful together: a label with no ⓘ button
  // is a row a visitor cannot ask about, and a tip span with no button is copy nothing
  // reaches. The button is counted separately from the span it points at, because the
  // two are wired by id and a copy-paste that duplicates one id silently collapses two
  // rows onto one explanation.
  const body = tableBody();
  const all = rows();
  assert.ok(all.length >= 12, `expected the comparison rows, found ${all.length}`);

  const buttons = [...body.matchAll(/<button[^>]*class="sp-tip-btn"[^>]*aria-describedby="([^"]+)"/g)]
    .map((m) => m[1]);
  const tipIds = [...body.matchAll(/<span class="sp-tip-text" id="([^"]+)"/g)].map((m) => m[1]);

  assert.equal(buttons.length, all.length, 'every row needs exactly one ⓘ button');
  assert.deepEqual([...buttons].sort(), [...tipIds].sort(), 'a ⓘ button points at no tip, or a tip has no button');
  assert.equal(new Set(tipIds).size, tipIds.length, `duplicate tip id — two rows share one explanation: ${tipIds}`);

  const thin = all.filter((r) => !r.label || r.tip.length < 80);
  assert.deepEqual(
    thin.map((r) => `${r.label || '(unlabelled)'}: ${r.tip.length} chars of explanation`),
    [],
    'the tooltip is the only place these features are explained now that the feature grid is gone, ' +
      'so a one-liner there means the page says less than it used to: ',
  );
});

test('the ⓘ buttons stay in one vertical column', () => {
  // The column is a layout the MARKUP has to cooperate with: .sp-row-head is the flex row
  // that pushes each button to the same x. Leave a label and its button loose in the <th>
  // and they lay out inline instead, so every ⓘ lands at a different place, which is the
  // arrangement this replaced. CSS cannot restore the column on its own, and no rendering
  // happens in `node --test`, so the wrapper is what gets pinned.
  const headers = [...tableBody().matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  const loose = headers.filter((header) => {
    const head = /<span class="sp-row-head">([\s\S]*?)<\/span>\s*<span class="sp-tip-text"/.exec(header);
    return !head || !head[1].includes('sp-row-label') || !head[1].includes('sp-tip-btn');
  });
  assert.equal(loose.length, 0, `${loose.length} row header(s) do not wrap label + ⓘ in one .sp-row-head`);
});

test('no explanation uses an em dash, in the markup or in any pack', () => {
  // A copy rule the author asked for (2026-08-16), and one that only a guard can hold:
  // the strings live in eleven files, the dash is what a rewrite naturally reaches for,
  // and nothing about the page breaks when one comes back. The CJK double form is
  // included because zh/ja reach for —— rather than —.
  const DASH = /[—–―]/;

  for (const row of rows()) {
    assert.doesNotMatch(row.tip, DASH, `${PLUS_PAGE}: the "${row.label}" tooltip uses a dash`);
  }

  const langs = path.join(PUBLIC, 'languages');
  const files = fs.readdirSync(langs).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 11, `expected 11 language packs, found ${files.length}`);
  const offenders = [];
  for (const file of files) {
    const tips = JSON.parse(fs.readFileSync(path.join(langs, file), 'utf8'))?.stagifyPlus?.compare?.tips ?? {};
    for (const [key, value] of Object.entries(tips)) {
      if (DASH.test(String(value))) offenders.push(`${file} → tips.${key}`);
    }
  }
  assert.deepEqual(offenders, [], 'dashes came back in the tooltip copy: ');
});

test('every Stagify+ tool is PITCHED in its row tooltip', () => {
  // Scoped to the tooltips, not the whole page, and that scoping is the assertion. The
  // row LABELS already name three of the four tools, so a check that searched the row
  // header as a whole would stay green with every explanation deleted — which is the
  // exact regression this test exists to catch, one structure later.
  const tips = rows().map((r) => r.tip).join('\n');
  const missing = Object.entries(SOLD_AS).filter(([, { tip }]) => !tips.includes(tip));
  assert.deepEqual(
    missing.map(([href, { tip }]) => `${href} (looked for "${tip}")`),
    [],
    `${PLUS_PAGE}'s row tooltips no longer explain: `,
  );
});

test('the guard reads the SALES COPY, not the nav that is copied onto the same page', () => {
  // The failure mode this whole file is built around. Every product name is already
  // present inside the shared header, so a check that forgot to strip it would pass with
  // the entire comparison table deleted — and would keep passing forever.
  const html = fs.readFileSync(path.join(PUBLIC, PLUS_PAGE), 'utf8');
  assert.ok(html.includes('Masking Studio'), 'sanity: the whole file mentions it');
  assert.ok(!salesCopy().includes('staging-menu__item'), 'the nav must be gone from what we search');
  // And prove the strip actually removes something rather than silently no-opping.
  assert.ok(salesCopy().length < html.length - 1000, 'the header strip removed a real block');
});

test('the plan comparison has a row for every Stagify+ tool too', () => {
  // The tooltip is the pitch; the row is what someone scans when they are deciding. A
  // tool explained in a tooltip but attached to no row of its own would be sold in a
  // place nobody opens, so the label is checked independently of the copy behind it.
  const labels = rows().map((r) => r.label);
  assert.ok(labels.length >= 12, `expected the comparison rows, found ${labels.length}`);

  // Matched loosely, because the table abbreviates ("Masking Studio (multi-area)").
  for (const [href, { row }] of Object.entries(SOLD_AS)) {
    assert.ok(
      labels.some((label) => label.includes(row)),
      `no comparison row for ${href} — expected one mentioning "${row}", got: ${labels.join(' | ')}`,
    );
  }
});
