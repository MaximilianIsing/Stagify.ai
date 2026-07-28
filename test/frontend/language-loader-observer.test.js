// Guard for the one re-entrancy hazard in public/scripts/language-loader.js's
// MutationObserver.
//
// The observer watches document.body for added nodes carrying [data-lang*] and
// re-runs the translation pass when it sees one. That pass writes innerHTML for every
// [data-lang-html] element — itself a childList mutation on the watched subtree. So if
// a translated value ever contains a data-lang attribute, the callback sees its own
// output as new work and re-applies forever, hanging the tab. Nothing nests one today,
// which is the only reason it has never fired.
//
// The fix is one line: drain the queue after applying. This scans for it rather than
// driving a real observer, because reaching that code path needs a DOM, a
// MutationObserver, and the module's DOMContentLoaded init — a harness far larger than
// the line it would protect. A scan cannot prove the semantics, only that the drain is
// still there, which is the regression that actually matters.
//
// NOTE: `test/frontend/language-loader.test.js` covers this module's getText contract
// with a proper DOM shim. If that shim ever grows a MutationObserver, fold this check
// in there as a behavioural test and delete this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'scripts',
  'language-loader.js',
);

test('the i18n MutationObserver drains the records its own pass queues', () => {
  const src = readFileSync(SRC, 'utf8');

  const observerAt = src.indexOf('new MutationObserver');
  assert.notEqual(observerAt, -1, 'sanity: language-loader still installs a MutationObserver');

  // The callback body: from the constructor to where the observer is switched on.
  const observeAt = src.indexOf('.observe(', observerAt);
  assert.notEqual(observeAt, -1, 'sanity: the observer is still started with .observe()');

  // Strip comments first. The fix carries a long comment that names both takeRecords()
  // and disconnect(), so scanning the raw text passes on the strength of the prose
  // alone — this guard's first version did exactly that and survived deleting the call.
  const callback = src
    .slice(observerAt, observeAt)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');

  const applyAt = callback.indexOf('applyLanguageToElements()');
  assert.notEqual(applyAt, -1, 'sanity: the callback still re-applies translations');

  // Either drain shape is fine; both stop the callback seeing its own innerHTML writes.
  const drainAt = Math.max(
    callback.indexOf('takeRecords()', applyAt),
    callback.indexOf('disconnect()', applyAt),
  );
  assert.notEqual(
    drainAt,
    -1,
    'the observer must takeRecords() (or disconnect()) after re-applying — without it, a '
      + 'translated value containing a data-lang makes the callback re-trigger itself forever',
  );
  assert.ok(drainAt > applyAt, 'the drain has to come after the pass that queues the records');
});
