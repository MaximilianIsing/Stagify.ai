// Tier: frontend island logic (DOM-stubbed) — public/scripts/ai-designer/image-viewer.js.
//
// Everything that happens to an image once the AI Designer has produced one: the
// enlarge lightbox, the per-image download button, the pro-only "edit with mask"
// button, and the carousel that collects successive mask edits of the same image.
//
// Three of these have a specific bug behind them, all documented in the source, all
// invisible unless asserted:
//
//   - THE OBJECT URL IS REVOKED ON A LATER TASK. click() only QUEUES the download.
//     Revoking in the same tick cancels it before it starts, so the button silently
//     does nothing on the engines that queue rather than copy (Firefox, Safari).
//   - FOCUS RESTORE SKIPS <body> AND DETACHED NODES. The enlarge trigger is a
//     non-focusable <img>, so a mouse-opened lightbox captures <body>; "restoring"
//     that would MOVE focus rather than put it back. And the chat re-renders its
//     containers, so the opener is often gone by the time the lightbox closes.
//   - THE CAROUSEL LABEL WAS ONE TOO HIGH. Appending to an existing carousel derived
//     the version number from the item count instead of the slice offset, so the
//     second mask edit announced itself as "(3 of 2)".
//
// Real download behaviour (does a file appear) belongs to e2e; what is asserted here
// is the ordering and the naming, which a browser smoke cannot see.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createImageViewer } from '../../../public/scripts/ai-designer/image-viewer.js';

const PNG = 'data:image/png;base64,AAAA';
const JPG = 'data:image/jpeg;base64,BBBB';
const WEBP = 'data:image/webp;base64,CCCC';

const REAL = {
  window: globalThis.window,
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  consoleError: console.error,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
  globalThis.fetch = REAL.fetch;
  globalThis.setTimeout = REAL.setTimeout;
  console.error = REAL.consoleError;
});

const settle = () => new Promise((r) => REAL.setTimeout(r, 5));

function mount({ plan = 'free', fetchFails = false, langLoaded = false } = {}) {
  dom = installMaskDom();

  const modal = new FakeEl('div');
  const modalImg = new FakeEl('img');
  const closeBtn = new FakeEl('button');
  closeBtn.focused = 0;
  closeBtn.focus = () => { closeBtn.focused += 1; };

  dom.doc.getElementById = (id) => ({
    'image-modal': modal,
    'image-modal-img': modalImg,
    'image-modal-close': closeBtn,
  }[id] || null);
  dom.doc.activeElement = dom.body;

  /** Anchors the download path creates, so the filename and ordering are readable. */
  const anchors = [];
  const events = [];
  const realCreate = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'a') {
      el.click = () => events.push({ type: 'click', href: el.href, download: el.download });
      anchors.push(el);
    }
    return el;
  };

  const urls = { revoked: [] };
  globalThis.window = /** @type {any} */ ({
    URL: {
      createObjectURL: () => 'blob:downloaded',
      revokeObjectURL: (u) => { urls.revoked.push(u); events.push({ type: 'revoke', url: u }); },
    },
    LanguageSystem: langLoaded
      ? { isLoaded: () => true, getText: (_k, d) => `LOC:${d}` }
      : null,
    StagifyAuth: plan ? { user: { plan } } : null,
  });
  globalThis.fetch = /** @type {any} */ (
    async () => {
      if (fetchFails) throw new Error('offline');
      return { blob: async () => ({ size: 10 }) };
    }
  );
  /** Deferred callbacks the island schedules, so the revoke ordering is observable. */
  const deferred = [];
  globalThis.setTimeout = /** @type {any} */ (
    (fn, ms) => { deferred.push({ fn, ms }); return deferred.length; }
  );
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));

  const masked = [];
  const island = createImageViewer({
    openMaskEditor: (src, type) => masked.push({ src, type }),
  });

  return {
    island, modal, modalImg, closeBtn, anchors, events, urls, deferred, masked, errors,
    body: dom.body,
    doc: dom.doc,
    /** Run everything the island deferred. */
    flush: () => { const d = [...deferred]; deferred.length = 0; d.forEach((x) => x.fn()); },
  };
}

// ---- the lightbox --------------------------------------------------------------

test('enlarging shows the image and locks the page behind it', () => {
  const h = mount();

  const container = h.island.createAIImageWithDownload(PNG, 'a staged room');
  container.querySelector('img').emit('click', {});

  assert.equal(h.modal.classList.contains('active'), true);
  assert.equal(h.modalImg.src, PNG);
  assert.equal(h.modalImg.alt, 'a staged room');
  assert.equal(h.body.style.overflow, 'hidden', 'the page behind must not scroll');
});

test('the lightbox takes focus so it is announced', () => {
  // Without this, focus stays on the thumbnail behind the overlay and a screen reader
  // never learns a dialog opened.
  const h = mount();
  h.island.createAIImageWithDownload(PNG, 'x').querySelector('img').emit('click', {});

  assert.equal(h.closeBtn.focused, 1);
});

test('closing releases the page', () => {
  const h = mount();
  h.island.createAIImageWithDownload(PNG, 'x').querySelector('img').emit('click', {});

  h.island.closeImageModal();

  assert.equal(h.modal.classList.contains('active'), false);
  assert.equal(h.body.style.overflow, '', 'scrolling comes back');
});

test('closing returns focus to whatever opened it', () => {
  const h = mount();
  const opener = new FakeEl('button');
  opener.focused = 0;
  opener.focus = () => { opener.focused += 1; };
  h.body.appendChild(opener);
  h.doc.activeElement = opener;

  h.island.openImageModal(PNG, 'x');
  h.island.closeImageModal();

  assert.equal(opener.focused, 1);
});

test('a mouse-opened lightbox does not drag focus to <body> on close', () => {
  // The enlarge trigger is an <img> with a click handler — not focusable — so a mouse
  // click leaves document.activeElement as <body>. Treating that as "the opener"
  // would MOVE focus on close rather than restore it.
  const h = mount();
  h.body.focused = 0;
  h.body.focus = () => { h.body.focused += 1; };
  // <body> really IS connected; without saying so the isConnected guard would block
  // this on its own and the "not <body>" clause would look untested.
  h.body.isConnected = true;
  h.doc.activeElement = h.body;

  h.island.openImageModal(PNG, 'x');
  h.island.closeImageModal();

  assert.equal(h.body.focused, 0);
});

test('an opener the chat has since re-rendered away is not focused', () => {
  // Focusing a detached node drops focus to <body>, which is worse than leaving it
  // where it is.
  const h = mount();
  const opener = new FakeEl('button');
  opener.focused = 0;
  opener.focus = () => { opener.focused += 1; };
  h.body.appendChild(opener);
  h.doc.activeElement = opener;

  h.island.openImageModal(PNG, 'x');
  opener.remove(); // the chat re-rendered
  h.island.closeImageModal();

  assert.equal(opener.focused, 0);
});

test('the remembered opener is consumed, so a second close does not re-focus it', () => {
  // closeImageModal runs on the close button, on the backdrop and on Escape, so it
  // is genuinely reachable twice for one opening. Without clearing the reference the
  // second call yanks focus back to a thumbnail the user has since navigated away
  // from.
  const h = mount();
  const opener = new FakeEl('button');
  opener.focused = 0;
  opener.focus = () => { opener.focused += 1; };
  h.body.appendChild(opener);
  h.doc.activeElement = opener;

  h.island.openImageModal(PNG, 'x');
  h.island.closeImageModal();
  h.island.closeImageModal();

  assert.equal(opener.focused, 1, 'focus is restored once, not once per close');
});

// ---- downloads -------------------------------------------------------------------

test('downloading names the file after the source, not "image"', async () => {
  const h = mount();
  const container = h.island.createAIImageWithDownload(PNG, 'alt', 'staged-room', '123 Main St');

  container.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
  await settle();

  assert.equal(h.anchors.length, 1);
  assert.equal(h.anchors[0].download, '123-main-st-staged-room.png');
});

test('the file extension follows the image format', async () => {
  for (const [src, ext] of [[PNG, 'png'], [JPG, 'jpg'], [WEBP, 'webp'], ['https://x/y', 'png']]) {
    const h = mount();
    const c = h.island.createAIImageWithDownload(src, 'alt', 'edit', 'Room');
    c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
    await settle();
    assert.match(h.anchors[0].download, new RegExp(`\\.${ext}$`), `${src} → .${ext}`);
    dom.restore();
    dom = null;
  }
});

test('with no source name the filename falls back to a timestamp', async () => {
  const h = mount();
  const c = h.island.createAIImageWithDownload(PNG, 'alt', 'staged-room');

  c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
  await settle();

  assert.match(h.anchors[0].download, /^staged-room-\d{4}-\d{2}-\d{2}T/, `got ${h.anchors[0].download}`);
});

test('the object URL is released only AFTER the download has been queued', async () => {
  // click() queues the download; revoking in the same task cancels it before it
  // starts and the button silently does nothing.
  const h = mount();
  const c = h.island.createAIImageWithDownload(PNG, 'alt', 'edit', 'Room');

  c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
  await settle();

  assert.deepEqual(h.events.map((e) => e.type), ['click'], 'nothing is revoked in the click task');
  assert.equal(h.deferred.length, 1, 'the revoke is deferred');
  assert.ok(h.deferred[0].ms > 0, 'and by a real delay, not 0');

  h.flush();
  assert.deepEqual(h.events.map((e) => e.type), ['click', 'revoke'], 'but it IS released');
});

test('the temporary anchor does not outlive the click', async () => {
  const h = mount();
  const c = h.island.createAIImageWithDownload(PNG, 'alt', 'edit', 'Room');

  c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
  await settle();

  assert.equal(
    h.body.children.filter((el) => el.tagName === 'A').length,
    0,
    'a page full of leftover anchors after a long session',
  );
});

test('a download that cannot be fetched falls back to a direct link', async () => {
  // Data URLs do not always survive the fetch round-trip; the direct href works for
  // them and is the difference between a broken button and a working one.
  const h = mount({ fetchFails: true });
  const c = h.island.createAIImageWithDownload(PNG, 'alt', 'edit', 'Room');

  c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() {} });
  await settle();

  assert.equal(h.anchors.length, 1);
  assert.equal(h.anchors[0].href, PNG, 'the data URL itself is used');
  assert.equal(h.events[0].type, 'click');
});

test('downloading does not also open the lightbox', () => {
  // The button sits on top of the image, whose click handler enlarges it. Without
  // stopPropagation every download also pops the modal.
  const h = mount();
  const c = h.island.createAIImageWithDownload(PNG, 'alt');
  let stopped = 0;

  c.querySelector('.ai-image-download-btn').emit('click', { stopPropagation() { stopped += 1; } });

  assert.equal(stopped, 1);
});

// ---- the pro-only mask button ------------------------------------------------------

test('a pro account gets the mask-edit button', () => {
  const h = mount({ plan: 'pro' });

  const c = h.island.createAIImageWithDownload(PNG, 'alt', 'staged-room');

  const btn = c.querySelector('.ai-image-mask-btn');
  assert.ok(btn, 'the button is there');

  btn.emit('click', { stopPropagation() {} });
  assert.deepEqual(h.masked, [{ src: PNG, type: 'staged-room' }]);
});

test('a free account does not', () => {
  const h = mount({ plan: 'free' });

  const c = h.island.createAIImageWithDownload(PNG, 'alt');

  assert.equal(c.querySelector('.ai-image-mask-btn'), null);
});

test('a signed-out visitor does not', () => {
  const h = mount({ plan: null });

  const c = h.island.createAIImageWithDownload(PNG, 'alt');

  assert.equal(c.querySelector('.ai-image-mask-btn'), null);
});

test('the buttons are labelled, and localized once the pack is up', () => {
  const plain = mount({ plan: 'pro' });
  const c1 = plain.island.createAIImageWithDownload(PNG, 'alt');
  assert.equal(c1.querySelector('.ai-image-download-btn').getAttribute('aria-label'), 'Download image');
  dom.restore();
  dom = null;

  const localized = mount({ plan: 'pro', langLoaded: true });
  const c2 = localized.island.createAIImageWithDownload(PNG, 'alt');
  assert.match(
    c2.querySelector('.ai-image-download-btn').getAttribute('aria-label'),
    /^LOC:/,
    'the language pack wins once it has loaded',
  );
});

test('the icons inside the buttons are hidden from assistive tech', () => {
  // The button already carries the label; announcing the icon too reads it twice.
  const h = mount({ plan: 'pro' });

  const c = h.island.createAIImageWithDownload(PNG, 'alt');

  for (const cls of ['.ai-image-download-btn', '.ai-image-mask-btn']) {
    const icon = c.querySelector(cls).querySelector('img');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.alt, '');
  }
});

// ---- the mask-edit carousel ----------------------------------------------------------

test('a first mask edit builds a carousel holding the original and the edit', () => {
  const h = mount();

  const carousel = h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG], null);

  assert.ok(carousel.classList.contains('masked-image-carousel'));
  const items = carousel.querySelectorAll('.masked-image-carousel-item');
  assert.equal(items.length, 2, 'the original plus one edit');
});

test('a second mask edit is appended and numbered correctly', () => {
  // THE BUG: the version number used to come from the item count rather than the
  // slice offset, so this edit announced itself as "(3 of 2)". The label is how the
  // user tells two similar edits apart, so being one out is not cosmetic.
  const h = mount();
  const carousel = h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG], null);

  h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG, WEBP], carousel);

  const items = carousel.querySelectorAll('.masked-image-carousel-item');
  assert.equal(items.length, 3, 'original + two edits');

  // The first edit was created when it was the only one, and imageCountSuffix omits
  // the number in that case — so exactly one label carries a digit, and it belongs to
  // the edit that was just appended. It must read (2): the second of two.
  const numbered = carousel
    .querySelectorAll('.ai-generated-image')
    .map((img) => img.alt)
    .filter((alt) => /\(\d+\)/.test(alt));

  assert.equal(numbered.length, 1, `expected one numbered label, got ${JSON.stringify(numbered)}`);
  assert.match(numbered[0], /\(2\)/, 'the second edit is the second');
  assert.ok(
    !/\(3\)/.test(numbered[0]),
    `nothing may be numbered 3 when there are only 2 edits: ${numbered[0]}`,
  );
});

test('appending does not duplicate the edits already in the carousel', () => {
  const h = mount();
  const carousel = h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG], null);

  h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG, WEBP], carousel);
  h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG, WEBP], carousel);

  assert.equal(
    carousel.querySelectorAll('.masked-image-carousel-item').length,
    3,
    'the second call with an unchanged list adds nothing',
  );
});

test('an undefined entry is skipped rather than rendered as a broken image', () => {
  const h = mount();
  const carousel = h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG], null);

  h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG, undefined], carousel);

  assert.equal(carousel.querySelectorAll('.masked-image-carousel-item').length, 2);
  assert.ok(h.errors.length > 0, 'and the bad entry is reported rather than swallowed');
});

test('every image in the carousel gets its own dot', () => {
  const h = mount();
  const carousel = h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG], null);

  h.island.createOrUpdateMaskedImageCarousel(PNG, [JPG, WEBP], carousel);

  const containers = carousel.querySelectorAll('.ai-image-container');
  for (const c of containers) {
    const dots = c.querySelector('.masked-image-carousel-dots');
    if (!dots) continue;
    assert.equal(
      dots.querySelectorAll('.masked-image-carousel-dot').length,
      3,
      'each container shows a dot per image, so the position reads the same everywhere',
    );
  }
});
