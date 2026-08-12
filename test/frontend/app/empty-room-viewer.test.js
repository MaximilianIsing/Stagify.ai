// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/empty-room-viewer.js.
//
// The modal that shows the intermediate result of two-stage furniture removal: the
// room with the old furniture taken out, before the new furniture goes in.
//
// Every element in its dependency bag is allowed to be null, and a missing-element
// crash here would happen at module eval — taking down everything app.js wires AFTER
// it. That is what the null cases below pin.
//
// This used to be load-bearing in production: contact/status/guides all loaded app.js
// without carrying this markup. They no longer do (they load scripts/page-chrome.js
// instead), so index.html is now app.js's only consumer and it does carry every
// element. The null-tolerance is therefore a module contract now rather than a live
// dependency — keep it, because it is the thing that made app.js safe to mount on a
// page like that in the first place, and the next page to reuse it will need it again.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createEmptyRoomViewer } from '../../../public/scripts/app/empty-room-viewer.js';

const URL_A = 'blob:https://stagify.ai/empty-room-1';

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
});

function mount({ url = URL_A, roomValue = 'Living Room', bare = false } = {}) {
  dom = installMaskDom();

  const docListeners = new Map();
  dom.doc.addEventListener = (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  };

  /** Anchors the download path builds, so the filename can be read back. */
  const anchors = [];
  const realCreate = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'a') {
      el.clicked = 0;
      el.click = () => { el.clicked += 1; };
      anchors.push(el);
    }
    return el;
  };

  const els = bare
    ? {
      emptyRoomModal: null,
      emptyRoomImage: null,
      emptyRoomClose: null,
      emptyRoomDownload: null,
      emptyRoomBtn: null,
      roomSelect: null,
    }
    : {
      emptyRoomModal: new FakeEl('div'),
      emptyRoomImage: new FakeEl('img'),
      emptyRoomClose: new FakeEl('button'),
      emptyRoomDownload: new FakeEl('button'),
      emptyRoomBtn: new FakeEl('button'),
      roomSelect: { value: roomValue },
    };

  let current = url;
  createEmptyRoomViewer({ ...els, getLastEmptyRoomUrl: () => current });

  return {
    ...els,
    anchors,
    setUrl: (u) => { current = u; },
    pressEscape: () => (docListeners.get('keydown') || []).forEach((fn) => fn({ key: 'Escape' })),
    pressKey: (key) => (docListeners.get('keydown') || []).forEach((fn) => fn({ key })),
  };
}

const isOpen = (h) => h.emptyRoomModal.classList.contains('active');

test('opening shows the current empty-room image', () => {
  const h = mount();

  h.emptyRoomBtn.emit('click', {});

  assert.equal(isOpen(h), true);
  assert.equal(h.emptyRoomImage.src, URL_A, 'the image is set from the getter, not cached at wire time');
  assert.equal(h.emptyRoomModal.getAttribute('aria-hidden'), 'false');
});

test('the image follows the latest result, not the first one', () => {
  // getLastEmptyRoomUrl is a getter precisely because a second staging run replaces
  // the URL; reading it once at construction would keep showing the first room.
  const h = mount();
  h.emptyRoomBtn.emit('click', {});

  h.setUrl('blob:https://stagify.ai/empty-room-2');
  h.emptyRoomBtn.emit('click', {});

  assert.equal(h.emptyRoomImage.src, 'blob:https://stagify.ai/empty-room-2');
});

test('opening with no result yet does nothing', () => {
  const h = mount({ url: '' });

  h.emptyRoomBtn.emit('click', {});

  assert.equal(isOpen(h), false);
});

test('the close button closes it', () => {
  const h = mount();
  h.emptyRoomBtn.emit('click', {});

  h.emptyRoomClose.emit('click', {});

  assert.equal(isOpen(h), false);
  assert.equal(h.emptyRoomModal.getAttribute('aria-hidden'), 'true');
});

test('clicking the backdrop closes it, clicking the image does not', () => {
  // The image sits inside the modal, so a click on it bubbles to the same handler.
  // Without the target check, looking closely at the result closes the result.
  const h = mount();
  h.emptyRoomBtn.emit('click', {});

  h.emptyRoomModal.emit('click', { target: h.emptyRoomImage });
  assert.equal(isOpen(h), true, 'a click on the content is not a click on the backdrop');

  h.emptyRoomModal.emit('click', { target: h.emptyRoomModal });
  assert.equal(isOpen(h), false);
});

test('Escape closes an open modal', () => {
  const h = mount();
  h.emptyRoomBtn.emit('click', {});

  h.pressEscape();

  assert.equal(isOpen(h), false);
});

test('Escape while closed does not reach past the modal', () => {
  // The listener is on document and lives for the page's lifetime. Acting on a modal
  // that is not open would fight whatever else Escape means at that moment.
  const h = mount();

  h.pressEscape();

  assert.equal(isOpen(h), false);
  assert.equal(h.emptyRoomModal.getAttribute('aria-hidden'), null, 'nothing was touched');
});

test('a key that is not Escape is ignored', () => {
  const h = mount();
  h.emptyRoomBtn.emit('click', {});

  h.pressKey('e');

  assert.equal(isOpen(h), true);
});

test('downloading names the file after the room type', () => {
  const h = mount({ roomValue: 'Living Room' });

  h.emptyRoomDownload.emit('click', {});

  assert.equal(h.anchors.length, 1);
  const [a] = h.anchors;
  assert.equal(a.href, URL_A);
  assert.match(a.download, /^stagify-living-room-empty-\d+\.jpg$/, `got ${a.download}`);
  assert.equal(a.clicked, 1, 'and the download is actually triggered');
});

test('downloading with no result does nothing', () => {
  const h = mount({ url: '' });

  h.emptyRoomDownload.emit('click', {});

  assert.deepEqual(h.anchors, []);
});

test('a page without the modal markup wires up without crashing', () => {
  // app.js constructs this island on every page it runs on, including ones with no
  // empty-room modal at all. A throw here would abort the rest of app.js's wiring.
  assert.doesNotThrow(() => mount({ bare: true }));
});

test('Escape on a page without the modal is inert', () => {
  const h = mount({ bare: true });

  assert.doesNotThrow(() => h.pressEscape());
});
