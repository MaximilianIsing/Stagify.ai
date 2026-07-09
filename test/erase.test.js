// Two-stage furniture removal (lib/image/erase.js): the Gemini erase pass plus the
// GPT-vision pre-check (roomIsAlreadyEmpty), post-check (verifyRoomEmptied), and the
// retry loop in eraseFurniture. The checks fail OPEN (a flaky reviewer never blocks the
// erase) and the loop keeps the best buffer across attempts. Fake genAI/openai clients
// return scripted output over REAL sharp PNG buffers — no network, no cost — so the
// sharp metadata/aspect-ratio work on the hot path runs for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createErase } from '../lib/image/erase.js';

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
test('verifyRoomEmptied: no client → empty; CLEAN true → empty; CLEAN false lists leftovers; error fails open to empty', async () => {
  const buf = await pngBuffer();
  assert.deepEqual(await createErase({ openai: null }).verifyRoomEmptied(buf), { empty: true, remaining: '' });
  assert.deepEqual(await createErase({ openai: fakeOpenAI('CLEAN: true') }).verifyRoomEmptied(buf), { empty: true, remaining: '' });

  const dirty = await createErase({ openai: fakeOpenAI('CLEAN: false | sofa, area rug') }).verifyRoomEmptied(buf);
  assert.equal(dirty.empty, false);
  assert.equal(dirty.remaining, 'sofa, area rug', 'the leftover list after the pipe is captured');

  // Fail OPEN: a thrown reviewer accepts the current erase rather than looping forever.
  assert.deepEqual(await createErase({ openai: fakeOpenAI(new Error('down')) }).verifyRoomEmptied(buf), { empty: true, remaining: '' });
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

test('eraseFurniture: every generation attempt throwing → null after exhausting retries', async () => {
  const input = await pngBuffer();
  const { genAI, state } = fakeGenAI([new Error('gen fail'), new Error('gen fail'), new Error('gen fail')]);
  const { eraseFurniture } = createErase({ genAI, openai: null });

  assert.equal(await eraseFurniture(input, null), null);
  assert.equal(state.calls, 3, 'all three attempts were tried before giving up');
});
