// The public share page (public/scripts/share/*).
//
// This is the only page in the app an anonymous stranger renders, and everything on it
// is a string somebody else typed. So the tests that matter are: nothing is ever written
// as HTML, a contact detail becomes a link only when it validates, every failure looks
// the same, and an expired image URL recovers on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShareToken, manifestUrl } from '../../../public/scripts/share/token.js';
import { fetchManifest } from '../../../public/scripts/share/api.js';
import { contactHref, el, replaceChildren } from '../../../public/scripts/share/dom.js';
import { renderAgent, renderGallery, shareTitle, formatStagedAt } from '../../../public/scripts/share/view.js';
import { createRefresher, MAX_ATTEMPTS } from '../../../public/scripts/share/refresh.js';
import { start } from '../../../public/scripts/share/main.js';
import { shareDocument, fakeFetch, pageSource } from '../../helpers/share-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MANIFEST = {
  headline: 'Living room, staged',
  note: 'Let me know what you think',
  name: '',
  roomType: 'Living room',
  furnitureStyle: 'modern',
  stagedAt: Date.UTC(2026, 7, 1, 15, 30),
  agent: { name: 'A. Broker', email: 'a@example.com', phone: '+1 555 0100' },
  rooms: [{
    key: 'room',
    label: 'Living room',
    frames: [{ renderId: 'abc', url: 'https://r2.example/after.webp?sig=1', thumbUrl: 'https://r2.example/thumb.webp?sig=1', width: 1024, height: 683 }],
  }],
  frameCount: 1,
  disclosure: 'Photos on this page have been virtually staged.',
};

/** The same manifest with no agent headline, which is what the server actually sends. */
const UNHEADLINED = { ...MANIFEST, headline: '' };

// ---- the token ---------------------------------------------------------------------

test('the token is read from the path and nothing else', () => {
  assert.equal(parseShareToken('/s/AbCd1234efGH5678ijKL'), 'AbCd1234efGH5678ijKL');
  assert.equal(parseShareToken('/s/AbCd1234efGH5678ijKL/extra'), 'AbCd1234efGH5678ijKL');
  // A malformed token never becomes a request: not asking is one less line in a log.
  for (const bad of ['/s/', '/s/short', '/s/has spaces here!!', '/', '/gallery.html', `/s/${'a'.repeat(200)}`]) {
    assert.equal(parseShareToken(bad), '', `${bad} must not parse`);
  }
});

test('the manifest URL encodes the token', () => {
  assert.equal(manifestUrl('abc'), '/api/share/abc');
});

// ---- every failure looks identical --------------------------------------------------

test('every manifest failure collapses to ok:false', async () => {
  // The server answers one 404 for unknown, revoked, expired and not-yours specifically
  // so the surface is not an oracle. Distinguishing them here would rebuild it in the
  // client and hand it to anyone who opens devtools.
  for (const plan of [{ status: 404 }, { status: 403 }, { status: 500 }, { throws: true }, { status: 200, json: null }, { status: 200, json: { rooms: 'nope' } }]) {
    const res = await fetchManifest('/api/share/x', fakeFetch(plan));
    assert.deepEqual(res, { ok: false }, `${JSON.stringify(plan)} must be indistinguishable`);
  }
});

test('the manifest request sends no credentials', async () => {
  // The owner opening their own link must make the same request a buyer does; attaching
  // their session would be a different (and confusing) response.
  let init = null;
  await fetchManifest('/api/share/x', async (_url, opts) => {
    init = opts;
    return { ok: true, status: 200, json: async () => MANIFEST };
  });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
});

// ---- nothing is ever written as HTML ------------------------------------------------

test('no module in public/scripts/share or public/scripts/gallery assigns innerHTML', () => {
  // The whole reason dom.js exists. Every string this page renders is typed by an account
  // holder and read by a stranger who is not signed in; textContent makes the injection
  // class unreachable rather than escaped.
  //
  // The gallery is swept too, and not because it is a second public surface — it is the
  // owner's own page. It renders the SAME account-typed strings (room type, the extra
  // prompt) through the SAME dom.js, and the two halves have to agree: a value that goes
  // in as text on the share page and as HTML here is still one stored payload away from
  // mattering. The sweep covered only `share/` while gallery/view.js's no-innerHTML
  // property rested entirely on nobody deciding otherwise.
  for (const folder of ['share', 'gallery']) {
    const dir = path.join(ROOT, 'public', 'scripts', folder);
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!/\.innerHTML\s*=/.test(src), `${folder}/${file} assigns innerHTML`);
      assert.ok(!/\.outerHTML\s*=/.test(src), `${folder}/${file} assigns outerHTML`);
      assert.ok(!/insertAdjacentHTML/.test(src), `${folder}/${file} uses insertAdjacentHTML`);
    }
  }
});

test('el() puts text in through textContent, so markup is inert', () => {
  const { document } = shareDocument();
  const node = el('p', { doc: document, text: '<img src=x onerror=alert(1)>' });
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(node.children.length, 0, 'nothing was parsed into elements');
});

test('replaceChildren empties before appending', () => {
  const { document } = shareDocument();
  const parent = el('div', { doc: document, children: [el('span', { doc: document, text: 'old' })] });
  replaceChildren(parent, [el('span', { doc: document, text: 'new' })]);
  assert.equal(parent.children.length, 1);
  assert.equal(parent.textContent, 'new');
});

// ---- contact links are VALIDATED, not escaped ---------------------------------------

test('a contact detail becomes a link only when it validates', () => {
  assert.equal(contactHref('mailto', 'a@example.com'), 'mailto:a%40example.com');
  assert.equal(contactHref('tel', '+1 555 0100'), 'tel:+15550100');
});

test('a hostile scheme cannot be smuggled into an href', () => {
  // Escaping would not help here: the danger is the SCHEME, not the characters. Building
  // the URL from a scheme we chose plus a value that must match a shape is what closes it.
  for (const evil of [
    'javascript:alert(1)',
    'javascript:alert(1)@example.com',
    'data:text/html,<script>alert(1)</script>',
    'a@example.com" onmouseover="alert(1)',
    'a@example.com\nBcc: victim@example.com',
    ' javascript:alert(1) ',
  ]) {
    assert.equal(contactHref('mailto', evil), null, `${evil} must not make an href`);
    assert.equal(contactHref('tel', evil), null, `${evil} must not make an href`);
  }
  for (const junk of [null, undefined, 42, '', 'x'.repeat(500), {}]) {
    assert.equal(contactHref('mailto', junk), null);
  }
});

test('an unvalidatable contact detail is shown as text, not dropped', () => {
  // An agent who mistyped their own email should SEE the mistake, not have their card
  // silently lose a line.
  const { document } = shareDocument();
  const container = document.createElement('aside');
  renderAgent({ container, doc: document, agent: { name: 'A. Broker', email: 'not-an-email', phone: '' } });

  const rendered = container.descendants();
  assert.ok(rendered.some((n) => n.textContent === 'not-an-email'), 'still visible');
  assert.ok(!rendered.some((n) => n.tagName === 'A'), 'but never a link');
});

test('an agent card with nothing in it stays hidden', () => {
  const { document } = shareDocument();
  const container = document.createElement('aside');
  container.hidden = true;
  renderAgent({ container, doc: document, agent: { name: '', email: '', phone: '' } });
  assert.equal(container.hidden, true);
});

// ---- the gallery --------------------------------------------------------------------

test('a frame reserves its aspect ratio before the bytes land', () => {
  // A reflow while somebody is looking at the page reads as broken, and on a phone it
  // moves the thing they were about to tap.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const images = renderGallery({ gallery, manifest: MANIFEST, doc: document, onOpen: () => {} });

  const button = gallery.children[0].children[0];
  assert.equal(button.style.props['--sh-ar'], '1024 / 683');
  assert.equal(images.length, 1);
  assert.match(images[0].getAttribute('alt'), /Living room/);
});

test('the frame shows the FULL render, not the 480px thumbnail', () => {
  // The bug this exists for: the page painted the thumbnail across a box up to 852px wide
  // (and the whole width of a phone at 2-3x), so the photo looked soft — and sharpened the
  // instant the lightbox opened the full URL. The thumb is still offered through srcset,
  // where the browser can weigh it against the viewport it can actually see.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const [img] = renderGallery({ gallery, manifest: MANIFEST, doc: document, onOpen: () => {} });
  const frame = MANIFEST.rooms[0].frames[0];

  assert.equal(img.getAttribute('src'), frame.url, 'the visible photo must be the full render');
  assert.equal(img.getAttribute('srcset'), `${frame.thumbUrl} 480w, ${frame.url} 1024w`);
  // A `sizes` that does not match the layout makes the browser's choice wrong in exactly
  // the way this is fixing, so it is pinned to what share.css lays out.
  assert.equal(img.getAttribute('sizes'), '(min-width: 720px) 852px, 100vw');
});

test('a frame with no thumbnail offers no srcset rather than a one-candidate one', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const [img] = renderGallery({
    gallery,
    doc: document,
    manifest: { ...MANIFEST, rooms: [{ label: 'Living room', frames: [{ renderId: 'a', url: '/after.webp', width: 1024, height: 683 }] }] },
    onOpen: () => {},
  });
  assert.equal(img.getAttribute('src'), '/after.webp');
  assert.equal(img.getAttribute('srcset'), null);
});

// ---- the before/after variant --------------------------------------------------------
//
// Drawn only when the manifest carries a `beforeUrl`, which the server sends only when the
// render's owner has ticked "include the before photo". The default shape above — the
// staged photo as the button — is what every link ships with, and the specs above are what
// pin that it is untouched.

/** The same manifest with the owner's opt-in applied. */
const WITH_BEFORE = {
  ...MANIFEST,
  rooms: [{
    ...MANIFEST.rooms[0],
    frames: [{ ...MANIFEST.rooms[0].frames[0], beforeUrl: 'https://r2.example/before.webp?sig=1' }],
  }],
};

test('a frame with no beforeUrl draws no comparison at all', () => {
  // The seam and the grip are gated on the range existing (compare.css), so a stray
  // container here would claim a comparison the page cannot make.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: MANIFEST, doc: document, onOpen: () => {} });

  const rendered = gallery.descendants();
  assert.ok(!rendered.some((n) => String(n.className).includes('compare')), 'a comparison appeared by default');
  assert.ok(!rendered.some((n) => n.getAttribute?.('type') === 'range'), 'a slider appeared by default');
});

test('a frame with a beforeUrl draws the comparison, in the order the CSS reads', () => {
  // [before, after, range]: the before image is in flow and sizes the box, the after is
  // clipped over it, and the range is the transparent hit layer above both. Any other order
  // and the control is either invisible or undraggable.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: () => {} });

  const box = gallery.children[0].children[0];
  assert.match(String(box.className), /\bcompare\b/);
  assert.equal(box.style.props['--sh-ar'], '1024 / 683', 'the comparison must reserve its box too');

  const [before, after, range] = box.children;
  assert.equal(before.getAttribute('src'), 'https://r2.example/before.webp?sig=1');
  assert.equal(after.getAttribute('src'), MANIFEST.rooms[0].frames[0].url);
  assert.equal(after.className, 'compare__after', 'the staged image is the clipped layer');
  assert.equal(range.getAttribute('type'), 'range');
});

test('the staged image keeps its srcset and its lightbox data inside the comparison', () => {
  // It is handed to the builder rather than rebuilt by it. Rebuilding would drop the srcset
  // the sharpness fix added and the fullUrl the lightbox reads.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: () => {} });

  const after = gallery.children[0].children[0].children[1];
  const frame = MANIFEST.rooms[0].frames[0];
  assert.equal(after.getAttribute('srcset'), `${frame.thumbUrl} 480w, ${frame.url} 1024w`);
  assert.equal(after.dataset.fullUrl, frame.url);
  assert.equal(after.dataset.renderId, 'abc');
});

test('both images are handed back, so an expired URL re-mints the whole comparison', () => {
  // They are presigned in the same manifest and age out together. A refresher watching only
  // the staged one leaves the reader dragging a slider over half a blank box.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const images = renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: () => {} });

  const sources = images.map((i) => i.getAttribute('src')).sort();
  assert.deepEqual(sources, ['https://r2.example/after.webp?sig=1', 'https://r2.example/before.webp?sig=1']);
});

test('the range announces which half of the comparison it is on', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: () => {} });

  const range = gallery.children[0].children[0].children[2];
  assert.ok(range.getAttribute('aria-label'), 'a range with no label is announced as a bare number');
  assert.equal(range.getAttribute('aria-valuetext'), '50% staged');

  range.value = '80';
  range.fire('input');
  assert.equal(range.getAttribute('aria-valuetext'), '80% staged');
  assert.equal(
    gallery.children[0].children[0].style.props['--compare-split'],
    '80%',
    'the clip and the two pseudo-elements all read this one property',
  );
});

test('the full-size view moves to its own button, and still opens the staged photo', () => {
  // A <button> may not contain the range input, so the lightbox cannot stay on the image.
  // What it opens is unchanged: the staged render, not the source photo.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const opened = [];
  renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: (url) => opened.push(url) });

  const box = gallery.children[0].children[0];
  assert.ok(!box.descendants().some((n) => n.tagName === 'BUTTON'), 'a button may not wrap the range');

  const full = gallery.children[0].children[1];
  assert.equal(full.tagName, 'BUTTON');
  assert.equal(full.getAttribute('type'), 'button');
  assert.ok(full.textContent.trim(), 'a button with no label is unreachable by name');
  full.fire('click');
  assert.deepEqual(opened, [MANIFEST.rooms[0].frames[0].url]);
});

test('the facts strip still follows the comparison', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: WITH_BEFORE, doc: document, onOpen: () => {} });

  const figure = gallery.children[0];
  assert.equal(figure.children.length, 3, 'comparison, full-size button, facts');
  assert.match(String(figure.children[2].className), /sh-facts/);
});

test('the lightbox opens the same URL the page is already showing', () => {
  // They were different — that is the whole reason the photo appeared to sharpen on tap.
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const opened = [];
  const images = renderGallery({
    gallery, manifest: MANIFEST, doc: document, onOpen: (url) => opened.push(url),
  });
  gallery.children[0].children[0].fire('click');
  assert.deepEqual(opened, [images[0].getAttribute('src')]);
});

// ---- what the photo is ---------------------------------------------------------------

test('the page is headed with the SAME title the owner sees in their gallery', () => {
  // "<Style> <Room type>", from scripts/render-name.js — the module the gallery derives
  // its own card and dialog headings from, so the two cannot drift.
  assert.equal(shareTitle(UNHEADLINED), 'Modern Living room');
  // The owner's own name for the render wins over the derived default...
  assert.equal(shareTitle({ ...UNHEADLINED, name: '412 Rosewood — living room' }), '412 Rosewood — living room');
  // ...and an agent headline written for this page specifically wins over both.
  assert.equal(shareTitle(MANIFEST), 'Living room, staged');
  // Nothing at all still says something.
  assert.equal(shareTitle({}), 'Staged room');
});

test('the strip under the photo carries the style, the room and the date, in that order', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({ gallery, manifest: UNHEADLINED, doc: document, onOpen: () => {} });

  const facts = gallery.children[0].children[1];
  const items = facts.children.map((n) => n.textContent);
  // Three siblings, not one string: they are what CSS lays out on one line and what the
  // separator is drawn between, so a joined string would take both away.
  assert.equal(items.length, 3);
  // The slug is capitalised, so this does not say "modern" under a heading that says
  // "Modern Living room". The date is formatted in the reader's locale, so only the year
  // is asserted.
  assert.equal(items[0], 'Modern');
  assert.equal(items[1], 'Living room');
  assert.match(items[2], /2026/);
  // The separator is CSS, so it is never read aloud and never comes along with a copy.
  assert.ok(!/·/.test(facts.textContent), 'the dot must not be in the text');
});

test('a missing field is skipped rather than printed blank', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({
    gallery,
    doc: document,
    manifest: { ...UNHEADLINED, furnitureStyle: '', stagedAt: null },
    onOpen: () => {},
  });

  // One item, so the CSS separator — drawn on every item but the first — leaves no
  // dangling dot where the style and the date would have been.
  const facts = gallery.children[0].children[1];
  assert.deepEqual(facts.children.map((n) => n.textContent), ['Living room']);
});

test('a render with nothing to say about it renders no facts block at all', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  renderGallery({
    gallery,
    doc: document,
    manifest: { rooms: MANIFEST.rooms },
    onOpen: () => {},
  });
  // The figure holds the photo and nothing else — not an empty bordered strip.
  assert.equal(gallery.children[0].children.length, 1);
});

test('an unusable timestamp formats as empty rather than "Invalid Date"', () => {
  assert.equal(formatStagedAt(NaN), '');
  assert.equal(formatStagedAt(undefined), '');
  assert.equal(formatStagedAt(null), '');
  assert.ok(formatStagedAt(Date.UTC(2026, 7, 1)).length > 0);
});

test('a frame with no URL is skipped rather than rendered broken', () => {
  const { document } = shareDocument();
  const gallery = document.createElement('div');
  const images = renderGallery({
    gallery,
    manifest: { rooms: [{ label: 'x', frames: [{ renderId: 'a', url: '' }] }] },
    onOpen: () => {},
  });
  assert.equal(images.length, 0);
  assert.equal(gallery.children.length, 0);
});

// ---- expiry recovery ----------------------------------------------------------------

test('an image error triggers ONE debounced re-fetch, not one per image', async () => {
  const { document } = shareDocument();
  const images = [document.createElement('img'), document.createElement('img'), document.createElement('img')];
  let reloads = 0;
  const timers = [];
  const refresher = createRefresher({
    images,
    reload: async () => { reloads += 1; return MANIFEST; },
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
  });
  void refresher;

  for (const img of images) img.fire('error');
  assert.equal(timers.length, 1, 'a burst of twenty broken images is one manifest request');
  await timers[0]();
  assert.equal(reloads, 1);
});

test('a reload that comes back empty flips the page to unavailable', async () => {
  // A share revoked while somebody was reading it, which is the same end state as
  // arriving on a dead link.
  const { document } = shareDocument();
  const img = document.createElement('img');
  let gaveUp = false;
  const timers = [];
  createRefresher({
    images: [img],
    reload: async () => null,
    onGiveUp: () => { gaveUp = true; },
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
  });
  img.fire('error');
  await timers[0]();
  assert.equal(gaveUp, true);
});

test('a permanently broken manifest stops re-fetching instead of looping forever', async () => {
  const { document } = shareDocument();
  const img = document.createElement('img');
  let reloads = 0;
  const timers = [];
  const refresher = createRefresher({
    images: [img],
    reload: async () => { reloads += 1; return null; },
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
  });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
    img.fire('error');
    if (timers[i]) await timers[i]();
  }
  assert.ok(reloads <= MAX_ATTEMPTS, `capped at ${MAX_ATTEMPTS}, ran ${reloads}`);
  assert.equal(refresher.attempts(), MAX_ATTEMPTS);
});

// ---- the state machine --------------------------------------------------------------

test('a good manifest renders and settles on ready', async () => {
  const { document, body, byId } = shareDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeFetch({ status: 200, json: MANIFEST }),
    pathname: '/s/AbCd1234efGH5678ijKL',
  });

  assert.equal(state, 'ready');
  assert.equal(body.getAttribute('data-state'), 'ready');
  assert.equal(byId('sh-headline').textContent, 'Living room, staged');
  assert.equal(byId('sh-note').textContent, 'Let me know what you think');
  assert.equal(byId('sh-note').hidden, false);
  // The disclosure ships in the manifest precisely so it cannot be left off the surface
  // the buyer actually reads.
  assert.equal(byId('sh-disclosure').textContent, MANIFEST.disclosure);
  assert.equal(byId('sh-gallery').children.length, 1);
});

test('a 404 settles on unavailable and renders no image at all', async () => {
  const { document, body, byId } = shareDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeFetch({ status: 404 }),
    pathname: '/s/AbCd1234efGH5678ijKL',
  });

  assert.equal(state, 'unavailable');
  assert.equal(body.getAttribute('data-state'), 'unavailable');
  assert.equal(byId('sh-gallery').children.length, 0);
  assert.match(byId('sh-headline').textContent, /no longer available/i);
});

test('a malformed token never reaches the network', async () => {
  const { document } = shareDocument();
  const fetchImpl = fakeFetch({ status: 200, json: MANIFEST });
  const state = await start({ doc: document, fetchImpl, pathname: '/s/nope' });
  assert.equal(state, 'unavailable');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- the shipped page ---------------------------------------------------------------

test('the page shell leaks nothing about whose listing it is', () => {
  // Share links get forwarded into group chats that auto-unfurl. A room, an address or an
  // agent name in a meta tag publishes a private listing to every participant and every
  // link-preview crawler that touches it.
  const src = pageSource();
  assert.match(src, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(src, /<meta name="referrer" content="no-referrer">/);
  const og = [...src.matchAll(/<meta property="og:[^"]+" content="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(og.length > 0, 'sanity: the page has og tags to check');
  for (const value of og) {
    assert.ok(/^(Staged room|A virtually staged room\.|website)$/.test(value), `og content "${value}" is too specific`);
  }
});

test('both pages take the render\'s name from ONE module', () => {
  // The share link's heading is the label the owner sees over the same photo in their own
  // gallery. That only stays true if there is one derivation: a second copy of
  // "<Style> <Room type>" drifts the first time either page is touched, and the drift is
  // invisible from inside either one.
  const read = (rel) => fs.readFileSync(path.join(ROOT, 'public', 'scripts', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  for (const file of ['gallery/view.js', 'share/view.js']) {
    const src = read(file);
    assert.match(src, /from '\.\.\/render-name\.js'/, `${file} no longer imports the shared naming rule`);
    // The join itself, in either order, is what a re-implementation looks like.
    assert.ok(!/\$\{\s*(style|room)\s*\}\s+\$\{\s*(style|room)\s*\}/.test(src), `${file} rebuilt the name locally`);
  }
  // And the module it defers to really does hold the rule, or the assertions above pass
  // against a file that no longer decides anything.
  const shared = read('render-name.js');
  assert.match(shared, /\$\{style\}\s\$\{room\}/, 'render-name.js no longer joins style and room');
});

test('the page carries no data-lang attributes', () => {
  // It is deliberately absent from LOCALIZED_PAGES: a tokenized URL has nowhere to
  // express a language, and adding lookups would pull in the 11-pack drift tests.
  assert.ok(!/data-lang=/.test(pageSource()));
});
