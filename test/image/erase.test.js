// Two-stage furniture removal (lib/image/erase.js): the Gemini erase pass plus the
// GPT-vision pre-check (roomIsAlreadyEmpty), post-check (verifyRoomEmptied), and the
// retry loop in eraseFurniture. The checks fail OPEN (a flaky reviewer never blocks the
// erase) and the loop keeps the best buffer across attempts. Fake genAI/openai clients
// return scripted output over REAL sharp PNG buffers — no network, no cost — so the
// sharp metadata/aspect-ratio work on the hot path runs for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createErase } from '../../lib/image/erase.js';

// A real solid-colour PNG and its base64 (the shape Gemini returns in inlineData.data).
const pngBuffer = (w = 256, h = 192, rgb = { r: 180, g: 170, b: 150 }) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();

// Fake Gemini: `responses[i]` is used for attempt i — a base64 PNG string to return, or
// an Error to throw. `state.calls` counts generateContent invocations.
function fakeGenAI(responses) {
  const state = { calls: 0 };
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async () => {
        const r = responses[Math.min(state.calls, responses.length - 1)];
        state.calls += 1;
        if (r instanceof Error) throw r;
        return { response: { candidates: [{ content: { parts: [{ inlineData: { data: r } }] } }] } };
      },
    }),
  };
  return { genAI, state };
}

// Fake OpenAI: returns the next scripted content per call (queue drains, last value
// sticks); an Error entry throws to exercise the fail-open branches.
function fakeOpenAI(contents) {
  const queue = Array.isArray(contents) ? [...contents] : [contents];
  return {
    chat: {
      completions: {
        create: async () => {
          const c = queue.length > 1 ? queue.shift() : queue[0];
          if (c instanceof Error) throw c;
          return { choices: [{ message: { content: c } }] };
        },
      },
    },
  };
}

// --- buildKeepExceptionText (pure) ------------------------------------------
test('buildKeepExceptionText: blank/whitespace → empty; otherwise embeds the trimmed items', () => {
  const { buildKeepExceptionText } = createErase({});
  assert.equal(buildKeepExceptionText(''), '');
  assert.equal(buildKeepExceptionText('   '), '');
  assert.equal(buildKeepExceptionText(undefined), '');
  const txt = buildKeepExceptionText('  the paintings  ');
  assert.match(txt, /keep ONLY these specific items/);
  assert.match(txt, /the paintings\./, 'the trimmed instruction is inlined');
});

// --- roomIsAlreadyEmpty -----------------------------------------------------
test('roomIsAlreadyEmpty: no client → false; "EMPTY: true" → true; "EMPTY: false" → false; error → false', async () => {
  const buf = await pngBuffer();
  assert.equal(await createErase({ openai: null }).roomIsAlreadyEmpty(buf), false, 'disabled → not treated as empty');
  assert.equal(await createErase({ openai: fakeOpenAI('EMPTY: true') }).roomIsAlreadyEmpty(buf), true);
  assert.equal(await createErase({ openai: fakeOpenAI('EMPTY: false') }).roomIsAlreadyEmpty(buf), false);
  assert.equal(await createErase({ openai: fakeOpenAI(new Error('x')) }).roomIsAlreadyEmpty(buf), false, 'error → proceed with erase');
});

// --- verifyRoomEmptied ------------------------------------------------------
const CLEAN_INTACT = { empty: true, remaining: '', intact: true, damage: '' };

test('verifyRoomEmptied: no client → empty; CLEAN true → empty; CLEAN false lists leftovers; error fails open to empty', async () => {
  const buf = await pngBuffer();
  assert.deepEqual(await createErase({ openai: null }).verifyRoomEmptied(buf), CLEAN_INTACT);
  assert.deepEqual(await createErase({ openai: fakeOpenAI('CLEAN: true') }).verifyRoomEmptied(buf), CLEAN_INTACT);

  const dirty = await createErase({ openai: fakeOpenAI('CLEAN: false | sofa, area rug') }).verifyRoomEmptied(buf);
  assert.equal(dirty.empty, false);
  assert.equal(dirty.remaining, 'sofa, area rug', 'the leftover list after the pipe is captured');

  // Fail OPEN: a thrown reviewer accepts the current erase rather than looping forever.
  assert.deepEqual(await createErase({ openai: fakeOpenAI(new Error('down')) }).verifyRoomEmptied(buf), CLEAN_INTACT);
});

// The architecture half of the verdict. It only exists when a SOURCE is supplied, because
// "did the erase destroy the room" is a comparison and there is nothing to compare against
// otherwise. This check used to be impossible: the prompt told the reviewer to ignore the
// walls, floor, ceiling, windows, doors and trim, so the only failure it could ever report
// was under-removal, and the retry ladder above it only ever pushed harder.
test('verifyRoomEmptied: with a source, "ROOM: damaged" is reported separately from leftovers', async () => {
  const buf = await pngBuffer();
  const src = await pngBuffer();

  const wrecked = await createErase({ openai: fakeOpenAI('CLEAN: true\nROOM: damaged | the left window was filled in') })
    .verifyRoomEmptied(buf, '', src);
  assert.equal(wrecked.empty, true, 'it did empty the room…');
  assert.equal(wrecked.intact, false, '…but it destroyed it doing so');
  assert.equal(wrecked.damage, 'the left window was filled in');
  assert.equal(wrecked.remaining, '', 'the damage list never leaks into the leftover list');

  const good = await createErase({ openai: fakeOpenAI('CLEAN: true\nROOM: intact') })
    .verifyRoomEmptied(buf, '', src);
  assert.deepEqual(good, CLEAN_INTACT);
});

test('verifyRoomEmptied: both verdicts can fail at once, and each keeps its own detail list', async () => {
  const buf = await pngBuffer();
  const both = await createErase({ openai: fakeOpenAI('CLEAN: false | cabinet, rug\nROOM: damaged | the fireplace is gone') })
    .verifyRoomEmptied(buf, '', await pngBuffer());
  assert.equal(both.empty, false);
  assert.equal(both.remaining, 'cabinet, rug');
  assert.equal(both.intact, false);
  assert.equal(both.damage, 'the fireplace is gone');
});

test('verifyRoomEmptied: an unparseable or missing ROOM line fails OPEN as intact', async () => {
  const buf = await pngBuffer();
  // A truncated reply must not condemn a good erase — same fail-open contract as the rest
  // of this module. The cost of a false "damaged" is a wasted regeneration; the cost of
  // refusing to fail open is a user's erase thrown away over a flaky reviewer.
  const truncated = await createErase({ openai: fakeOpenAI('CLEAN: true') })
    .verifyRoomEmptied(buf, '', await pngBuffer());
  assert.equal(truncated.intact, true);
  assert.equal(truncated.damage, '');
});

// --- eraseFurniture ---------------------------------------------------------
test('eraseFurniture: no genAI client → null (caller falls back to single-pass staging)', async () => {
  const { eraseFurniture } = createErase({ genAI: null, openai: null });
  assert.equal(await eraseFurniture(await pngBuffer(), null), null);
});

test('eraseFurniture: verified clean on the first attempt returns a PNG data URL + buffer, one generation call', async () => {
  const input = await pngBuffer();
  const outB64 = (await pngBuffer(256, 192, { r: 240, g: 240, b: 240 })).toString('base64');
  const { genAI, state } = fakeGenAI([outB64]);
  const { eraseFurniture } = createErase({ genAI, openai: fakeOpenAI('CLEAN: true') });

  const result = await eraseFurniture(input, null);
  assert.ok(result, 'a successful erase returns a result');
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(state.calls, 1, 'clean on attempt 1 → no retry generation');
});

test('eraseFurniture: leftovers on attempt 1 trigger a second attempt that verifies clean', async () => {
  const input = await pngBuffer();
  const b64 = (await pngBuffer()).toString('base64');
  const { genAI, state } = fakeGenAI([b64, b64]); // both attempts produce a decodable image
  // First verify says items remain; second says clean.
  const { eraseFurniture } = createErase({ genAI, openai: fakeOpenAI(['CLEAN: false | cabinet', 'CLEAN: true']) });

  const result = await eraseFurniture(input, null);
  assert.ok(result);
  assert.equal(state.calls, 2, 'a failed verify drove exactly one retry');
});

// The loop used to assign `bestBuffer = outBuffer` unconditionally on every pass, so the
// LAST attempt always won — and it skipped verification on the final attempt entirely. An
// attempt that emptied the room by bricking up a window therefore shipped unexamined, beat
// a perfectly good earlier attempt, and was then handed to a second full generative pass
// that baked the damage in. An intact room now outranks an empty one.
test('eraseFurniture: an intact-but-imperfect attempt beats a later one that wrecked the room', async () => {
  const input = await pngBuffer();
  const keep = (await pngBuffer(256, 192, { r: 10, g: 20, b: 30 })).toString('base64');   // attempt 1
  const wreck = (await pngBuffer(256, 192, { r: 200, g: 210, b: 220 })).toString('base64'); // attempts 2-3
  const { genAI, state } = fakeGenAI([keep, wreck, wreck]);
  const { eraseFurniture } = createErase({
    genAI,
    openai: fakeOpenAI([
      'CLEAN: false | one chair\nROOM: intact',                    // attempt 1: a bit dirty, room fine
      'CLEAN: true\nROOM: damaged | the window is now solid wall', // attempt 2: spotless, room destroyed
      'CLEAN: true\nROOM: damaged | the window is now solid wall', // attempt 3: same
    ]),
  });

  const result = await eraseFurniture(input, null);
  assert.ok(result);
  assert.equal(state.calls, 3, 'it kept trying for a clean AND intact result');
  const { r } = await sharp(result.buffer).stats().then((s) => ({ r: Math.round(s.channels[0].mean) }));
  assert.ok(r < 100, `attempt 1 (the intact one) was returned, not the wrecked later attempts (got mean red ${r})`);
});

test('eraseFurniture: a damaged room retries CONSERVATIVELY instead of escalating removal', async () => {
  // The old retry note only ever said "you MUST now remove completely: …". Repeating that
  // at a model already removing too much is what walked a room from "one chair left" to
  // "no window". Over-removal now pulls the next attempt back instead of pushing it on.
  const input = await pngBuffer();
  const b64 = (await pngBuffer()).toString('base64');
  const prompts = [];
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async (parts) => {
        prompts.push(parts[0].text);
        return { response: { candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }] } };
      },
    }),
  };
  const { eraseFurniture } = createErase({
    genAI,
    openai: fakeOpenAI(['CLEAN: true\nROOM: damaged | the fireplace is gone', 'CLEAN: true\nROOM: intact']),
  });

  await eraseFurniture(input, null);
  assert.ok(prompts.length >= 2, 'damage drove a retry');
  assert.match(prompts[1], /went TOO FAR/, 'the retry note pulls back');
  assert.match(prompts[1], /the fireplace is gone/, 'and names what was destroyed');
  assert.ok(!/MUST now remove completely/.test(prompts[1]), 'it does NOT also escalate removal');
});

test('eraseFurniture: every generation attempt throwing → null after exhausting retries', async () => {
  const input = await pngBuffer();
  const { genAI, state } = fakeGenAI([new Error('gen fail'), new Error('gen fail'), new Error('gen fail')]);
  const { eraseFurniture } = createErase({ genAI, openai: null });

  assert.equal(await eraseFurniture(input, null), null);
  assert.equal(state.calls, 3, 'all three attempts were tried before giving up');
});
