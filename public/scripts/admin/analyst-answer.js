// How an analyst answer becomes DOM.
//
// WHY THIS EXISTS AT ALL. The system prompt (lib/services/admin-analyst.js) asks
// the model for "a small markdown table when you are genuinely comparing rows",
// and comparing rows is most of what an operator asks for. The drawer used to
// split on blank lines and append the rest as text nodes, so every one of those
// tables arrived as a wall of pipes and dashes — the prompt and the renderer
// disagreed, and the prompt was right. A model that writes `- ` lists (they all
// do, whatever the prompt says) got the same treatment: single newlines were
// collapsed, so five bullets ran together into one sentence-shaped paragraph.
//
// WHY IT IS NOT A MARKDOWN LIBRARY. Everything here is built with `el()` and text
// nodes, and NOTHING is ever assigned to innerHTML. Two independent reasons, as
// in analyst.js: the model's output is untrusted, and it carries `acct_*` handles
// that are resolved to real addresses on the way to the DOM — so this is both an
// injection sink and the one place a customer's address could be spliced into
// markup. A markdown library would be a third-party innerHTML path through both.
//
// The grammar is therefore deliberately small: paragraphs, pipe tables, bullet and
// numbered lists, `**bold**` and `` `code` ``. Anything else is text.

import { el } from './helpers.js';

/** A line that opens or continues a pipe table. */
const TABLE_ROW_RE = /^\s*\|.*\|?\s*$/;
/** A table's header underline: `|---|:--:|`. Carries no data, only alignment. */
const DIVIDER_RE = /^[\s|:-]*-[\s|:-]*$/;
const BULLET_RE = /^\s*[-*•]\s+/;
const ORDERED_RE = /^\s*\d{1,2}[.)]\s+/;
/** A heading the prompt asks the model not to write, and it sometimes writes anyway. */
const HEADING_RE = /^\s*#{1,6}\s+/;
/** Bold and inline code, the only two inline marks worth honouring. */
const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/;

/**
 * Group lines into blocks.
 *
 * Kept separate from rendering so the grammar can be read in one place, and so a
 * test can assert what a given answer parses into without a DOM.
 *
 * @param {string} text
 * @returns {Array<{type: 'para'|'table'|'list', lines: string[], ordered?: boolean}>}
 */
export function parseBlocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  /** @type {Array<{type: any, lines: string[], ordered?: boolean}>} */
  const out = [];
  /** @type {{type: any, lines: string[], ordered?: boolean}|null} */
  let open = null;

  const close = () => { if (open && open.lines.length) out.push(open); open = null; };

  for (const line of lines) {
    if (!line.trim()) { close(); continue; }

    const isTable = TABLE_ROW_RE.test(line) && line.includes('|');
    const isBullet = BULLET_RE.test(line);
    const isOrdered = !isBullet && ORDERED_RE.test(line);
    const type = isTable ? 'table' : (isBullet || isOrdered) ? 'list' : 'para';
    const ordered = isOrdered;

    // A list switching between bulleted and numbered is two lists, not one with a
    // confused marker.
    if (open && (open.type !== type || (type === 'list' && open.ordered !== ordered))) close();
    if (!open) open = { type, lines: [], ordered };
    open.lines.push(line);
  }
  close();
  return out;
}

/**
 * Split one pipe-table row into cells.
 *
 * Leading and trailing pipes are optional — models emit both forms, often in the
 * same table.
 *
 * @param {string} line
 * @returns {string[]}
 */
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Append `text` to `parent`, turning account handles into resolved spans.
 *
 * @param {any} parent
 * @param {string} text
 * @param {(s: string) => Array<{text: string, account: any}>} segment
 */
function appendText(parent, text, segment) {
  segment(text).forEach((seg) => {
    if (!seg.account) { parent.appendChild(document.createTextNode(seg.text)); return; }
    parent.appendChild(el('span', {
      className: 'adm-an-acct',
      textContent: seg.text,
      title: 'Resolved in your browser — the model saw an opaque handle, not this address.',
    }));
  });
}

/**
 * Append one run of prose, honouring bold and inline code.
 *
 * @param {any} parent
 * @param {string} text
 * @param {(s: string) => Array<{text: string, account: any}>} segment
 */
function appendInline(parent, text, segment) {
  String(text).split(INLINE_RE).forEach((part) => {
    if (!part) return;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const strong = el('strong', { className: 'adm-an-strong' });
      appendText(strong, part.slice(2, -2), segment);
      parent.appendChild(strong);
      return;
    }
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      parent.appendChild(el('code', { className: 'adm-an-code', textContent: part.slice(1, -1) }));
      return;
    }
    appendText(parent, part, segment);
  });
}

/** One paragraph. Single newlines inside it are soft wraps, as in markdown. */
function paragraph(lines, segment) {
  const p = el('p', { className: 'adm-an-para' });
  appendInline(p, lines.map((l) => l.replace(HEADING_RE, '')).join(' ').trim(), segment);
  return p;
}

/** A bulleted or numbered list. */
function list(block, segment) {
  const node = el(block.ordered ? 'ol' : 'ul', { className: 'adm-an-list' });
  block.lines.forEach((line) => {
    const item = el('li', { className: 'adm-an-item' });
    appendInline(item, line.replace(BULLET_RE, '').replace(ORDERED_RE, '').trim(), segment);
    node.appendChild(item);
  });
  return node;
}

/**
 * A pipe table.
 *
 * The header is whichever row precedes the divider; a table with no divider is
 * still rendered, with its first row as the header, because a table missing one
 * mark is closer to a table than to a paragraph of pipes.
 */
function table(lines, segment) {
  const rows = lines.map(cells);
  const dividerAt = rows.findIndex((r) => r.length && r.every((c) => DIVIDER_RE.test(c)));
  const headerAt = dividerAt > 0 ? dividerAt - 1 : 0;
  const body = rows.filter((_, i) => i !== dividerAt && i !== headerAt);

  const node = el('table', { className: 'adm-an-table' });
  const head = el('thead');
  const headRow = el('tr');
  rows[headerAt].forEach((c) => {
    const th = el('th');
    appendInline(th, c, segment);
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  node.appendChild(head);

  const tbody = el('tbody');
  body.forEach((r) => {
    const tr = el('tr');
    r.forEach((c) => {
      const td = el('td');
      appendInline(td, c, segment);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  node.appendChild(tbody);
  return node;
}

/**
 * Render one answer.
 *
 * @param {string} text The model's reply, as it arrived.
 * @param {(s: string) => Array<{text: string, account: any}>} segment
 *   `identity.segment` — injected rather than imported so this module holds no
 *   state and the caller keeps the one registry that knows any addresses.
 * @returns {any} A `div.adm-an-prose` ready to append.
 */
export function renderAnswer(text, segment) {
  const wrap = el('div', { className: 'adm-an-prose' });
  parseBlocks(text).forEach((block) => {
    if (block.type === 'table') wrap.appendChild(table(block.lines, segment));
    else if (block.type === 'list') wrap.appendChild(list(block, segment));
    else wrap.appendChild(paragraph(block.lines, segment));
  });
  return wrap;
}
