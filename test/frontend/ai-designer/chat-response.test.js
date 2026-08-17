// Tier: frontend island logic (DOM-stubbed) — public/scripts/ai-designer/chat-response.js.
//
// The AI Designer's reply handler: it turns the server's answer — streamed SSE or a
// plain JSON body — into chat bubbles, image cards, and entries in the conversation
// history that every later turn is built from.
//
// That last part is what makes it worth testing rather than smoke-checking. The
// history is not a transcript, it is the MODEL'S CONTEXT: whatever lands there is
// resent on the next turn. So the failure modes are not visual —
//
//   - A DUPLICATE ENTRY doubles the images the next request carries.
//   - A LOST rootBaseName renames every download from that staging run.
//   - A WRONG stagedNumber makes "the second one" mean a different picture to the
//     user and to the model.
//
// The streaming path has its own hazard: the message and the images arrive as two
// separate events, and the second must UPDATE the bubble the first created rather
// than adding another. That is what `imagesOnly` is for, and it is asserted in both
// directions here.
//
// The SSE framing itself is covered by ai-designer-chat-sse-client.test.js; this
// drives real event bodies through the real consumer.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createChatResponse } from '../../../public/scripts/ai-designer/chat-response.js';

const REAL = { window: globalThis.window, TextDecoder: globalThis.TextDecoder };

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
});

/** A fetch Response carrying a JSON body. */
const jsonResponse = (data) => ({
  headers: { get: () => 'application/json' },
  json: async () => data,
});

/** A fetch Response streaming the given SSE events. */
function sseResponse(events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  };
}

function mount({ history = [], pendingBase = null } = {}) {
  dom = installMaskDom();
  globalThis.window = /** @type {any} */ ({ LanguageSystem: null });

  let conversation = history;
  let baseName = pendingBase;
  const calls = {
    messages: [],
    errors: [],
    textUpdates: [],
    imageLoading: [],
    loadingRemoved: 0,
    typingRemoved: [],
    cards: [],
    stripSyncs: [],
  };

  const lastAssistantEl = new FakeEl('div');

  const island = createChatResponse({
    addMessage: (role, content) => calls.messages.push({ role, content }),
    addErrorMessage: (text, onRetry) => calls.errors.push({ text, hasRetry: typeof onRetry === 'function' }),
    updateLastAssistantText: (text) => calls.textUpdates.push(text),
    getLastAssistantContentEl: () => lastAssistantEl,
    showMessageImageLoading: (type) => calls.imageLoading.push(type),
    removeMessageImageLoading: () => { calls.loadingRemoved += 1; },
    removeTypingIndicator: (id) => calls.typingRemoved.push(id),
    createAIImageWithDownload: (src, alt, type, base) => {
      calls.cards.push({ src, alt, type, base });
      return new FakeEl('div');
    },
    syncImageThumbnailStrip: (opts) => calls.stripSyncs.push(opts),
    collectImagesFromConversationHistory: () =>
      conversation.flatMap((m) =>
        (Array.isArray(m.content) ? m.content : [])
          .filter((c) => c.type === 'image_url')
          .map((c) => ({ url: c.image_url.url, isStaged: !!c.isStaged, rootBaseName: c.rootBaseName })),
      ),
    getConversationHistory: () => conversation,
    getPendingStagingRootBaseName: () => baseName,
    setPendingStagingRootBaseName: (v) => { baseName = v; },
  });

  return {
    island,
    calls,
    lastAssistantEl,
    history: () => conversation,
    baseName: () => baseName,
  };
}

const send = (h, response, type = 'analyzing') =>
  h.island.handleChatFetchResponse(response, 'typing-1', type, () => {});

/** The image entries a turn appended to the history. */
const imagesIn = (h) =>
  h.history()
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'image_url');

// ---- routing ------------------------------------------------------------------

test('a plain JSON reply is rendered as one message', async () => {
  const h = mount();

  await send(h, jsonResponse({ response: 'Here you go.' }));

  assert.deepEqual(h.calls.typingRemoved, ['typing-1'], 'the typing indicator is cleared');
  assert.deepEqual(h.calls.stripSyncs, [{ preferNewest: false }], 'no new images, so no reselect');
});

test('a server error is shown to the user rather than swallowed', async () => {
  const h = mount();

  await send(h, jsonResponse({ error: 'model unavailable' }));

  assert.equal(h.calls.messages.length, 1);
  assert.match(h.calls.messages[0].content, /model unavailable/);
  assert.deepEqual(imagesIn(h), [], 'and nothing is written into the model context');
});

test('a context-limit reply is passed through as the assistant said it', async () => {
  const h = mount();

  await send(h, jsonResponse({ contextLimitReached: true, response: 'This chat is getting long.' }));

  assert.deepEqual(h.calls.messages, [{ role: 'assistant', content: 'This chat is getting long.' }]);
});

// ---- the streaming path -----------------------------------------------------------

test('a streamed reply shows the text first, then the images', async () => {
  const h = mount();

  await send(h, sseResponse([
    { event: 'message', data: { response: 'Staging your room…' } },
    { event: 'images', data: { stagedImages: ['data:image/png;base64,AAA'] } },
  ]));

  assert.deepEqual(h.calls.messages, [{ role: 'assistant', content: 'Staging your room…' }]);
  assert.equal(h.calls.cards.length, 1, 'the image card is added to the SAME message');
  assert.equal(h.calls.loadingRemoved, 1, 'and the image placeholder is cleared');
});

test('the images event updates the existing bubble instead of adding another', async () => {
  // Two events, one message. Adding a second would leave the user reading the same
  // sentence twice with the images under the duplicate.
  const h = mount();

  await send(h, sseResponse([
    { event: 'message', data: { response: 'Staging your room…' } },
    { event: 'images', data: { response: 'All done.', stagedImages: ['data:image/png;base64,AAA'] } },
  ]));

  assert.equal(h.calls.messages.length, 1, 'exactly one bubble');
  assert.deepEqual(h.calls.textUpdates, ['All done.'], 'its text is revised in place');
});

test("the server's declared intent drives the loading copy, not the client's guess", async () => {
  // The client tags the request from the user's words; the server knows what it
  // actually decided to do. Showing "analyzing" while it stages is simply wrong.
  const h = mount();

  await send(h, sseResponse([
    { event: 'status', data: { type: 'staging' } },
    { event: 'message', data: { response: 'One moment.' } },
  ]), 'analyzing');

  assert.deepEqual(h.calls.imageLoading, ['staging']);
});

test('with no status event the client tag is used', async () => {
  const h = mount();

  await send(h, sseResponse([{ event: 'message', data: { response: 'One moment.' } }]), 'analyzing');

  assert.deepEqual(h.calls.imageLoading, ['analyzing']);
});

test('a stream that errors mid-flight offers a retry', async () => {
  const h = mount();

  await send(h, sseResponse([
    { event: 'message', data: { response: 'Working…' } },
    { event: 'error', data: { error: 'upstream died' } },
  ]));

  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0].hasRetry, true, 'the user can try again without retyping');
  assert.ok(h.calls.loadingRemoved > 0, 'and the spinner is cleared');
});

// ---- staged images and the model's context -------------------------------------------

test('staged images are written into the history exactly once', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'Done.',
    stagedImages: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
  }));

  const imgs = imagesIn(h);
  assert.equal(imgs.length, 2);
  assert.ok(imgs.every((i) => i.isStaged === true));
});

test('an identical reply arriving twice is not appended twice', async () => {
  // The streaming path can deliver the same payload through both the message and the
  // images event. A duplicate here doubles what the NEXT request uploads.
  //
  // Generated images are the case where this actually bites: their history entry has
  // no per-run fields, so a repeat really is byte-identical. A staged entry carries
  // rootBaseName and a stagedNumber that increments, so two staging runs of the same
  // picture are legitimately different entries — see the next test.
  const h = mount();
  const payload = { response: 'Here is a concept.', generatedImage: 'data:image/png;base64,AAA' };

  await send(h, jsonResponse(payload));
  await send(h, jsonResponse(payload));

  assert.equal(imagesIn(h).length, 1);
});

test('re-staging the same photo is a second entry, not a duplicate', async () => {
  // Deliberately NOT deduplicated: the user asked for another go, and the model needs
  // to know there are now two versions to talk about.
  //
  // Note for anyone mutation-testing this file: the STAGED branch has its own
  // duplicate guard, and it is unreachable. A staged entry carries stagedNumber =
  // priorStagedCount + 1, recomputed from the history on every call, so two
  // consecutive pushes can never be byte-identical — the second is always one
  // higher. Deleting that guard changes nothing observable. It is redundant
  // defensive code, not a gap here; the generated branch's guard (tested above) is
  // the one that actually fires.
  const h = mount({ pendingBase: 'Room A' });
  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  const again = mount({ pendingBase: 'Room A', history: h.history() });
  await send(again, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  assert.equal(imagesIn(again).length, 2);
  assert.deepEqual(imagesIn(again).map((i) => i.stagedNumber), [1, 2]);
});

test('a different reply is appended even when it looks similar', async () => {
  // The other half: the duplicate guard compares content, so a genuine second run
  // must still land.
  const h = mount();

  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));
  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,BBB'] }));

  assert.equal(imagesIn(h).length, 2);
});

test('the staging source name is used for downloads and then consumed', async () => {
  // It names every download from this run. Leaving it set would misname the NEXT
  // run's downloads with the previous room's address.
  const h = mount({ pendingBase: '123 Main St' });

  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  assert.equal(h.calls.cards[0].base, '123 Main St');
  assert.equal(h.baseName(), null, 'and it is cleared for the next run');
});

test('a staging run with no source name still works', async () => {
  const h = mount({ pendingBase: null });

  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  assert.equal(h.calls.cards[0].base, 'Upload');
});

test('staged numbering continues across runs of the same room', async () => {
  // "the second one" has to mean the same picture to the user and to the model. A
  // numbering that restarts at 1 each run makes that reference ambiguous.
  const h = mount({ pendingBase: 'Room A' });
  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  const second = mount({ pendingBase: 'Room A', history: h.history() });
  await send(second, jsonResponse({ response: 'Again.', stagedImages: ['data:image/png;base64,BBB'] }));

  const numbers = imagesIn(second).map((i) => i.stagedNumber);
  assert.deepEqual(numbers, [1, 2]);
});

test('a different room starts its own numbering', async () => {
  const h = mount({ pendingBase: 'Room A' });
  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  const second = mount({ pendingBase: 'Room B', history: h.history() });
  await send(second, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,BBB'] }));

  assert.deepEqual(imagesIn(second).map((i) => i.stagedNumber), [1, 1]);
});

test('annotations are attached under the key the server used for a single image', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'Done.',
    stagedImages: ['data:image/png;base64,AAA'],
    stagedImageAnnotations: { staged_0: 'a bright living room' },
  }));

  assert.equal(imagesIn(h)[0]._annotation, 'a bright living room');
});

test('annotations are matched per image when there are several', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'Done.',
    stagedImages: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
    stagedImageAnnotations: { staged_0: 'first', staged_1: 'second' },
  }));

  assert.deepEqual(imagesIn(h).map((i) => i._annotation), ['first', 'second']);
});

// ---- generated (non-staging) images ---------------------------------------------------

test('generated images land in the history as generated, not staged', async () => {
  // The distinction drives the thumbnail labels and what the next turn is told the
  // image IS. A generated concept is not a staging of the user's room.
  const h = mount();

  await send(h, jsonResponse({ response: 'Here is a concept.', generatedImage: 'data:image/png;base64,AAA' }));

  const imgs = imagesIn(h);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].isGenerated, true);
  assert.ok(!imgs[0].isStaged);
});

test('a new image makes the picker jump to it', async () => {
  const h = mount();

  await send(h, jsonResponse({ response: 'Done.', stagedImages: ['data:image/png;base64,AAA'] }));

  assert.deepEqual(h.calls.stripSyncs, [{ preferNewest: true }]);
});

// ---- uploaded-image annotations ----------------------------------------------------------

test('an annotation is attached to the upload it describes', async () => {
  const h = mount({
    history: [{
      role: 'user',
      content: [{ type: 'image_url', filename: 'living-room.jpg', image_url: { url: 'blob:a' } }],
    }],
  });

  await send(h, jsonResponse({
    response: 'Nice room.',
    imageAnnotations: { 'living-room.jpg': 'a sunlit living room' },
  }));

  assert.equal(h.history()[0].content[0].annotation, 'a sunlit living room');
});

test('an annotation still finds its image when the server shortened the name', async () => {
  // The server sometimes keys annotations by a truncated or prefixed filename; an
  // exact-match-only lookup silently drops the description.
  const h = mount({
    history: [{
      role: 'user',
      content: [{ type: 'image_url', filename: 'IMG_20240101_living-room.jpg', image_url: { url: 'blob:a' } }],
    }],
  });

  await send(h, jsonResponse({
    response: 'Nice room.',
    imageAnnotations: { 'living-room.jpg': 'a sunlit living room' },
  }));

  assert.equal(h.history()[0].content[0].annotation, 'a sunlit living room');
});

test('only the most recent upload is annotated', async () => {
  // The annotations describe the images the user just sent, not everything they have
  // ever sent — the loop breaks at the newest user turn on purpose.
  const h = mount({
    history: [
      { role: 'user', content: [{ type: 'image_url', filename: 'old.jpg', image_url: { url: 'blob:old' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'image_url', filename: 'new.jpg', image_url: { url: 'blob:new' } }] },
    ],
  });

  await send(h, jsonResponse({
    response: 'Nice.',
    imageAnnotations: { 'old.jpg': 'stale', 'new.jpg': 'fresh' },
  }));

  assert.equal(h.history()[2].content[0].annotation, 'fresh');
  assert.equal(h.history()[0].content[0].annotation, undefined, 'the older turn is left alone');
});

// ---- blueprint (CAD) renders --------------------------------------------------
//
// This branch had NO coverage at all, which is how it stayed an `else if` behind
// staging and generate while lib/chat/chat-post-routing.js ran all three
// unconditionally. A turn that staged a room AND rendered a floor plan threw the floor
// plan away in the browser: gone from the transcript, and gone from the history the
// next turn is built from — so the model could not see the render it had just made.

test('a CAD render is displayed and lands in the history', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'Here is your floor plan, furnished.',
    cadImage: 'blob:cad-1',
    cadImageAnnotation: 'top-down furnished plan CAD: True',
  }));

  assert.deepEqual(h.calls.cards.map((c) => c.src), ['blob:cad-1']);
  const images = imagesIn(h);
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url.url, 'blob:cad-1');
  assert.equal(images[0]._annotation, 'top-down furnished plan CAD: True',
    'the CAD: True annotation must survive — the router reads it to keep follow-ups on the CAD path');
  assert.deepEqual(h.calls.stripSyncs, [{ preferNewest: true }]);
});

test('a staged room AND a CAD render in the same turn both survive', async () => {
  // The regression. As an else-if ladder this asserted 1 card and 1 history image.
  const h = mount();

  await send(h, jsonResponse({
    response: 'Staged the bedroom and rendered the plan.',
    stagedImage: 'blob:staged-1',
    cadImage: 'blob:cad-1',
  }));

  assert.deepEqual(
    h.calls.cards.map((c) => c.src),
    ['blob:staged-1', 'blob:cad-1'],
    'both images are rendered into the bubble',
  );

  const images = imagesIn(h);
  assert.equal(images.length, 2, 'both images reach the history the next turn is built from');
  assert.equal(images[0].isStaged, true);
  assert.equal(images[1].isGenerated, true);

  assert.equal(h.calls.messages.length, 1, 'the assistant text bubble is still added exactly once');
  assert.equal(
    h.history().filter((m) => m.role === 'assistant').length, 1,
    'and exactly ONE history entry is pushed, carrying every image from the turn',
  );
});

test('all three image kinds in one turn are kept, in pipeline order', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'All three.',
    stagedImages: ['blob:staged-1', 'blob:staged-2'],
    generatedImage: 'blob:gen-1',
    cadImages: ['blob:cad-1', 'blob:cad-2'],
  }));

  assert.deepEqual(
    imagesIn(h).map((c) => c.image_url.url),
    ['blob:staged-1', 'blob:staged-2', 'blob:gen-1', 'blob:cad-1', 'blob:cad-2'],
  );
  assert.equal(h.history().filter((m) => m.role === 'assistant').length, 1);
});

test('alt text follows the VIEW, per image', async () => {
  // "3D render from floor plan" is right for a plan view and wrong for an eye-level one,
  // which is a photograph of a room — and alt text is read by exactly the people who
  // cannot see which of the two they were handed. `cadViews` ships on every CAD reply
  // (unlike `cadParams`, which is set only in the multi-result branch), so a LONE render
  // can be described correctly too.
  const h = mount();

  await send(h, jsonResponse({
    response: 'Two renders.',
    cadImages: ['blob:plan', 'blob:room'],
    cadViews: ['top-down', 'eye-level'],
  }));

  const alts = h.calls.cards.map((c) => c.alt);
  assert.match(alts[0], /above/i, 'the plan view is described as seen from above');
  assert.match(alts[1], /inside/i, 'the interior view is described as photographed from inside');
  assert.notEqual(alts[0], alts[1]);
});

test('a CAD reply with no cadViews still gets plan-view alt text', async () => {
  // Degrades to the default rather than to an empty string — an older server, or a
  // replayed body, must not strip the description.
  const h = mount();

  await send(h, jsonResponse({ response: 'One render.', cadImage: 'blob:plan' }));

  assert.match(h.calls.cards[0].alt, /above/i);
});

test('multi-result CAD annotations are matched by index', async () => {
  const h = mount();

  await send(h, jsonResponse({
    response: 'Two variations.',
    cadImages: ['blob:cad-0', 'blob:cad-1'],
    cadImageAnnotations: { cad_0: 'scandinavian CAD: True', cad_1: 'industrial CAD: True' },
  }));

  const images = imagesIn(h);
  assert.equal(images[0]._annotation, 'scandinavian CAD: True');
  assert.equal(images[1]._annotation, 'industrial CAD: True');
});

test('a CAD render does not consume the pending staging base name', async () => {
  // rootBaseName names the DOWNLOAD of a staged run. A CAD render is not part of one,
  // so it must not be tagged with the base name — but the name is still cleared, because
  // the turn is over either way.
  const h = mount({ pendingBase: 'living-room' });

  await send(h, jsonResponse({ response: 'Rendered.', cadImage: 'blob:cad-1' }));

  assert.equal(h.calls.cards[0].base, undefined, 'the CAD card carries no staging base name');
  assert.equal(h.baseName(), null, 'the pending name is still cleared');
});
