// Tier: frontend island logic (DOM-stubbed) — public/scripts/ai-designer/thumbnail-strip.js.
//
// The base-image picker under the AI Designer chat: one thumbnail per image in the
// conversation, newest first, with the selected one used as the base for the next
// edit. So the selection is not decorative — it decides which image the model is
// handed.
//
// The selection index is private module state indexed into a list that GROWS on every
// generation and RESETS on a new conversation. That is the whole risk surface:
//
//   - A new image arrives → the list shifts and index 0 is now a different picture.
//     preferNewest exists so the caller can say "the user just made this, select it".
//   - The conversation is cleared → an index kept from the old list points at an
//     image that no longer exists, and the next edit silently uses the wrong base.
//     Both the emptied case and the shrunk case are covered below.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createThumbnailStrip } from '../../../public/scripts/ai-designer/thumbnail-strip.js';

const REAL = { window: globalThis.window };

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
});

const image = (n) => ({ url: `blob:img-${n}`, label: `Image ${n}`, kind: 'generated' });

function mount({ images = [image(1), image(2)], bare = false } = {}) {
  dom = installMaskDom();

  const strip = new FakeEl('div');
  const scroll = new FakeEl('div');
  dom.doc.getElementById = (id) => {
    if (bare) return null;
    if (id === 'image-thumbnail-strip') return strip;
    if (id === 'image-thumbnail-strip-scroll') return scroll;
    return null;
  };
  globalThis.window = /** @type {any} */ ({ LanguageSystem: null });

  let list = images;
  const island = createThumbnailStrip({ collectImagesFromConversationHistory: () => list });

  return {
    island,
    strip,
    scroll,
    setImages: (next) => { list = next; },
    tiles: () => scroll.children,
    selectedTiles: () => scroll.children.filter((c) => c.className.includes('selected')),
  };
}

test('the strip appears with one tile per image once there is anything to pick', () => {
  const h = mount({ images: [image(1), image(2), image(3)] });

  h.island.syncImageThumbnailStrip();

  assert.equal(h.strip.classList.contains('visible'), true);
  assert.equal(h.tiles().length, 3);
  assert.deepEqual(h.tiles().map((t) => t.dataset.index), ['0', '1', '2']);
});

test('the newest image is selected on the first render', () => {
  const h = mount();

  h.island.syncImageThumbnailStrip();

  assert.equal(h.island.getSelectedImageIndex(), 0);
  assert.equal(h.selectedTiles().length, 1, 'exactly one tile is marked');
  assert.equal(h.tiles()[0].className.includes('selected'), true);
});

test('an empty conversation hides the strip and forgets the selection', () => {
  // A stale index over an empty list is the setup for the next edit being sent with
  // the wrong base — or none at all.
  const h = mount();
  h.island.syncImageThumbnailStrip();

  h.setImages([]);
  h.island.syncImageThumbnailStrip();

  assert.equal(h.strip.classList.contains('visible'), false);
  assert.equal(h.tiles().length, 0, 'the old tiles are cleared, not left behind');
  assert.equal(h.island.getSelectedImageIndex(), null);
});

test('clicking a thumbnail selects it and re-renders the strip', () => {
  const h = mount({ images: [image(1), image(2), image(3)] });
  h.island.syncImageThumbnailStrip();

  h.tiles()[2].emit('click', {});

  assert.equal(h.island.getSelectedImageIndex(), 2);
  assert.equal(h.selectedTiles().length, 1);
  assert.equal(h.tiles()[2].className.includes('selected'), true);
});

test('a deliberate selection survives an ordinary re-render', () => {
  // The strip re-syncs on all sorts of events. Resetting to newest each time would
  // undo the user's pick between choosing a base and sending the message.
  const h = mount({ images: [image(1), image(2), image(3)] });
  h.island.syncImageThumbnailStrip();
  h.tiles()[2].emit('click', {});

  h.island.syncImageThumbnailStrip();

  assert.equal(h.island.getSelectedImageIndex(), 2);
});

test('a freshly generated image takes the selection when the caller asks', () => {
  const h = mount({ images: [image(1), image(2)] });
  h.island.syncImageThumbnailStrip();
  h.tiles()[1].emit('click', {});

  h.setImages([image(3), image(1), image(2)]);
  h.island.syncImageThumbnailStrip({ preferNewest: true });

  assert.equal(h.island.getSelectedImageIndex(), 0, 'the new image is what you want to edit next');
});

test('preferNewest is opt-in, not the default', () => {
  const h = mount({ images: [image(1), image(2)] });
  h.island.syncImageThumbnailStrip();
  h.tiles()[1].emit('click', {});

  h.setImages([image(3), image(1), image(2)]);
  h.island.syncImageThumbnailStrip({ preferNewest: false });

  assert.equal(h.island.getSelectedImageIndex(), 1, 'without the flag the index is left alone');
});

test('a selection past the end of a shrunken list is pulled back to the newest', () => {
  // Starting a new conversation replaces a long history with a short one. An index
  // left pointing past the end selects nothing, and the next edit goes out based on
  // whatever the entry falls back to.
  const h = mount({ images: [image(1), image(2), image(3), image(4)] });
  h.island.syncImageThumbnailStrip();
  h.tiles()[3].emit('click', {});

  h.setImages([image(9)]);
  h.island.syncImageThumbnailStrip();

  assert.equal(h.island.getSelectedImageIndex(), 0);
  assert.equal(h.selectedTiles().length, 1, 'and a tile really is marked');
});

test('the entry can drive the selection directly', () => {
  const h = mount({ images: [image(1), image(2)] });
  h.island.syncImageThumbnailStrip();

  h.island.setSelectedImageIndex(1);

  assert.equal(h.island.getSelectedImageIndex(), 1);
});

test('every thumbnail is labelled, and the selected one says so', () => {
  // The tiles are image-only buttons; without a label they read as "button, button,
  // button" and the picker is unusable by screen reader.
  const h = mount({ images: [image(1), image(2)] });

  h.island.syncImageThumbnailStrip();

  for (const tile of h.tiles()) {
    assert.ok(tile.getAttribute('aria-label'), 'each tile carries a label');
  }
  // The selected tile must SAY it is the base image, not merely differ from the
  // others — every tile differs from every other by its index, so "they are not
  // equal" would hold even with the selected-state wording deleted.
  const [selected, other] = h.tiles().map((t) => t.querySelector('img').alt);
  assert.match(selected, /selected as base image/i, 'the selection is stated, not implied');
  assert.match(other, /image 2 in conversation/i, 'and the rest are described by position');
});

test('each tile shows its image and a caption', () => {
  const h = mount({ images: [image(7)] });

  h.island.syncImageThumbnailStrip();

  const tile = h.tiles()[0];
  const img = tile.querySelector('img');
  assert.equal(img.src, 'blob:img-7');
  assert.equal(img.loading, 'lazy', 'a long history must not fetch every thumbnail at once');
  assert.ok(tile.querySelector('span').textContent.length > 0, 'and it is captioned');
});

test('re-rendering replaces the tiles rather than appending to them', () => {
  const h = mount({ images: [image(1), image(2)] });

  h.island.syncImageThumbnailStrip();
  h.island.syncImageThumbnailStrip();
  h.island.syncImageThumbnailStrip();

  assert.equal(h.tiles().length, 2);
});

test('a page without the strip markup is a no-op', () => {
  const h = mount({ bare: true });

  assert.doesNotThrow(() => h.island.syncImageThumbnailStrip());
  assert.equal(h.island.getSelectedImageIndex(), null);
});
