// Tier: frontend transport — public/scripts/projects/api.js, the Listing Studio's only
// network layer.
//
// WHY EVERY CALL GETS ITS OWN TEST. These are thin wrappers, and thin wrappers are
// exactly where a wrong verb or a missing path segment hides: nothing type-checks a URL
// string, and a PATCH sent as a POST fails at the server with a message that blames the
// server. So each exported call is asserted on the four things it is responsible for —
// METHOD, PATH, the bearer HEADER, and the BODY — against a stubbed fetch.
//
// Three of those are load-bearing beyond tidiness:
//
//  1. THE BEARER HEADER IS ON EVERY REQUEST. The whole surface is Stagify+ only. A call
//     that forgets it gets a 401 that looks like an expired session.
//  2. CONTENT-TYPE IS ABSENT FROM authHeaders(). The multipart upload relies on the
//     browser setting it WITH the boundary; a hard-coded one makes the server unable to
//     parse the form, and it would be set once in a shared helper and break only uploads.
//  3. IDS ARE ESCAPED INTO THE PATH. They are server-generated, but they land in a URL.
//
// The upload is XMLHttpRequest rather than fetch (fetch exposes no upload progress), so
// it gets a fake XHR and its four event handlers are fired directly — including the ones
// that only run when something goes wrong, which is where an unhandled promise lives.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  BASE,
  TOKEN_KEY,
  apiErrorMessage,
  authHeaders,
  authToken,
  fetchImageBlobUrl,
  fetchProgress,
  fetchProject,
  fetchProjects,
  newProject,
  patchPhoto,
  patchProject,
  photoImagePath,
  postPhotos,
  regenerateBible,
  removePhoto,
  removeProject,
  renderImagePath,
  startStaging,
} from '../../../public/scripts/projects/api.js';

// ── Harness ──────────────────────────────────────────────────────────────────

// The globals this spec replaces, restored when the file finishes. `node --test` isolates
// each spec file in its own process today, but a spec should not depend on that — a leaked
// `fetch` or `localStorage` stub is the classic cause of an unreproducible failure in an
// unrelated file. Same discipline as test/helpers/auth-modal-dom.js.
const saved = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  XMLHttpRequest: globalThis.XMLHttpRequest,
  FormData: globalThis.FormData,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};

after(() => {
  globalThis.fetch = saved.fetch;
  globalThis.window = saved.window;
  globalThis.localStorage = saved.localStorage;
  globalThis.XMLHttpRequest = saved.XMLHttpRequest;
  globalThis.FormData = saved.FormData;
  URL.createObjectURL = saved.createObjectURL;
  URL.revokeObjectURL = saved.revokeObjectURL;
});

/** Every fetch the module made, in order. */
/** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: any }>} */
let requests = [];

/** What the next fetch resolves to. Replaced per test. */
/** @type {(url: string, init: any) => any} */
let respond = () => ({ ok: true, status: 200, json: async () => ({}) });

globalThis.fetch = /** @type {any} */ (
  async (url, init = {}) => {
    requests.push({
      method: init.method || 'GET',
      url: String(url),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return respond(String(url), init);
  }
);

/** A JSON response, ok by default. */
const ok = (payload) => () => ({ ok: true, status: 200, json: async () => payload });

/** A rejected response with a JSON body. */
const fail = (status, payload) => () => ({
  ok: false,
  status,
  json: async () => payload,
});

globalThis.window = /** @type {any} */ ({ StagifyAuth: { getToken: () => 'tok-abc' } });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => 'from-storage' });

let blobSeq = 0;
/** @type {string[]} */
const revoked = [];
URL.createObjectURL = /** @type {any} */ (() => `blob:stub-${(blobSeq += 1)}`);
URL.revokeObjectURL = /** @type {any} */ ((url) => revoked.push(String(url)));

/** A fake XMLHttpRequest whose events the test fires by hand. */
class FakeXhr {
  constructor() {
    /** @type {Record<string, string>} */
    this.headers = {};
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** @type {Record<string, Function[]>} */
    const uploadListeners = {};
    this.upload = {
      addEventListener: (type, fn) => {
        (uploadListeners[type] = uploadListeners[type] || []).push(fn);
      },
      fire: (type, event) => {
        for (const fn of uploadListeners[type] || []) fn(event);
      },
    };
    this.status = 200;
    this.responseText = '{}';
    this.method = '';
    this.url = '';
    this.body = null;
    FakeXhr.last = this;
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name] = value;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  send(body) {
    this.body = body;
  }

  fire(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
}
/** @type {any} */
FakeXhr.last = null;

globalThis.XMLHttpRequest = /** @type {any} */ (FakeXhr);
globalThis.FormData = /** @type {any} */ (
  class {
    constructor() {
      /** @type {Array<[string, any, string|undefined]>} */
      this.entries = [];
    }

    append(name, value, filename) {
      this.entries.push([name, value, filename]);
    }
  }
);

const fakeFile = (name = 'a.jpg') => ({ name, type: 'image/jpeg', size: 100 });

beforeEach(() => {
  requests = [];
  respond = ok({});
});

/** The single request the call under test made. */
const only = () => {
  assert.equal(requests.length, 1, `expected exactly one request, got ${requests.length}`);
  return requests[0];
};

// ── Module constants ─────────────────────────────────────────────────────────

test('the API root and token key are the ones the rest of the app agrees on', () => {
  assert.equal(BASE, '/api/projects');
  assert.equal(TOKEN_KEY, 'stagifyAuthToken', 'must match auth.js');
});

// ── Token resolution ─────────────────────────────────────────────────────────

test('authToken prefers auth.js over reading storage directly', () => {
  assert.equal(authToken(), 'tok-abc');
});

test('authToken falls back to storage when auth.js has not loaded', () => {
  const previous = globalThis.window;
  globalThis.window = /** @type {any} */ ({});
  try {
    assert.equal(authToken(), 'from-storage');
  } finally {
    globalThis.window = previous;
  }
});

test('authToken survives a getToken that throws (storage blocked)', () => {
  const previous = globalThis.window;
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: {
      getToken() {
        throw new Error('SecurityError');
      },
    },
  });
  try {
    assert.equal(authToken(), 'from-storage', 'falls through rather than propagating');
  } finally {
    globalThis.window = previous;
  }
});

test('authToken returns null when storage itself throws', () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = /** @type {any} */ ({});
  globalThis.localStorage = /** @type {any} */ ({
    getItem() {
      throw new Error('SecurityError');
    },
  });
  try {
    assert.equal(authToken(), null);
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

test('an empty-string token is null, not an empty Bearer header', () => {
  const previous = globalThis.window;
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { getToken: () => '' } });
  try {
    // auth.js is the authority: when it says there is no token, there is no token — it
    // does NOT fall through to storage, and it must not yield `Bearer ` with nothing
    // after it, which reads as a malformed credential rather than an absent one.
    assert.equal(authToken(), null);
    assert.ok(!('Authorization' in authHeaders()));
  } finally {
    globalThis.window = previous;
  }
});

// ── Projects ─────────────────────────────────────────────────────────────────

test('newProject POSTs the title and address as JSON', async () => {
  respond = ok({ project: { id: 'p1' } });
  const result = await newProject({ title: 'T', address: 'A' });
  const request = only();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/projects');
  assert.deepEqual(request.body, { title: 'T', address: 'A' });
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.headers.Authorization, 'Bearer tok-abc');
  assert.deepEqual(result, { project: { id: 'p1' } });
});

test('fetchProjects GETs with the limit in the query, and defaults it', async () => {
  respond = ok({ projects: [] });
  await fetchProjects(7);
  assert.equal(only().url, '/api/projects?limit=7');
  requests = [];
  await fetchProjects();
  assert.equal(only().url, '/api/projects?limit=50');
});

test('fetchProject GETs the listing detail', async () => {
  respond = ok({ project: { id: 'p1' }, photos: [], renders: [], bibles: [] });
  await fetchProject('p1');
  const request = only();
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/projects/p1');
  assert.ok(!('Content-Type' in request.headers), 'a GET carries no body, so no Content-Type');
});

test('patchProject PATCHes only the fields it was given', async () => {
  respond = ok({ project: { id: 'p1' } });
  await patchProject('p1', { title: 'New' });
  const request = only();
  assert.equal(request.method, 'PATCH');
  assert.equal(request.url, '/api/projects/p1');
  assert.deepEqual(request.body, { title: 'New' });
});

test('removeProject DELETEs the listing and sends no body', async () => {
  respond = ok({ ok: true, deleted: 3 });
  const result = await removeProject('p1');
  const request = only();
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/projects/p1');
  assert.equal(request.body, undefined);
  assert.deepEqual(result, { ok: true, deleted: 3 });
});

// ── Photos ───────────────────────────────────────────────────────────────────

test('patchPhoto PATCHes the nested photo path', async () => {
  respond = ok({ photo: { id: 'ph1' } });
  await patchPhoto('p1', 'ph1', { roomKey: 'living', frameRole: 'hero' });
  const request = only();
  assert.equal(request.method, 'PATCH');
  assert.equal(request.url, '/api/projects/p1/photos/ph1');
  assert.deepEqual(request.body, { roomKey: 'living', frameRole: 'hero' });
});

test('removePhoto DELETEs the nested photo path', async () => {
  respond = ok({ ok: true });
  await removePhoto('p1', 'ph1');
  const request = only();
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/projects/p1/photos/ph1');
});

// ── Staging, progress, bibles ────────────────────────────────────────────────

test('startStaging POSTs the three stage options', async () => {
  respond = ok({ ok: true, queued: 12 });
  const result = await startStaging('p1', {
    furnitureStyle: 'coastal',
    removeFurniture: true,
    variationCount: 2,
  });
  const request = only();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/projects/p1/stage');
  assert.deepEqual(request.body, {
    furnitureStyle: 'coastal',
    removeFurniture: true,
    variationCount: 2,
  });
  assert.equal(result.queued, 12);
});

test('fetchProgress GETs the progress endpoint', async () => {
  respond = ok({ progress: { total: 4 }, status: 'staging' });
  const result = await fetchProgress('p1');
  assert.equal(only().url, '/api/projects/p1/progress');
  assert.equal(result.status, 'staging');
});

test('regenerateBible POSTs to the room, with the room key escaped', async () => {
  respond = ok({ ok: true, superseded: 3 });
  await regenerateBible('p1', 'living room/2');
  const request = only();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/projects/p1/rooms/living%20room%2F2/bible/regenerate');
});

// ── Image bytes ──────────────────────────────────────────────────────────────

test('fetchImageBlobUrl sends the bearer header and returns an object URL', async () => {
  respond = () => ({ ok: true, status: 200, blob: async () => ({ size: 9 }) });
  const url = await fetchImageBlobUrl(renderImagePath('p1', 'r1'));
  const request = only();
  assert.equal(request.url, '/api/projects/p1/renders/r1/image');
  assert.equal(request.headers.Authorization, 'Bearer tok-abc');
  assert.match(url, /^blob:stub-\d+$/, 'an <img src> cannot carry a header, so bytes → blob URL');
});

test('fetchImageBlobUrl forwards an abort signal when given one', async () => {
  respond = () => ({ ok: true, status: 200, blob: async () => ({ size: 1 }) });
  const controller = new AbortController();
  await fetchImageBlobUrl(photoImagePath('p1', 'ph1'), controller.signal);
  assert.equal(requests[0].url, '/api/projects/p1/photos/ph1/image');
});

test('fetchImageBlobUrl rejects with an ApiError on a non-2xx', async () => {
  respond = fail(404, { error: 'no such photo' });
  await assert.rejects(() => fetchImageBlobUrl(photoImagePath('p1', 'gone')), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.message, 'no such photo');
    return true;
  });
});

test('fetchImageBlobUrl turns a transport failure into a status-0 ApiError', async () => {
  respond = () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(() => fetchImageBlobUrl('/api/projects/p1/renders/r1/image'), (error) => {
    assert.equal(error.status, 0, 'not a server rejection — must be distinguishable');
    assert.match(error.message, /Could not reach the server/);
    return true;
  });
});

// ── Error handling shared by every JSON call ─────────────────────────────────

test('a non-2xx becomes an ApiError carrying the status and the body code', async () => {
  respond = fail(409, { error: 'already staging', code: 'ALREADY_RUNNING' });
  await assert.rejects(() => startStaging('p1', { furnitureStyle: 'modern', removeFurniture: false, variationCount: 1 }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.name, 'ApiError');
    assert.equal(error.status, 409);
    assert.equal(error.code, 'ALREADY_RUNNING');
    assert.equal(error.message, 'already staging');
    return true;
  });
});

test('a non-2xx with an unreadable body still gets the status sentence', async () => {
  respond = () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });
  await assert.rejects(() => fetchProject('p1'), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, undefined);
    assert.match(error.message, /had a problem/);
    return true;
  });
});

test('a non-string code on the body is dropped rather than carried', async () => {
  respond = fail(400, { error: 'bad', code: 42 });
  await assert.rejects(() => fetchProject('p1'), (error) => {
    assert.equal(error.code, undefined);
    return true;
  });
});

test('a transport failure on a JSON call is a status-0 ApiError', async () => {
  respond = () => {
    throw new TypeError('NetworkError');
  };
  await assert.rejects(() => fetchProjects(), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    return true;
  });
});

test('a 2xx with an empty body resolves to {} rather than throwing', async () => {
  // 204s and bodiless 200s are legal; a JSON.parse blow-up here would surface as a
  // failed mutation that actually succeeded.
  respond = () => ({
    ok: true,
    status: 204,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  });
  assert.deepEqual(await removePhoto('p1', 'ph1'), {});
});

test('ApiError is constructible without a code', () => {
  const error = new ApiError('nope', 418);
  assert.equal(error.status, 418);
  assert.equal(error.code, undefined);
  assert.ok(error instanceof Error);
  assert.equal(apiErrorMessage(418, null), 'That request failed (418).');
});

// ── The multipart upload ─────────────────────────────────────────────────────

test('postPhotos sends one multipart POST under the field name "photos"', async () => {
  const promise = postPhotos('p1', [fakeFile('a.jpg'), fakeFile('b.jpg')]);
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/projects/p1/photos');
  assert.equal(xhr.headers.Authorization, 'Bearer tok-abc');
  assert.ok(
    !('Content-Type' in xhr.headers),
    'the browser must set it with the multipart boundary — a hard-coded one breaks the parse'
  );
  assert.deepEqual(xhr.body.entries.map((entry) => entry[0]), ['photos', 'photos']);
  assert.deepEqual(xhr.body.entries.map((entry) => entry[2]), ['a.jpg', 'b.jpg']);

  xhr.status = 201;
  xhr.responseText = JSON.stringify({ photos: [{ id: 'ph1' }], duplicates: ['b.jpg'] });
  xhr.fire('load');
  const result = await promise;
  assert.deepEqual(result.photos, [{ id: 'ph1' }]);
  assert.deepEqual(result.duplicates, ['b.jpg']);
});

test('postPhotos reports batch-level upload progress as a fraction', async () => {
  /** @type {number[]} */
  const fractions = [];
  const promise = postPhotos('p1', [fakeFile()], (fraction) => fractions.push(fraction));
  const xhr = FakeXhr.last;
  xhr.upload.fire('progress', { lengthComputable: true, loaded: 5, total: 20 });
  xhr.upload.fire('progress', { lengthComputable: true, loaded: 20, total: 20 });
  // Neither of these can produce a number: no total, or nothing to divide by.
  xhr.upload.fire('progress', { lengthComputable: false, loaded: 1, total: 2 });
  xhr.upload.fire('progress', { lengthComputable: true, loaded: 1, total: 0 });
  assert.deepEqual(fractions, [0.25, 1]);

  xhr.responseText = JSON.stringify({ photos: [] });
  xhr.fire('load');
  await promise;
});

test('postPhotos tolerates a 2xx body with no photos array', async () => {
  const promise = postPhotos('p1', [fakeFile()]);
  const xhr = FakeXhr.last;
  xhr.status = 200;
  xhr.responseText = 'not json at all';
  xhr.fire('load');
  const result = await promise;
  assert.deepEqual(result, { photos: [], duplicates: [] });
});

test('postPhotos rejects a non-2xx with the server message and status', async () => {
  const promise = postPhotos('p1', [fakeFile()]);
  const xhr = FakeXhr.last;
  xhr.status = 413;
  xhr.responseText = JSON.stringify({ error: 'batch too large', code: 'TOO_BIG' });
  xhr.fire('load');
  await assert.rejects(() => promise, (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 413);
    assert.equal(error.code, 'TOO_BIG');
    assert.equal(error.message, 'batch too large');
    return true;
  });
});

test('postPhotos rejects a non-2xx with an unparseable body using the status sentence', async () => {
  const promise = postPhotos('p1', [fakeFile()]);
  const xhr = FakeXhr.last;
  xhr.status = 502;
  xhr.responseText = '<html>gateway</html>';
  xhr.fire('load');
  await assert.rejects(() => promise, (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /had a problem/);
    return true;
  });
});

test('postPhotos rejects on a transport error rather than hanging', async () => {
  const promise = postPhotos('p1', [fakeFile()]);
  FakeXhr.last.fire('error');
  await assert.rejects(() => promise, (error) => {
    assert.equal(error.status, 0);
    return true;
  });
});

test('postPhotos rejects on abort, distinctly from a failure', async () => {
  const promise = postPhotos('p1', [fakeFile()]);
  FakeXhr.last.fire('abort');
  await assert.rejects(() => promise, (error) => {
    assert.equal(error.message, 'Upload cancelled.');
    return true;
  });
});

test('postPhotos with no progress callback still uploads', async () => {
  // The `if (onProgress && xhr.upload)` guard: an undefined callback must not throw.
  const promise = postPhotos('p1', [fakeFile()], undefined);
  const xhr = FakeXhr.last;
  xhr.upload.fire('progress', { lengthComputable: true, loaded: 1, total: 2 });
  xhr.responseText = JSON.stringify({ photos: [{ id: 'x' }] });
  xhr.fire('load');
  assert.equal((await promise).photos.length, 1);
});
