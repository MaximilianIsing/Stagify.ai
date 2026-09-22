// Tier: frontend island logic — how an analyst answer becomes DOM.
//
// WHAT THIS IS GUARDING. Two things, and the second is the one that matters.
//
// 1. The system prompt asks the model for a markdown table "when you are
//    genuinely comparing rows", which is most of what an operator asks about. The
//    drawer used to append the reply as text nodes split on blank lines, so every
//    one of those tables arrived as a wall of pipes. The prompt and the renderer
//    have to agree, and these tests are where that agreement is written down.
//
// 2. Nothing here may ever reach innerHTML. The model's output is untrusted AND it
//    carries `acct_*` handles that are resolved to real email addresses on the way
//    to the DOM — so a markdown renderer on this path is simultaneously an
//    injection sink and the one place a customer's address could be spliced into
//    markup. The tests below assert that angle brackets in a model reply come out
//    as text, in every block type, because the day that regresses is the day it
//    stops being visible in a screenshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDom } from '../../helpers/admin-dom.js';
import { parseBlocks, renderAnswer } from '../../../public/scripts/admin/analyst-answer.js';

/** Identity segmentation with one known handle, mirroring analyst-identity.js. */
function segmenter(map = {}) {
  return (text) => {
    const out = [];
    let last = 0;
    const re = /\bacct_[0-9a-f]{6}\b/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!map[m[0]]) continue;
      if (m.index > last) out.push({ text: text.slice(last, m.index), account: null });
      out.push({ text: map[m[0]], account: { id: m[0], email: map[m[0]] } });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), account: null });
    return out.length ? out : [{ text, account: null }];
  };
}

/** Flatten a fake node's text, the way a reader sees it. */
function textOf(node) {
  if (!node) return '';
  if (node.children && node.children.length) return node.children.map(textOf).join('');
  return node.textContent || '';
}

/** Every node in the tree with a given tag. */
function find(node, tag) {
  const hits = [];
  const walk = (n) => {
    if (!n) return;
    if (n.tagName === tag) hits.push(n);
    (n.children || []).forEach(walk);
  };
  walk(node);
  return hits;
}

const withDom = (fn) => {
  const dom = makeDom();
  const prev = globalThis.document;
  globalThis.document = /** @type {any} */ (dom);
  try { return fn(dom); } finally { globalThis.document = prev; }
};

// ── The grammar ─────────────────────────────────────────────────────────────

test('blank lines separate paragraphs, single newlines do not', () => {
  const blocks = parseBlocks('First line\nstill the first paragraph.\n\nSecond paragraph.');
  assert.deepEqual(blocks.map((b) => b.type), ['para', 'para']);
  assert.equal(blocks[0].lines.length, 2);
});

test('a run of bullets is one list, and a numbered run beside it is another', () => {
  // A model that switches marker mid-answer is writing two lists, not one with a
  // confused marker.
  const blocks = parseBlocks('- one\n- two\n1. first\n2. second');
  assert.deepEqual(blocks.map((b) => b.type), ['list', 'list']);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true);
});

test('an empty answer parses to no blocks rather than throwing', () => {
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks(null), []);
});

// ── Tables ──────────────────────────────────────────────────────────────────

test('a markdown table becomes a real table, not a wall of pipes', () => {
  withDom(() => {
    const node = renderAnswer(
      'Failures by room:\n\n| Room | Renders | Failed |\n| --- | --- | --- |\n| Dorm | 40 | 9 |\n| Loft | 120 | 2 |',
      segmenter(),
    );

    const [table] = find(node, 'table');
    assert.ok(table, 'the model was asked for tables; they have to render as tables');
    assert.deepEqual(find(node, 'th').map(textOf), ['Room', 'Renders', 'Failed']);
    assert.deepEqual(find(node, 'td').map(textOf), ['Dorm', '40', '9', 'Loft', '120', '2']);
    assert.ok(!textOf(node).includes('---'), 'the divider row is alignment, not data');
  });
});

test('a table without the divider row still renders as a table', () => {
  // Worth tolerating: a table missing one mark is far closer to a table than to a
  // paragraph of pipe characters.
  withDom(() => {
    const node = renderAnswer('| Room | Renders |\n| Dorm | 40 |', segmenter());
    assert.deepEqual(find(node, 'th').map(textOf), ['Room', 'Renders']);
    assert.deepEqual(find(node, 'td').map(textOf), ['Dorm', '40']);
  });
});

test('rows written without outer pipes still line up', () => {
  withDom(() => {
    const node = renderAnswer('| A | B |\n|---|---|\n| 1 | 2 |', segmenter());
    assert.deepEqual(find(node, 'td').map(textOf), ['1', '2']);
  });
});

// ── Lists and inline marks ──────────────────────────────────────────────────

test('bullets render as list items instead of running together', () => {
  withDom(() => {
    const node = renderAnswer('- Dorm: 9 of 40\n- Loft: 2 of 120\n- Studio: 1 of 88', segmenter());
    assert.equal(find(node, 'ul').length, 1);
    assert.deepEqual(find(node, 'li').map(textOf), ['Dorm: 9 of 40', 'Loft: 2 of 120', 'Studio: 1 of 88']);
  });
});

test('bold and inline code are marks, not literal asterisks and backticks', () => {
  withDom(() => {
    const node = renderAnswer('The **Dorm** segment failed on `E_DORM`.', segmenter());
    assert.deepEqual(find(node, 'strong').map(textOf), ['Dorm']);
    assert.deepEqual(find(node, 'code').map(textOf), ['E_DORM']);
    assert.equal(textOf(node), 'The Dorm segment failed on E_DORM.');
  });
});

test('a heading the prompt forbade is shown as text, not as hashes', () => {
  withDom(() => {
    const node = renderAnswer('## Summary\nRenders fell 22%.', segmenter());
    assert.ok(!textOf(node).includes('#'), textOf(node));
    assert.match(textOf(node), /Summary Renders fell 22%\./);
  });
});

// ── Identity and injection ──────────────────────────────────────────────────

test('an account handle resolves inside every block type', () => {
  withDom(() => {
    const seg = segmenter({ acct_4f1a2b: 'jane@example.com' });
    const node = renderAnswer(
      'Email acct_4f1a2b first.\n\n- chase acct_4f1a2b\n\n| Account | Renders |\n| --- | --- |\n| acct_4f1a2b | 40 |',
      seg,
    );

    const spans = find(node, 'span');
    assert.equal(spans.length, 3, 'paragraph, list item and table cell each resolve the handle');
    spans.forEach((s) => {
      assert.equal(s.textContent, 'jane@example.com');
      assert.match(s.attrs.title, /opaque handle/i, 'the tooltip is how the operator knows it stayed local');
    });
    assert.ok(!textOf(node).includes('acct_4f1a2b'));
  });
});

test('markup in a model reply is text, in every block type', () => {
  // The sink this whole module exists to avoid. If any of these ever comes back as
  // an element, the renderer has grown an innerHTML path.
  withDom(() => {
    const evil = '<img src=x onerror=alert(1)>';
    const node = renderAnswer(`${evil}\n\n- ${evil}\n\n| A |\n| --- |\n| ${evil} |`, segmenter());

    assert.equal(find(node, 'img').length, 0);
    assert.equal(find(node, 'script').length, 0);
    assert.ok(textOf(node).includes(evil), 'it stays visible as the text the model actually wrote');
  });
});
