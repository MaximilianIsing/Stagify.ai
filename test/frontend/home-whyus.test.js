// Tier: frontend island logic (DOM-stubbed) — public/scripts/home-whyus.js.
//
// #why is a scoreboard: six factors x five ways to stage a listing (us, a traditional
// stager, a per-image AI tool, doing it yourself, empty rooms). It replaced the old
// two-card "Stagify vs Others" layout on 2026-08-10 — see the note above .whyus-board
// in index.html. The module adds exactly one behaviour, column focus. The first cut
// also had ten rows, row-group filter pills and a live "clear wins" tally; all three
// were pulled the same day, so the table now has one view and no footer.
//
// Two kinds of assertion live here:
//
//   1. Behaviour, against a fake DOM (no jsdom in this repo — same approach as
//      test/frontend/app/tilt-effect.test.js). The interesting cases are the ones a
//      screenshot cannot show: that a pin actually locks out hover, that the `us`
//      column is never the thing being switched to, and that at rest the board carries
//      NO focus attribute — the progressive-enhancement contract, since every dim rule
//      in home.css is scoped behind [data-vs-col-focus].
//
//   2. Drift guards over the real index.html, because all three failures they catch are
//      invisible in review AND in a local browser check:
//
//      - A ragged row: a factor missing a column, or naming one that has no header.
//        Every cell is addressed by [data-vs-col], so a typo silently drops that cell
//        out of both the dimming and the arithmetic a reader does in their head.
//      - The section quietly becoming a sales sheet again. The board's whole claim to
//        credibility is that it concedes rows; a change that leaves us winning
//        everything has changed what the section IS, not just what it says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const { initWhyUs } = await import('../../public/scripts/home-whyus.js');

/** The competitor columns, in the order the header uses them. `us` has no button. */
const RIVALS = ['stager', 'ai', 'diy', 'empty'];

// ---- Minimal fake DOM ------------------------------------------------------

/** A node that records its listeners and can replay them. */
function makeEl(/** @type {Record<string, string>} */ attrs = {}) {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  return {
    attrs,
    handlers,
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
      (handlers[type] ||= []).push(fn);
    },
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) { attrs[k] = String(v); },
    getAttribute(/** @type {string} */ k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(/** @type {string} */ k) { delete attrs[k]; },
    fire(/** @type {string} */ type) { for (const fn of handlers[type] || []) fn.call(this, {}); },
  };
}

/**
 * Build a board: five column headers, four of them with a button.
 * `missingButtonOn` drops one rival's button, to exercise the skip guard.
 */
function mount({ missingButtonOn = '' } = {}) {
  const headers = [];
  for (const key of ['us', ...RIVALS]) {
    const th = makeEl({ 'data-vs-col': key });
    const btn = key === 'us' || key === missingButtonOn
      ? null
      : makeEl({ 'aria-pressed': 'false' });
    headers.push({ key, th, btn });
    th.querySelector = (/** @type {string} */ sel) => (sel === '.whyus-col' ? btn : null);
  }

  const board = makeEl();
  board.querySelectorAll = (/** @type {string} */ sel) =>
    (sel === '.whyus-th[data-vs-col]' ? headers.map((h) => h.th) : []);
  globalThis.document = /** @type {any} */ ({
    querySelector: (/** @type {string} */ sel) => (sel === '.whyus-board' ? board : null),
  });
  return { board, headers };
}

/** The header entry for one column key. */
const col = (/** @type {any[]} */ headers, /** @type {string} */ key) =>
  headers.find((h) => h.key === key);

// ---- 1. The rest state IS the no-JS state ----------------------------------

test('at rest the board carries no column-focus attribute', () => {
  const { board } = mount();
  initWhyUs();

  // home.css scopes every dim rule behind [data-vs-col-focus]. If merely wiring the
  // module set it, four of the six columns would render greyed before anyone touched
  // the section.
  assert.equal(board.getAttribute('data-vs-col-focus'), null);
});

// ---- 2. Column focus -------------------------------------------------------

test('hovering a rival column focuses it; leaving clears it', () => {
  for (const key of RIVALS) {
    const { board, headers } = mount();
    initWhyUs();

    col(headers, key).btn.fire('pointerenter');
    assert.equal(board.getAttribute('data-vs-col-focus'), key);

    col(headers, key).btn.fire('pointerleave');
    assert.equal(board.getAttribute('data-vs-col-focus'), null);
  }
});

test('keyboard focus does the same thing as hover', () => {
  const { board, headers } = mount();
  initWhyUs();

  col(headers, 'ai').btn.fire('focus');
  assert.equal(board.getAttribute('data-vs-col-focus'), 'ai');
  col(headers, 'ai').btn.fire('blur');
  assert.equal(board.getAttribute('data-vs-col-focus'), null);
});

test('our own column is never wired as something to switch to', () => {
  // `us` is the fixed half of every head-to-head. If it were focusable the CSS would
  // be asked to dim the column it also pins bright, which is a contradiction the
  // stylesheet resolves silently and wrongly.
  const { headers } = mount();
  initWhyUs();

  assert.equal(col(headers, 'us').btn, null);
  assert.equal(
    headers.filter((h) => h.btn).length,
    RIVALS.length,
    'exactly the four rivals should carry a button',
  );
});

// ---- 3. Pinning ------------------------------------------------------------

test('clicking pins a column, and a pin locks out hover', () => {
  const { board, headers } = mount();
  initWhyUs();

  col(headers, 'stager').btn.fire('click');
  assert.equal(board.getAttribute('data-vs-col-focus'), 'stager');
  assert.equal(col(headers, 'stager').btn.getAttribute('aria-pressed'), 'true');

  // Hovering elsewhere while pinned must change nothing, or the pin is decorative —
  // and on a phone, where the table scrolls sideways, the pin is the only way in.
  col(headers, 'diy').btn.fire('pointerenter');
  assert.equal(board.getAttribute('data-vs-col-focus'), 'stager');
  col(headers, 'diy').btn.fire('pointerleave');
  assert.equal(board.getAttribute('data-vs-col-focus'), 'stager');
});

test('clicking the pinned column again releases it and clears aria-pressed', () => {
  const { board, headers } = mount();
  initWhyUs();

  col(headers, 'stager').btn.fire('click');
  col(headers, 'stager').btn.fire('click');
  assert.equal(board.getAttribute('data-vs-col-focus'), null);
  assert.equal(
    headers.filter((h) => h.btn).every((h) => h.btn.getAttribute('aria-pressed') === 'false'),
    true,
    'releasing must clear aria-pressed everywhere, not just visually undim',
  );
});

test('clicking a different column moves the pin rather than adding a second one', () => {
  const { board, headers } = mount();
  initWhyUs();

  col(headers, 'stager').btn.fire('click');
  col(headers, 'empty').btn.fire('click');

  assert.equal(board.getAttribute('data-vs-col-focus'), 'empty');
  const pressed = headers.filter((h) => h.btn && h.btn.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map((h) => h.key), ['empty']);
});

// ---- 4. A malformed header degrades to inert, not to a dead section ---------

test('a header missing its button costs that column its highlight and nothing else', () => {
  const { board, headers } = mount({ missingButtonOn: 'ai' });
  initWhyUs();

  assert.equal(col(headers, 'ai').btn, null);
  for (const key of ['stager', 'diy', 'empty']) {
    col(headers, key).btn.fire('pointerenter');
    assert.equal(board.getAttribute('data-vs-col-focus'), key, `${key} lost its wiring too`);
    col(headers, key).btn.fire('pointerleave');
  }
});

// ---- 5. Drift guards over the real markup ----------------------------------

/** index.html with comments removed — a comment naming a selector must not satisfy a guard. */
function boardMarkup() {
  const html = fs
    .readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const start = html.indexOf('class="whyus-board');
  const end = html.indexOf('</section>', start);
  assert.ok(start > 0 && end > start, 'index.html no longer has a .whyus-board section');
  return html.slice(start, end);
}

/** Every `<tr>` of the real board's body, as `{ col: score }`. */
function boardRows() {
  const markup = boardMarkup();
  const body = markup.slice(markup.indexOf('<tbody>'), markup.indexOf('</tbody>'));
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, chunk]) => ({
    factor: (/<th scope="row"[^>]*><span[^>]*>([^<]+)</.exec(chunk) || ['', '?'])[1],
    cells: Object.fromEntries(
      [...chunk.matchAll(/data-vs-col="([^"]+)" data-vs-score="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    ),
  }));
}

/** The five column keys the header declares, in order. */
function boardColumns() {
  const markup = boardMarkup();
  const head = markup.slice(markup.indexOf('<thead>'), markup.indexOf('</thead>'));
  return [...head.matchAll(/<th scope="col"[^>]*data-vs-col="([^"]+)"/g)].map((m) => m[1]);
}

test('the section offers exactly one view of the table, and no footer tally', () => {
  // All three were pulled on purpose (see the note above .whyus-board). The pills hid
  // what six rows already show, and needed JS to do it. The tally is worse than absent
  // over six rows: a wins-count hands "leave rooms empty" three of them, because doing
  // nothing really is instant, really is free, and really does leave you owning the
  // photos. Bring either back and this guard is the conversation to have first.
  const markup = boardMarkup();
  for (const gone of [
    'whyus-filter', 'whyus-controls', 'whyus-hint', 'data-vs-group',
    'tfoot', 'whyus-scorerow', 'data-vs-total', 'is-lead',
  ]) {
    assert.equal(markup.includes(gone), false, `"${gone}" is back in #why — see the note in this test`);
  }
});

test('every row carries a cell for every column, and no others', () => {
  // Cells are addressed only by [data-vs-col], so a typo does not render as a gap —
  // it renders as a normal-looking cell that no longer dims and no longer scores.
  const columns = boardColumns();
  assert.deepEqual(columns, ['us', 'stager', 'ai', 'diy', 'empty'], 'the header lost or renamed a column');

  const rows = boardRows();
  assert.ok(rows.length >= 5, 'guard would be near-vacuous with fewer than five rows');

  for (const { factor, cells } of rows) {
    assert.deepEqual(
      Object.keys(cells),
      columns,
      `the "${factor}" row does not carry exactly the five header columns in order`,
    );
  }
});

test('every cell takes one of the three verdicts — there is no n/a', () => {
  // "1" | "0.5" | "0" are all the stylesheet draws a glyph for. Anything else falls
  // through to the fail-soft neutral dot — silently, in a cell that still reads like a
  // real answer, so a typo here looks like a design choice rather than a bug.
  //
  // "" is deliberately NOT allowed. The board had one n/a cell (an empty room and
  // "trying a different look") until 2026-08-10, when it became a loss instead: an
  // empty room does not sit that row out, it fails it. Its styling and its
  // `whyUs.board.values.na` string were retired with it, in all eleven packs — so a
  // cell that reintroduces "" would ship an unstyled, untranslated blank, and this is
  // the assertion that says bring those back too.
  for (const { factor, cells } of boardRows()) {
    for (const [column, score] of Object.entries(cells)) {
      assert.ok(
        ['1', '0.5', '0'].includes(score),
        `the "${factor}" / ${column} cell scores "${score}", which nothing renders`,
      );
    }
  }
});

test('the board still concedes rows to somebody else', () => {
  // This is the assertion that protects what the section IS. The board earns its other
  // rows by admitting the ones we lose; a board where `us` sweeps every factor is the
  // strawman-vs-Others layout this replaced, wearing a table.
  const rows = boardRows();
  const lost = rows.filter((r) => r.cells.us !== '1');
  assert.ok(
    lost.length >= 2,
    `only ${lost.length} row(s) are conceded — the scoreboard's credibility is that it ` +
      'names the alternatives that beat us. Do not delete a losing row to tidy the column.',
  );

  // ...and somebody has to actually win them, or "conceded" just means "n/a for all".
  for (const row of lost) {
    assert.ok(
      Object.entries(row.cells).some(([c, score]) => c !== 'us' && score === '1'),
      `the "${row.factor}" row we lose is won by nobody — that is a hole, not a concession`,
    );
  }
});

test('translation keys sit on an inner span, never on a cell', () => {
  // The board uses data-lang (textContent), not data-lang-html, so it is not the
  // innerHTML trap that killed the old layout — it is the same trap one edit away.
  // language-loader.js writes textContent on every [data-lang] node, so a key moved
  // onto a <td> would delete the mark <i> inside it and take the ✓/✗ glyph with it.
  const markup = boardMarkup();
  assert.equal(
    /<t[dh][^>]*\bdata-lang(-html)?=/.test(markup),
    false,
    'a board cell carries data-lang directly — language-loader.js writes textContent ' +
      'on that node, so it would delete the .whyus-mark glyph nested inside it.',
  );

  const cells = markup.match(/<td class="whyus-cell"[^>]*>/g) || [];
  const wired = markup.match(/<i class="whyus-mark" aria-hidden="true"><\/i><span data-lang=/g) || [];
  assert.ok(cells.length >= 20, `only ${cells.length} value cells found — the regex has drifted`);
  assert.equal(
    wired.length,
    cells.length,
    'every value cell must be mark + span[data-lang], the shape the NAR legend uses',
  );
});
