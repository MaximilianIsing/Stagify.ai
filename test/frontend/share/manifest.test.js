// Tier: frontend pure logic — the share page's addressing, its manifest narrowing, and
// its single network call. No DOM needed for any of it, which is the point of having
// separated them from the renderer.
//
// WHAT IS ACTUALLY LOAD-BEARING HERE, as opposed to restating the implementation:
//
//  1. THE TOKEN COMES FROM THE PATH. `/s/<token>` is the contract with the server, and
//     `?token=` is the thing a reasonable person reaches for instead. A parser that
//     accepted both would work in every manual test and 404 on every real link, so the
//     query-string forms are asserted to yield NOTHING.
//  2. `showBefore` GATES A FETCH FOR SOMEBODY'S UNSTAGED HOME. It is honoured only when
//     it is literally `true`, and when it is off the `photoId` is erased at the boundary
//     rather than merely ignored at the img tag — so there is one place that decision
//     lives and no way to re-open it downstream.
//  3. EVERY FAILURE IS ONE FAILURE. A 404, a 500, an HTML error page, a dead network and
//     a body with no `listing` all have to produce the same `{ ok: false }` with no status
//     or reason carried forward. The server withholds the reason on purpose; a client that
//     smuggled it out would undo that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_ROOT,
  SHARE_PREFIX,
  feedbackUrl,
  manifestUrl,
  parseShareToken,
  photoUrl,
  renderUrl,
} from '../../../public/scripts/share/token.js';
import { DEFAULT_DISCLOSURE, hasAgent, normalizeListing } from '../../../public/scripts/share/model.js';
import { fetchListing } from '../../../public/scripts/share/api.js';
import {
  NOTE_LIMIT,
  indexResponses,
  normalizeAllowance,
  normalizeResponse,
  normalizeResponses,
  rememberedLabel,
  slotKey,
} from '../../../public/scripts/share/feedback-model.js';
import { fetchFeedback, sendFeedback } from '../../../public/scripts/share/feedback-api.js';

// ── Token parsing ────────────────────────────────────────────────────────────

test('the token is read out of the /s/<token> path', () => {
  assert.equal(SHARE_PREFIX, '/s/');
  assert.equal(parseShareToken('/s/abc123'), 'abc123');
  assert.equal(parseShareToken('/s/abc123/'), 'abc123', 'a trailing slash is the same link');
});

test('a percent-encoded token is decoded, and a malformed escape keeps the raw text', () => {
  assert.equal(parseShareToken('/s/a%20b'), 'a b');
  // `%zz` is not a valid escape. decodeURIComponent throws on it; losing the token
  // outright would render "no longer available" for a link the server might well accept.
  assert.equal(parseShareToken('/s/a%zz'), 'a%zz');
});

test('a query string is NOT a share link, in any of its plausible spellings', () => {
  // This is the mistake the module exists to prevent — see the header.
  assert.equal(parseShareToken('/?token=abc'), null);
  assert.equal(parseShareToken('/share?token=abc'), null);
  assert.equal(parseShareToken('/s?token=abc'), null);
});

test('anything that is not exactly one segment under /s/ answers null', () => {
  for (const path of ['/s/', '/s', '/', '', '/listing/abc', '/s/abc/extra', '/S/abc']) {
    assert.equal(parseShareToken(path), null, `${JSON.stringify(path)} must not parse`);
  }
});

test('a non-string pathname does not throw', () => {
  for (const value of [null, undefined, 42, {}]) {
    assert.equal(parseShareToken(/** @type {any} */ (value)), null);
  }
});

// ── URL building ─────────────────────────────────────────────────────────────

test('the four URLs hang off one API root', () => {
  assert.equal(API_ROOT, '/api/share');
  assert.equal(manifestUrl('tok'), '/api/share/tok');
  assert.equal(renderUrl('tok', 'r1'), '/api/share/tok/render/r1');
  assert.equal(photoUrl('tok', 'p1'), '/api/share/tok/photo/p1');
  assert.equal(feedbackUrl('tok'), '/api/share/tok/feedback');
});

test('ids are escaped into the path, so a stray slash cannot change the route', () => {
  assert.equal(renderUrl('tok/en', 'r/1'), '/api/share/tok%2Fen/render/r%2F1');
  assert.equal(photoUrl('tok', '../secret'), '/api/share/tok/photo/..%2Fsecret');
  assert.equal(feedbackUrl('tok/en'), '/api/share/tok%2Fen/feedback');
});

// ── Manifest narrowing ───────────────────────────────────────────────────────

/**
 * The shape the server documents, with one room and one frame. Typed `any` deliberately:
 * half the tests below mutate it into shapes the server should never send, which is the
 * whole point of a narrowing layer.
 * @returns {any}
 */
const sampleListing = () => ({
  title: '12 Oak Avenue',
  address: 'Springfield, IL',
  headline: 'Freshly staged',
  note: 'Let me know what you think.',
  showBefore: true,
  agent: { name: 'Dana Reed', email: 'dana@example.com', phone: '+1 555 0100' },
  rooms: [{
    key: 'living-1',
    label: 'Living room',
    frames: [{ renderId: 'abc', photoId: 'def', width: 1536, height: 1024, arLabel: '3:2' }],
  }],
  frameCount: 1,
  disclosure: 'Photos on this page have been virtually staged.',
});

test('a well-formed manifest survives narrowing intact', () => {
  const listing = normalizeListing(sampleListing());
  assert.equal(listing.title, '12 Oak Avenue');
  assert.equal(listing.showBefore, true);
  assert.equal(listing.rooms.length, 1);
  assert.deepEqual(listing.rooms[0].frames[0], {
    renderId: 'abc', photoId: 'def', width: 1536, height: 1024, arLabel: '3:2',
  });
  assert.equal(listing.frameCount, 1);
  assert.equal(listing.agent.name, 'Dana Reed');
});

test('showBefore is honoured only when it is literally true', () => {
  for (const value of ['true', 1, 'yes', {}, [], 'false']) {
    const listing = normalizeListing({ ...sampleListing(), showBefore: value });
    assert.equal(listing.showBefore, false, `${JSON.stringify(value)} must not enable the before view`);
    assert.equal(listing.rooms[0].frames[0].photoId, null, 'and the photo id must be erased with it');
  }
});

test('a frame with no renderId is dropped rather than rendered as a broken image', () => {
  const raw = sampleListing();
  raw.rooms[0].frames = [
    { renderId: '', photoId: 'x' },
    { renderId: 'keep', photoId: 'y' },
    { photoId: 'z' },
    null,
  ];
  const listing = normalizeListing(raw);
  assert.deepEqual(listing.rooms[0].frames.map((f) => f.renderId), ['keep']);
  assert.equal(listing.frameCount, 1, 'the count describes what will be drawn');
});

test('a room left with no frames is removed, heading and all', () => {
  const raw = sampleListing();
  raw.rooms = [
    { key: 'a', label: 'Empty', frames: [] },
    { key: 'b', label: 'Kitchen', frames: [{ renderId: 'k1' }] },
  ];
  const listing = normalizeListing(raw);
  assert.deepEqual(listing.rooms.map((r) => r.label), ['Kitchen']);
});

test('missing labels and keys get positional fallbacks rather than blanks', () => {
  const listing = normalizeListing({ rooms: [{ frames: [{ renderId: 'r' }] }] });
  assert.equal(listing.rooms[0].label, 'Room');
  assert.equal(listing.rooms[0].key, 'room-1');
});

test('dimensions are positive integers or null — never NaN in a width attribute', () => {
  const listing = normalizeListing({
    rooms: [{
      label: 'X',
      frames: [
        { renderId: 'a', width: '1536.4', height: 1024 },
        { renderId: 'b', width: 0, height: -3 },
        { renderId: 'c', width: 'wide', height: null },
      ],
    }],
  });
  assert.deepEqual(listing.rooms[0].frames.map((f) => [f.width, f.height]), [
    [1536, 1024], [null, null], [null, null],
  ]);
});

test('an absent disclosure falls back to a real sentence, never an empty block', () => {
  assert.equal(normalizeListing({}).disclosure, DEFAULT_DISCLOSURE);
  assert.ok(DEFAULT_DISCLOSURE.length > 40, 'the fallback has to actually disclose something');
});

test('normalizing is total — null, a string and an array all produce a listing', () => {
  for (const value of [null, undefined, 'nope', [], 7]) {
    const listing = normalizeListing(value);
    assert.equal(listing.rooms.length, 0);
    assert.equal(listing.frameCount, 0);
    assert.equal(listing.title, '');
    assert.equal(listing.agent.email, '');
  }
});

test('hasAgent is true for any one field and false for none', () => {
  assert.equal(hasAgent({ name: '', email: '', phone: '' }), false);
  assert.equal(hasAgent({ name: 'A', email: '', phone: '' }), true);
  assert.equal(hasAgent({ name: '', email: '', phone: '555' }), true);
  assert.equal(hasAgent(/** @type {any} */ (null)), false);
});

// ── The network call ─────────────────────────────────────────────────────────

/** A fetch stub that records its calls. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { fn, calls };
}

test('fetchListing GETs the manifest URL anonymously', async () => {
  const { fn, calls } = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ listing: sampleListing() }),
  }));
  const result = await fetchListing('tok', /** @type {any} */ (fn));
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, '/api/share/tok');
  assert.equal(
    calls[0].init.credentials,
    'omit',
    'this is a link forwarded to strangers — it must not carry the broker\'s session',
  );
});

test('a 404 is an unavailable link, with nothing carried out of it', async () => {
  const { fn } = stubFetch(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: 'revoked', code: 'SHARE_REVOKED' }),
  }));
  const result = await fetchListing('tok', /** @type {any} */ (fn));
  // Deep-equal, not `result.ok === false`: the assertion is that the reason did NOT come
  // along for the ride. The server hides it deliberately, and a UI that could see `code`
  // would eventually show it.
  assert.deepEqual(result, { ok: false });
});

test('every other failure mode produces the same value', async () => {
  const cases = {
    'a 500': async () => ({ ok: false, status: 500, json: async () => ({}) }),
    'an HTML error page': async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
    'a 200 with no listing': async () => ({ ok: true, status: 200, json: async () => ({}) }),
    'a listing that is not an object': async () => ({ ok: true, status: 200, json: async () => ({ listing: 'nope' }) }),
    'a dead network': async () => {
      throw new TypeError('Failed to fetch');
    },
  };
  for (const [label, handler] of Object.entries(cases)) {
    const { fn } = stubFetch(handler);
    assert.deepEqual(await fetchListing('tok', /** @type {any} */ (fn)), { ok: false }, label);
  }
});

test('fetchListing never rejects, and never fires without a token', async () => {
  const { fn, calls } = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  assert.deepEqual(await fetchListing('', /** @type {any} */ (fn)), { ok: false });
  assert.equal(calls.length, 0, 'an empty token cannot succeed — do not ask the server');
});

// ── The reply channel: narrowing ─────────────────────────────────────────────
//
// The second boundary on this page, and the one with the sharpest edges. Two things below
// are behaviour rather than hygiene: an unrecognised verdict is DROPPED (it would otherwise
// fall through every render branch and show a seller a blank form for a question they have
// already answered), and `full` is DERIVED from used/limit rather than merely read.

test('a verdict is one of exactly two strings — anything else is dropped, not rendered', () => {
  for (const verdict of ['approve', 'APPROVED', '', null, 1, true, 'rejected', undefined]) {
    assert.equal(
      normalizeResponse({ roomKey: 'k', verdict, note: 'x' }),
      null,
      `${JSON.stringify(verdict)} must not survive narrowing`,
    );
  }
  assert.ok(normalizeResponse({ verdict: 'approved' }));
  assert.ok(normalizeResponse({ verdict: 'changes' }));
});

test('a stored response is narrowed to fixed types, with the listing answer keyed on null', () => {
  assert.deepEqual(
    normalizeResponse({ roomKey: '  living-1 ', verdict: 'changes', note: '  too big  ', viewerLabel: ' Sam ' }),
    { roomKey: 'living-1', verdict: 'changes', note: 'too big', viewerLabel: 'Sam' },
  );
  // The whole-listing answer carries no room. '' and a missing field mean the same thing.
  assert.equal(normalizeResponse({ roomKey: '', verdict: 'approved' }).roomKey, null);
  assert.equal(normalizeResponse({ verdict: 'approved' }).roomKey, null);
  assert.equal(normalizeResponse({ verdict: 'approved' }).note, '');
});

test('a note is clamped to the same limit the server clamps at', () => {
  assert.equal(NOTE_LIMIT, 500, 'the UI counter and the server clamp are the same number');
  const long = 'x'.repeat(900);
  assert.equal(normalizeResponse({ verdict: 'changes', note: long }).note.length, NOTE_LIMIT);
});

test('slotKey maps the listing answer and a room answer into one keyspace', () => {
  assert.equal(slotKey(null), '');
  assert.equal(slotKey(undefined), '');
  assert.equal(slotKey(''), '');
  assert.equal(slotKey('living-1'), 'living-1');
});

test('normalizeResponses drops the unusable rows and keeps the rest in order', () => {
  const out = normalizeResponses([
    { roomKey: 'a', verdict: 'approved' },
    { roomKey: 'b', verdict: 'nonsense' },
    null,
    'nope',
    { roomKey: 'c', verdict: 'changes', note: 'n' },
  ]);
  assert.deepEqual(out.map((r) => r.roomKey), ['a', 'c']);
  assert.deepEqual(normalizeResponses(null), []);
  assert.deepEqual(normalizeResponses('nope'), []);
});

test('the ceiling is derived from used/limit, not only read off the flag', () => {
  // A server that sends the counts and forgets the flag must still stop the page offering
  // a form that is guaranteed to 409.
  assert.deepEqual(normalizeAllowance({ used: 5, limit: 5 }), { used: 5, limit: 5, full: true });
  assert.deepEqual(normalizeAllowance({ used: 9, limit: 5 }), { used: 9, limit: 5, full: true });
  assert.deepEqual(normalizeAllowance({ used: 1, limit: 5 }), { used: 1, limit: 5, full: false });
  // …and an explicit flag is honoured even when the counts do not imply it.
  assert.equal(normalizeAllowance({ used: 0, limit: 9, full: true }).full, true);
});

test('an unconfigured limit is not a ceiling of zero', () => {
  // `limit: 0` means "no ceiling". Without the `limit > 0` guard, 0 >= 0 would lock the
  // page shut on first load for every link on a server that does not cap replies.
  assert.deepEqual(normalizeAllowance({}), { used: 0, limit: 0, full: false });
  assert.deepEqual(normalizeAllowance(null), { used: 0, limit: 0, full: false });
  assert.equal(normalizeAllowance({ used: 'lots', limit: 'many' }).full, false, 'nonsense is not a ceiling');
});

test('the index keeps the LATEST answer per slot, so a change of mind wins', () => {
  const map = indexResponses(normalizeResponses([
    { roomKey: 'living-1', verdict: 'approved' },
    { roomKey: null, verdict: 'approved' },
    { roomKey: 'living-1', verdict: 'changes', note: 'actually, swap the rug' },
  ]));
  assert.equal(map.get('living-1').verdict, 'changes');
  assert.equal(map.get('living-1').note, 'actually, swap the rug');
  assert.equal(map.get('').verdict, 'approved', 'the listing answer sits alongside, keyed on \'\'');
  assert.equal(map.size, 2);
});

test('the remembered name is the most recent one this link used', () => {
  assert.equal(rememberedLabel(normalizeResponses([
    { verdict: 'approved', viewerLabel: 'Sam' },
    { verdict: 'approved' },
    { roomKey: 'k', verdict: 'approved', viewerLabel: 'Sam Reyes' },
  ])), 'Sam Reyes');
  assert.equal(rememberedLabel([]), '', 'never required, so never invented');
});

// ── The reply channel: the two calls ─────────────────────────────────────────
//
// Unlike the manifest, this endpoint MUST distinguish its failures — see feedback-api.js.
// The one that matters most is the 409: it is a calm state ("we already have your notes"),
// and painting it as an error would tell a seller they broke something when they did not.

test('fetchFeedback reads the collection anonymously and narrows what it gets', async () => {
  const { fn, calls } = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      responses: [{ roomKey: 'living-1', verdict: 'approved' }, { verdict: 'bogus' }],
      allowance: { used: 1, limit: 5 },
    }),
  }));
  const state = await fetchFeedback('tok', /** @type {any} */ (fn));
  assert.equal(state.ok, true);
  assert.equal(calls[0].url, '/api/share/tok/feedback');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(state.responses.length, 1, 'the bogus verdict was dropped at the boundary');
  assert.deepEqual(state.allowance, { used: 1, limit: 5, full: false });
});

test('a 404 from the feedback GET is the capability probe answering "no"', async () => {
  // This is what makes the whole reply UI never render on an older server. Deep-equal, so
  // nothing that could be mistaken for a usable state comes back with it.
  const { fn } = stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.deepEqual(await fetchFeedback('tok', /** @type {any} */ (fn)), { ok: false, absent: true });
});

test('every other feedback GET failure is NOT "no such feature" — the route answered', async () => {
  // The correction. These used to be indistinguishable from a 404, so a rate limit, a 5xx or
  // one dropped request on a phone hid the seller's only way to reply and told them nothing.
  // Only `absent` may hide the channel, and none of these are absent.
  const cases = {
    'a 500': async () => ({ ok: false, status: 500, json: async () => ({}) }),
    'a 429 from the read limiter': async () => ({ ok: false, status: 429, json: async () => ({}) }),
    'a dead network': async () => {
      throw new TypeError('Failed to fetch');
    },
  };
  for (const [label, handler] of Object.entries(cases)) {
    const { fn } = stubFetch(handler);
    assert.deepEqual(await fetchFeedback('tok', /** @type {any} */ (fn)), { ok: false, absent: false }, label);
  }
});

test('a 200 with a garbage body still yields an empty, usable state', async () => {
  // An empty gallery of answers is a legitimate state (nobody has replied yet) and must not
  // be confused with "the endpoint is missing" — that is the difference between showing the
  // form and hiding it.
  const { fn } = stubFetch(async () => ({ ok: true, status: 200, json: async () => 'nope' }));
  const state = await fetchFeedback('tok', /** @type {any} */ (fn));
  assert.equal(state.ok, true);
  assert.deepEqual(state.responses, []);
  assert.deepEqual(state.allowance, { used: 0, limit: 0, full: false });
});

test('sendFeedback POSTs JSON anonymously and echoes what the server stored', async () => {
  const { fn, calls } = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      feedback: { roomKey: 'living-1', verdict: 'changes', note: 'clamped by the server' },
      allowance: { used: 2, limit: 5 },
    }),
  }));
  const result = await sendFeedback(
    'tok',
    { roomKey: 'living-1', verdict: 'changes', note: 'too big', viewerLabel: 'Sam' },
    /** @type {any} */ (fn),
  );
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, '/api/share/tok/feedback');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    roomKey: 'living-1', verdict: 'changes', note: 'too big', viewerLabel: 'Sam',
  });
  assert.equal(result.feedback.note, 'clamped by the server', 'the server is the authority');
  assert.deepEqual(result.allowance, { used: 2, limit: 5, full: false });
});

test('a whole-listing answer sends roomKey: null, not an empty string', async () => {
  const { fn, calls } = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn));
  assert.equal(JSON.parse(calls[0].init.body).roomKey, null);
});

test('a 409 FEEDBACK_FULL is the calm ceiling, and carries the allowance out with it', async () => {
  const { fn } = stubFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'no more', code: 'FEEDBACK_FULL', allowance: { used: 5, limit: 5, full: true } }),
  }));
  const result = await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn));
  assert.deepEqual(result, { ok: false, code: 'FULL', allowance: { used: 5, limit: 5, full: true } });
});

test('a 409 with no allowance in the body is STILL the ceiling', async () => {
  // The live refusal is `{ error, code }` and nothing more (routes/share-feedback.js uses
  // sendError, which emits no allowance). Parsing the absent field would yield
  // `full: false` and leave every panel still offering a form guaranteed to 409 again —
  // so the STATUS is the authority here, not the body.
  const { fn } = stubFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'This link has collected all the responses it can hold', code: 'FEEDBACK_FULL' }),
  }));
  const result = await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FULL');
  assert.equal(result.allowance.full, true);
});

test('a 409 that means something else is NOT painted as "we already have your notes"', async () => {
  const { fn } = stubFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ code: 'SOMETHING_ELSE' }),
  }));
  const result = await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn));
  assert.deepEqual(result, { ok: false, code: 'ERROR' });
});

test('a 429 is its own code, because "please try again" is wrong advice for a rate limit', async () => {
  const { fn } = stubFetch(async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: 'Too many responses. Please wait a few minutes and try again.' }),
  }));
  const result = await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: 'x', viewerLabel: '' }, /** @type {any} */ (fn));
  // Not ERROR: the panel keys its copy off this, and the limiter's window outlasts any
  // retry a seller would make after being told to retry.
  assert.deepEqual(result, { ok: false, code: 'THROTTLED' });
});

test('a 400, a 500 and a dead network are three quiet failures, not one crash', async () => {
  const cases = [
    [400, { ok: false, code: 'INVALID' }],
    [500, { ok: false, code: 'ERROR' }],
    [503, { ok: false, code: 'ERROR' }],
    [404, { ok: false, code: 'ERROR' }],
  ];
  for (const [status, expected] of cases) {
    const { fn } = stubFetch(async () => ({ ok: false, status, json: async () => ({}) }));
    assert.deepEqual(
      await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn)),
      expected,
      `HTTP ${status}`,
    );
  }
  const { fn } = stubFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.deepEqual(
    await sendFeedback('tok', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn)),
    { ok: false, code: 'ERROR' },
  );
});

test('neither feedback call fires without a token', async () => {
  const { fn, calls } = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  // `absent`: with no token there is nothing to probe and nothing a rendered form could do,
  // so this takes the hide branch rather than the offer-it-anyway one.
  assert.deepEqual(await fetchFeedback('', /** @type {any} */ (fn)), { ok: false, absent: true });
  assert.deepEqual(
    await sendFeedback('', { roomKey: null, verdict: 'approved', note: '', viewerLabel: '' }, /** @type {any} */ (fn)),
    { ok: false, code: 'ERROR' },
  );
  assert.equal(calls.length, 0);
});
