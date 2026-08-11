// Tier: frontend island logic — public/scripts/exterior-studio/enhance.js.
//
// One request, one answer. The error mapping is the part with teeth: the upload gate's
// 422 carries a stable CATEGORY code that the shared localizer turns into a sentence in
// the visitor's language, and collapsing that into a generic "something went wrong"
// throws away the only message that tells them what to do differently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceExterior, EnhanceError, ENHANCE_TIMEOUT_MS, BADGE_FIELDS } from '../../../public/scripts/exterior-studio/enhance.js';
import { pageHtml } from '../../helpers/exterior-studio-dom.js';

// A browser always has a `window`; the shared unstageable localizer reads it directly.
// Standing one up for the whole file keeps every case in a realistic environment rather
// than proving something about a runtime that does not exist.
globalThis.window = /** @type {any} */ ({});

const file = () => new File([new Uint8Array([1, 2, 3])], 'house.jpg', { type: 'image/jpeg' });

const OPTIONS = {
  timeOfDay: 'goldenHour',
  sky: 'clearBlue',
  removeVehicles: true,
  removeClutter: false,
  additionalPrompt: 'keep the flag',
};

/** A fetch double that records its call and answers with the given status/body. */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { impl, calls };
}

const run = (fetchImpl, extra = {}) =>
  enhanceExterior({ file: file(), options: OPTIONS, token: 'tok', fetchImpl, ...extra });

// ---- the request ------------------------------------------------------------

test('posts multipart to /api/enhance-exterior with the bearer token', async () => {
  const f = fakeFetch(200, { success: true, image: 'data:image/webp;base64,OK' });
  const body = await run(f.impl);

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/enhance-exterior');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(body.image, 'data:image/webp;base64,OK');
});

test('every option reaches the wire, with booleans EXPLICIT in both directions', async () => {
  // Multipart has no booleans. Omitting a field when it is off would make "off" and
  // "the client is older than this field" the same message on the server.
  const f = fakeFetch(200, { image: 'x' });
  await run(f.impl);
  const form = f.calls[0].init.body;

  assert.equal(form.get('timeOfDay'), 'goldenHour');
  assert.equal(form.get('sky'), 'clearBlue');
  assert.equal(form.get('removeVehicles'), 'true');
  assert.equal(form.get('removeClutter'), 'false', 'an unchecked toggle says so, it does not go missing');
  assert.equal(form.get('additionalPrompt'), 'keep the flag');
  assert.ok(form.get('image'), 'the photo itself');
});

test('DRIFT GUARD: every removal row on the real page is actually POSTED', async () => {
  // The last link in the chain, and the one with no other guard on it. A removal row can
  // have its clause, its checkbox, its eleven translations and its reader in controls.js —
  // every one of those pinned by a test — and still never leave the browser, because this
  // module lists the fields it appends by hand. The request succeeds, the render is billed,
  // and the snow is still there.
  //
  // Read off the shipped markup for the same reason controls.test.js does: the failure is
  // a row added to the page and forgotten here, so the page has to be what is asked.
  const rows = [...pageHtml().matchAll(/<input type="checkbox"([^>]*)>/g)]
    .map((m) => /\sname="([^"]+)"/.exec(m[1])?.[1])
    .filter((name) => !!name);
  assert.ok(rows.length >= 5, `expected the page's removal rows, found ${rows.length}`);

  const f = fakeFetch(200, { image: 'x' });
  // Every removal on, so a field that is posted but hard-coded to 'false' fails too.
  const options = { ...OPTIONS, ...Object.fromEntries(rows.map((name) => [name, true])) };
  await enhanceExterior({ file: file(), options, token: 'tok', fetchImpl: f.impl });
  const form = f.calls[0].init.body;

  for (const name of rows) {
    assert.equal(form.get(name), 'true', `the page ships a "${name}" row that never reaches the server`);
  }

  // And nothing extra: a retired row still being posted would keep working server-side
  // long after the control that asked for it was taken off the page.
  // BADGE_FIELDS are excluded rather than expected: they ride the same request but they are
  // not removal rows, and the page's disclosure checkbox deliberately carries no `name` so
  // that the scrape above cannot mistake it for one. It describes the delivered FILE, while
  // every row this guard covers describes an edit to the property.
  const notRemovals = ['image', 'timeOfDay', 'sky', 'additionalPrompt', ...BADGE_FIELDS];
  const posted = [...form.keys()].filter((k) => !notRemovals.includes(k));
  assert.deepEqual(posted.sort(), [...rows].sort(), 'the wire and the markup must agree exactly');
});

// ---- the disclosure badge ---------------------------------------------------

test('the badge fields ride the same request, as strings multipart can carry', async () => {
  const f = fakeFetch(200, { image: 'x' });
  await run(f.impl, {
    badge: { labelVirtuallyStaged: true, stampLang: 'german', stampStyle: 'banner', stampScale: 1.3 },
  });
  const form = f.calls[0].init.body;

  // FormData has no booleans and no numbers; the server's readStampRequest is built for
  // exactly these strings, which is why the flag is coerced here and not there.
  assert.equal(form.get('labelVirtuallyStaged'), 'true');
  assert.equal(form.get('stampLang'), 'german');
  assert.equal(form.get('stampStyle'), 'banner');
  assert.equal(form.get('stampScale'), '1.3');
});

test('an untouched checkbox says so explicitly rather than going missing', async () => {
  const f = fakeFetch(200, { image: 'x' });
  await run(f.impl, {
    badge: { labelVirtuallyStaged: false, stampLang: 'english', stampStyle: 'dark', stampScale: 1 },
  });
  assert.equal(f.calls[0].init.body.get('labelVirtuallyStaged'), 'false');
});

test('a caller that never wired the control posts NO badge fields at all', async () => {
  // Not the same as posting "off". A page with no disclosure control has not made a
  // statement about the badge, and inventing one here would put this island in the business
  // of answering for markup it cannot see.
  const f = fakeFetch(200, { image: 'x' });
  await run(f.impl);
  const posted = [...f.calls[0].init.body.keys()];
  for (const name of BADGE_FIELDS) {
    assert.ok(!posted.includes(name), `${name} was posted by a page that has no such control`);
  }
});

test('DRIFT GUARD: the page ships every control BADGE_FIELDS claims to send', () => {
  // The mirror of the removal-row guard above, for the other half of this request. A field
  // listed here but missing from the page is a value invented by the island; a control on
  // the page with no field is a setting the user picks and the server never hears about —
  // and the badge's failure mode is the quiet one, a photo that looks right and is not
  // labelled.
  const html = pageHtml();
  assert.ok(html.includes('id="ex-label-virtually-staged"'), 'the checkbox behind labelVirtuallyStaged');
  assert.ok(html.includes('id="ex-stamp-scale"'), 'the slider behind stampScale');
  assert.match(html, /name="ex-stamp-style"/, 'the swatches behind stampStyle');
  // stampLang has no control: it follows the SITE language, read from localStorage by the
  // shared option. Named here so the absence is a decision rather than an oversight.
  assert.deepEqual(
    BADGE_FIELDS, ['labelVirtuallyStaged', 'stampLang', 'stampStyle', 'stampScale'],
    'a new badge field needs a control on the page and a reader on the server',
  );
});

test('the disclosure checkbox is NOT one of the removal rows', () => {
  // It must stay nameless in the markup. Give it a `name` and the two drift guards above
  // start demanding that read() report it as a removal flag and that the prompt table carry
  // a clause for it — none of which exist, because it never goes near the model.
  const box = /<input type="checkbox"[^>]*id="ex-label-virtually-staged"[^>]*>/.exec(pageHtml());
  assert.ok(box, 'the disclosure checkbox must still be a plain checkbox in the markup');
  assert.ok(!/\sname="/.test(box[0]), 'the disclosure checkbox must not carry a name attribute');
});

test('a signed-out caller sends no Authorization header rather than "Bearer null"', async () => {
  const f = fakeFetch(401, { error: 'Sign in required', code: 'AUTH_REQUIRED' });
  await assert.rejects(() => enhanceExterior({ file: file(), options: OPTIONS, token: null, fetchImpl: f.impl }));
  assert.deepEqual(f.calls[0].init.headers, {});
});

test('the timeout allows for the full quality-retry budget', async () => {
  // A render can run the model up to three times. Killing the request early abandons
  // work the account has already been billed for.
  assert.equal(ENHANCE_TIMEOUT_MS, 180000);
});

// ---- error mapping ----------------------------------------------------------

test('a 422 from the upload gate keeps its category message and code', async () => {
  const f = fakeFetch(422, { code: 'ANIMAL', reason: 'This looks like a photo of a pet.' });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.ok(err instanceof EnhanceError);
    assert.equal(err.code, 'ANIMAL');
    assert.match(err.message, /pet/, 'the category sentence survives, not a generic failure');
    return true;
  });
});

test('a 422 rejection is localized through the shared helper when a pack has the key', async () => {
  // unstageableMessage() reads errors.unstageable.<CODE> and falls back to the server's
  // English. Sharing that helper is what stops this page's copy from drifting from the
  // two studios'.
  const prev = globalThis.window.LanguageSystem;
  globalThis.window.LanguageSystem = {
    getText: (key, fb) => (key === 'errors.unstageable.FOOD' ? 'Das ist Essen.' : fb),
  };
  const f = fakeFetch(422, { code: 'FOOD', reason: 'This looks like a photo of food.' });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.equal(err.message, 'Das ist Essen.');
    return true;
  });
  globalThis.window.LanguageSystem = prev;
});

test('a localizer that throws still yields a usable sentence, not a stack fragment', async () => {
  // A half-loaded or malformed pack is a real browser state. The caller prints
  // err.message straight into a toast, so an escaping exception is user-visible.
  const prev = globalThis.window.LanguageSystem;
  globalThis.window.LanguageSystem = { getText: () => { throw new Error('pack is not an object'); } };
  const f = fakeFetch(422, { code: 'ANIMAL', reason: 'This looks like a photo of a pet.' });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.ok(err instanceof EnhanceError);
    assert.equal(err.message, 'This looks like a photo of a pet.', 'falls back to the server English');
    return true;
  });
  globalThis.window.LanguageSystem = prev;
});

test('a 422 NO_IMAGE_GENERATED is NOT treated as an upload rejection', async () => {
  // Same status, opposite meaning: the photo was fine, the model came back empty. Running
  // it through the unstageable localizer would tell the visitor their photo is not a
  // building, which is both wrong and unactionable.
  const f = fakeFetch(422, { code: 'NO_IMAGE_GENERATED', error: 'This photo couldn\'t be enhanced.' });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.equal(err.code, 'NO_IMAGE_GENERATED');
    assert.match(err.message, /couldn't be enhanced/);
    return true;
  });
});

test('a 403 surfaces the server\'s own message', async () => {
  const f = fakeFetch(403, { error: 'Stagify+ subscription required', code: 'PRO_REQUIRED' });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.equal(err.code, 'PRO_REQUIRED');
    assert.match(err.message, /Stagify\+/);
    return true;
  });
});

test('a 500 with no body still produces a sentence, not "undefined"', async () => {
  const f = fakeFetch(500, null);
  await assert.rejects(() => run(f.impl), (err) => {
    assert.equal(err.code, '500');
    assert.match(err.message, /could not be enhanced/);
    return true;
  });
});

test('a 200 with no image is an error, not a silent success', async () => {
  const f = fakeFetch(200, { success: true });
  await assert.rejects(() => run(f.impl), (err) => {
    assert.equal(err.code, 'NO_IMAGE');
    return true;
  });
});

test('a dropped connection says the upload is still there', async () => {
  // The one error where the useful information is what did NOT happen: their photo is
  // still on screen, so "try again" is one click, not a re-upload.
  const impl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => run(impl), (err) => {
    assert.equal(err.code, 'NETWORK');
    assert.match(err.message, /still here/);
    return true;
  });
});

test('the timeout aborts and reports as a network failure', async () => {
  const impl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  await assert.rejects(() => run(impl, { timeoutMs: 5 }), (err) => {
    assert.equal(err.code, 'NETWORK');
    return true;
  });
});

test('every error path yields an EnhanceError, so the caller never shows a raw exception', async () => {
  // showErrorToast prints err.message. A stray TypeError would put "Failed to fetch" —
  // or worse, a stack fragment — in front of a customer.
  const cases = [
    fakeFetch(500, null).impl,
    fakeFetch(422, { code: 'ANIMAL', reason: 'This looks like a photo of a pet.' }).impl,
    fakeFetch(200, {}).impl,
    async () => { throw new Error('boom'); },
  ];
  for (const impl of cases) {
    await assert.rejects(() => run(impl), (err) => {
      assert.ok(err instanceof EnhanceError, `expected EnhanceError, got ${err?.name}`);
      assert.ok(err.message.trim().length > 10, 'and a real sentence');
      return true;
    });
  }
});
