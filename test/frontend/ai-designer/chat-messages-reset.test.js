// Tier: frontend island logic (DOM-shimmed) — resetChatMessages in
// public/scripts/ai-designer/chat-messages.js.
//
// WHY THIS EXISTS: "new chat" used to clear the transcript with a bare
// `chatMessages.innerHTML = ''`. That detaches #typing-indicator and
// #message-image-loading WITHOUT going through removeTypingIndicator /
// removeMessageImageLoading, which are the only two callers of
// clearRotatingStatusText — so every reset performed mid-generation left a 1.5s
// interval running forever against a node no longer in the document, and holding
// the reload button down through long generations stacked them without bound.
// Attachment previews leaked the same way: each file's createObjectURL
// registration outlives its <img>, pinning the decoded blob until a full reload.
//
// Neither is visible in a screenshot, and neither throws — which is exactly why
// they need a test. The DOM is a hand-rolled shim; house style, no jsdom.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createChatMessages } from '../../../public/scripts/ai-designer/chat-messages.js';

/** A node that supports just enough of the DOM for resetChatMessages. */
function makeNode(attrs = {}) {
  return {
    dataset: { ...attrs.dataset },
    src: attrs.src || '',
    tagName: attrs.tagName || 'DIV',
  };
}

/** A stand-in for the #chat-messages container. */
function makeContainer(children = []) {
  return {
    children,
    innerHTML: '<p>previous transcript</p>',
    querySelectorAll(selector) {
      if (selector === '[data-interval-id]') {
        return this.children.filter((c) => c.dataset.intervalId !== undefined);
      }
      if (selector === 'img[data-object-url]') {
        return this.children.filter((c) => c.tagName === 'IMG' && c.dataset.objectUrl !== undefined);
      }
      return [];
    },
  };
}

const realClearInterval = globalThis.clearInterval;
let cleared;
let revoked;

beforeEach(() => {
  cleared = [];
  revoked = [];
  globalThis.clearInterval = (id) => { cleared.push(id); };
  globalThis.URL = /** @type {any} */ ({ revokeObjectURL: (u) => { revoked.push(u); } });
});
afterEach(() => {
  globalThis.clearInterval = realClearInterval;
});

test('every rotating-status interval is cleared, not just the two known ids', () => {
  const container = makeContainer([
    makeNode({ dataset: { intervalId: '11' } }),
    makeNode({ dataset: { intervalId: '22' } }),
    makeNode({ dataset: {} }), // an ordinary message — nothing to clear
  ]);
  const { resetChatMessages } = createChatMessages({ chatMessages: container, openImageModal() {} });

  resetChatMessages();

  assert.deepEqual(cleared.sort(), [11, 22], 'both live intervals stopped');
  assert.equal(container.innerHTML, '', 'and the transcript is emptied');
});

test('object URLs for attachments are revoked before the nodes are dropped', () => {
  const container = makeContainer([
    makeNode({ tagName: 'IMG', dataset: { objectUrl: '1' }, src: 'blob:one' }),
    makeNode({ tagName: 'IMG', dataset: { objectUrl: '1' }, src: 'blob:two' }),
    // A generated image served from a data: URL carries no marker and must be left
    // alone — revoking a non-object URL is meaningless, and marking it would be a lie.
    makeNode({ tagName: 'IMG', dataset: {}, src: 'data:image/png;base64,AAA' }),
  ]);
  const { resetChatMessages } = createChatMessages({ chatMessages: container, openImageModal() {} });

  resetChatMessages();

  assert.deepEqual(revoked.sort(), ['blob:one', 'blob:two']);
});

test('a reset with nothing pending is still safe and still clears the DOM', () => {
  const container = makeContainer([makeNode(), makeNode()]);
  const { resetChatMessages } = createChatMessages({ chatMessages: container, openImageModal() {} });

  assert.doesNotThrow(() => resetChatMessages());
  assert.deepEqual(cleared, []);
  assert.deepEqual(revoked, []);
  assert.equal(container.innerHTML, '');
});

test('repeated resets during generation do not accumulate live intervals', () => {
  // The reported abuse shape: hammer "new chat" while an image is generating. Each
  // reset must take its own indicator's timer with it.
  const { resetChatMessages } = createChatMessages({
    chatMessages: makeContainer([]), openImageModal() {},
  });
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i += 1) resetChatMessages(); });

  const container = makeContainer([makeNode({ dataset: { intervalId: '7' } })]);
  const second = createChatMessages({ chatMessages: container, openImageModal() {} });
  second.resetChatMessages();
  assert.deepEqual(cleared, [7], 'the indicator alive at reset time is the one stopped');
});
