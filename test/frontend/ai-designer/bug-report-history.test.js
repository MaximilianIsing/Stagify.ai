// The bug report posted to /api/bug-report carries the AI Designer chat transcript,
// and that endpoint sits behind the SMALL (1MB) JSON body limit — see the
// JSON_LARGE_LIMIT_PATHS comment in lib/http/app-middleware.js. The live transcript's
// image entries carry whole base64 data URLs, so posting it verbatim 413'd every
// report made after a render: the bug channel broke precisely when it was needed.
//
// public/scripts/bug-report-history.js therefore summarises the transcript before the
// POST. These tests pin the two halves of that contract:
//   1. the summary is small (the payload survives the 1MB limit), and
//   2. the summary is LOSSLESS as far as the server is concerned — the row
//      lib/http/bug-report-row.js builds from it is byte-identical to the row it
//      would have built from the raw transcript, image COUNT included.
//
// There is one report path now. The AI Designer used to carry its own hand-rolled
// form in ai-designer.html markup, with its own copy of this call; it was never given
// data-lang attributes, so it rendered English on all eleven locales. The bug button
// now opens the account menu's translated "Report an issue" dialog
// (public/scripts/profile-menu/report-issue-modal.js), which is what the SOURCE GUARD
// at the bottom of this file scans.
//
// readBugReportHistory still reads the studio transcript through the
// `window.getConversationHistory` bridge ai-designer-app.js installs — that bridge is
// the fragile part, so it is exercised directly here and in
// test/frontend/classic-script-globals.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenConversationHistory } from '../../../lib/http/bug-report-row.js';
import {
  summariseBugReportHistory as summarise,
  readBugReportHistory,
} from '../../../public/scripts/bug-report-history.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODAL_SRC = path.join(rootDir, 'public', 'scripts', 'profile-menu', 'report-issue-modal.js');

/** The 1MB express.json limit /api/bug-report runs under. */
const JSON_LIMIT_BYTES = 1024 * 1024;

/** A data URL the size the studio really produces for a rendered room. */
const dataUrl = (kb) => `data:image/png;base64,${'A'.repeat(kb * 1024)}`;

/** A transcript shaped exactly like the one chat-response.js builds. */
function rawTranscript() {
  return [
    { role: 'user', content: 'Stage this living room' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the staged room.' },
        {
          type: 'image_url',
          image_url: { url: dataUrl(400) },
          isStaged: true,
          rootBaseName: 'room',
          stagedNumber: 1,
          _annotation: 'modern, warm',
        },
        {
          type: 'image_url',
          image_url: { url: dataUrl(400) },
          isStaged: true,
          rootBaseName: 'room',
          stagedNumber: 2,
          _annotation: null,
        },
      ],
    },
    { role: 'user', content: 'Now render the CAD view' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'CAD render ready.' },
        { type: 'image_url', image_url: { url: dataUrl(600) }, isGenerated: true, _annotation: null },
      ],
    },
  ];
}

test('REGRESSION: a transcript full of base64 images summarises to a body the 1MB limit accepts', () => {
  const raw = rawTranscript();

  // Sanity: the raw transcript really is over the limit, so this test would be
  // vacuous if it were not. (~1.4MB of image bytes.)
  const rawBytes = Buffer.byteLength(JSON.stringify({ conversationHistory: raw }), 'utf8');
  assert.ok(rawBytes > JSON_LIMIT_BYTES, `raw transcript was only ${rawBytes} bytes — pick bigger images`);

  const body = JSON.stringify({
    description: 'x'.repeat(4000),
    steps: 'y'.repeat(4000),
    email: 'user@example.com',
    userId: 'u-1',
    userAgent: 'Mozilla/5.0',
    url: 'https://stagify.ai/ai-designer.html',
    timestamp: '2026-07-28T00:00:00.000Z',
    conversationHistory: summarise(raw),
  });
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes < JSON_LIMIT_BYTES, `summarised body was ${bytes} bytes, over the 1MB limit`);
  // Comfortably under, not just barely: the whole point is that transcript size is
  // now driven by text, not by how many images the user rendered.
  assert.ok(bytes < 64 * 1024, `summarised body was ${bytes} bytes — expected well under 64KB`);
  assert.ok(!body.includes('base64'), 'no image bytes may reach the wire');
  assert.ok(!body.includes('image_url":{'), 'the image_url payload must be dropped, not just shortened');
});

test('the summary records the SAME row the server would have built from the raw transcript', () => {
  const raw = rawTranscript();
  assert.equal(flattenConversationHistory(summarise(raw)), flattenConversationHistory(raw));
});

test('the recorded image count per message is unchanged', () => {
  const log = flattenConversationHistory(summarise(rawTranscript()));
  assert.ok(log.includes('[2 image(s)]'), log);
  assert.ok(log.includes('[1 image(s)]'), log);
  assert.ok(!log.includes('[3 image(s)]'), log);
});

test('the server never records image bytes, whichever shape it is handed', () => {
  // The client-side strip is an optimisation; bug-report-row.js is the guarantee.
  // It reads only an item's `type` and `text`, so a client that ignores the summary
  // (or an attacker posting by hand, within the 1MB limit) still cannot get bytes
  // into bug_reports.csv.
  for (const history of [rawTranscript(), summarise(rawTranscript())]) {
    const log = flattenConversationHistory(history);
    assert.ok(!log.includes('base64'), 'base64 payload leaked into the stored row');
    assert.ok(!log.includes('AAAA'), 'image bytes leaked into the stored row');
  }
});

test('odd transcript shapes survive the round trip identically', () => {
  const odd = [
    null,
    'not an object',
    { role: 'user' }, // no content
    { role: 'user', content: null },
    { role: 'assistant', content: { url: dataUrl(50) } }, // object content: bytes, but never stored
    { role: 'assistant', content: [null, { type: 'text' }, { noType: 1 }, { type: 'image_url' }] },
    { content: 'no role at all' },
  ];
  const summarised = summarise(odd);
  assert.equal(flattenConversationHistory(summarised), flattenConversationHistory(odd));
  // The object-shaped content is flattened to "[object Object]" server-side either
  // way, so summarising it away costs nothing and keeps its bytes off the wire.
  assert.ok(!JSON.stringify(summarised).includes('base64'));
});

test('a transcript longer than the server keeps still numbers and drops the same messages', () => {
  // The summary must NOT trim the transcript itself — the server's newest-N window
  // and its "[N earlier message(s) omitted]" prefix are what decide that.
  const long = Array.from({ length: 120 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
  assert.equal(flattenConversationHistory(summarise(long)), flattenConversationHistory(long));
  assert.ok(flattenConversationHistory(summarise(long)).startsWith('[80 earlier message(s) omitted]'));
});

test('a non-array transcript is summarised to an empty one, never thrown on', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.deepEqual(summarise(bad), []);
  }
});

test('the transcript is read through window.getConversationHistory, absent or not', () => {
  // ai-designer-app.js is a <script type="module">, so its `conversationHistory`
  // binding is invisible to anything that does not import it. The accessor is the only
  // way in, it is absent on every page but the studio, and readBugReportHistory must
  // degrade to an empty transcript rather than throw — a throw here loses the whole
  // report, which is the failure this file has been written around three times.
  const realWindow = globalThis.window;
  try {
    globalThis.window = {};
    assert.deepEqual(readBugReportHistory(), []);
    globalThis.window = { getConversationHistory: 'not a function' };
    assert.deepEqual(readBugReportHistory(), []);
    // Present: the transcript comes back summarised, not raw.
    globalThis.window = { getConversationHistory: () => rawTranscript() };
    const got = readBugReportHistory();
    assert.equal(flattenConversationHistory(got), flattenConversationHistory(rawTranscript()));
    assert.ok(!JSON.stringify(got).includes('base64'), 'image bytes must be stripped on the way out');
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
});

test('SOURCE GUARD: the bug-report POST sends the summary, not the raw transcript', () => {
  // Comments are stripped first: this file's own prose names the function, and a
  // guard that greps raw source would keep passing with the call deleted.
  const code = fs
    .readFileSync(MODAL_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  // Sanity: the thing we are scanning is really there (a renamed endpoint must fail
  // this test loudly rather than silently passing an empty scan).
  assert.ok(code.includes("fetch('/api/bug-report'"), 'the bug-report POST moved — update this guard');

  assert.match(code, /conversationHistory:\s*readBugReportHistory\(\)/);
  assert.ok(
    !/conversationHistory:\s*conversationHistory\b/.test(code),
    'the raw transcript is being posted again — this is the 413 regression'
  );
  assert.match(code, /import\s*\{\s*readBugReportHistory\s*\}\s*from\s*'\.\.\/bug-report-history\.js'/);
});

test('SOURCE GUARD: the AI Designer bug button routes to that one dialog', () => {
  // The studio's own copy of the form is gone; if the button stops delegating, the
  // bug channel silently disappears from the page it was invented for.
  const selector = fs.readFileSync(
    path.join(rootDir, 'public', 'scripts', 'ai-designer-model-selector.js'), 'utf8'
  );
  assert.match(selector, /getElementById\('bug-report-btn'\)/);
  assert.match(selector, /openReportIssue/);
  assert.ok(
    !selector.includes("fetch('/api/bug-report'"),
    'the studio posted its own report again — that path was removed because it was untranslated'
  );

  const menu = fs.readFileSync(path.join(rootDir, 'public', 'scripts', 'profile-menu.js'), 'utf8');
  assert.match(menu, /openReportIssue:\s*reportIssue\.open/);
});
