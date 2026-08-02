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
import { renderAgent, renderGallery } from '../../../public/scripts/share/view.js';
import { createRefresher, MAX_ATTEMPTS } from '../../../public/scripts/share/refresh.js';
import { start } from '../../../public/scripts/share/main.js';
import { shareDocument, fakeFetch, pageSource } from '../../helpers/share-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MANIFEST = {
  headline: 'Living room, staged',
  note: 'Let me know what you think',
  agent: { name: 'A. Broker', email: 'a@example.com', phone: '+1 555 0100' },
  rooms: [{
    key: 'room',
    label: 'Living room',
    frames: [{ renderId: 'abc', url: 'https://r2.example/after.webp?sig=1', thumbUrl: 'https://r2.example/thumb.webp?sig=1', width: 1024, height: 683 }],
  }],
  frameCount: 1,
  disclosure: 'Photos on this page have been virtually staged.',
};

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

test('no module in public/scripts/share assigns innerHTML', () => {
  // The whole reason dom.js exists. Every string this page renders is typed by an account
  // holder and read by a stranger who is not signed in; textContent makes the injection
  // class unreachable rather than escaped.
  const dir = path.join(ROOT, 'public', 'scripts', 'share');
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(src), `${file} assigns innerHTML`);
    assert.ok(!/\.outerHTML\s*=/.test(src), `${file} assigns outerHTML`);
    assert.ok(!/insertAdjacentHTML/.test(src), `${file} uses insertAdjacentHTML`);
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
  assert.equal(images[0].getAttribute('src'), MANIFEST.rooms[0].frames[0].thumbUrl, 'thumb first');
  assert.match(images[0].getAttribute('alt'), /Living room/);
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

test('the page carries no data-lang attributes', () => {
  // It is deliberately absent from LOCALIZED_PAGES: a tokenized URL has nowhere to
  // express a language, and adding lookups would pull in the 11-pack drift tests.
  assert.ok(!/data-lang=/.test(pageSource()));
});
