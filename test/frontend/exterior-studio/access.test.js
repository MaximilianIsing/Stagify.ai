// Tier: frontend island logic — public/scripts/exterior-studio/access.js.
//
// This page invented the public-preview pattern and, for a while, was the only one still
// running its own copy of it. It is now a four-line binding of scripts/preview-access.js
// like the other three, so everything that is TRUE OF EVERY PREVIEW PAGE moved to
// test/frontend/preview-access.test.js, which runs it against all four:
//
//   the tri-state predicate · the idempotent, reversible writer · the shipped markup being
//   the anonymous view · the ids the module binds really existing · the in-flight window
//   and the handover from the pre-paint guess · the pre-paint CSS being `display` and
//   carrying an id.
//
// Duplicating any of that here would be four chances to fix a bug in one of them, which is
// the reason the module was shared in the first place.
//
// WHAT IS LEFT IS EXTERIOR-ONLY, and both of these are about markup that no writer touches,
// so no amount of testing the writer would catch them:
//
//   • NO OVERLAY, EVER — a signed-in free account used to get a full-screen, undismissable
//     "your account is on the free plan" dialog the moment this page loaded, which for a
//     brand-new account was the first thing the product ever said to them. It is gone, and
//     the page must not grow another one. Asserted on the SOURCE, because re-adding the
//     overlay starts with re-adding the div and the styles — a writer-only check would stay
//     green right up until someone wired it back up.
//   • THE CTA IS A STATIC SALES LINK, not a control JS repoints. It used to change job
//     between views ("get Stagify+" for a visitor, "jump to the uploader" for a subscriber),
//     and a control with two meanings is one more thing that has to stay true through every
//     language switch.
//
// The pitch's own structure is test/frontend/exterior-studio/pitch.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageHtml } from '../../helpers/exterior-studio-dom.js';

// ---- the upgrade overlay stays deleted -------------------------------------

test('there is NO upgrade overlay on this page — not in the markup, not in the stylesheet', () => {
  // The dialog this replaces was full-screen, had no close button, and fired for any
  // signed-in free account the moment the page loaded. The hero's "Get Stagify+ to use it"
  // button makes the same ask without taking the page away.
  const html = pageHtml();
  assert.ok(!/id="ex-pro-gate"/.test(html), 'the gate dialog is back in exterior-studio.html');
  assert.ok(!/\bex-gate\b/.test(html), 'gate markup is back in exterior-studio.html');
  assert.ok(
    !/exteriorStudio\.gate\./.test(html),
    'the gate copy is back — its keys were deleted from all eleven packs, so it would render as raw English',
  );

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const css = fs.readFileSync(path.join(root, 'public', 'styles', 'exterior-studio.css'), 'utf8');
  // Comments carry the words "gate" and "dialog" on purpose (they explain the removal), so
  // strip them first — otherwise the note left behind for the next reader is what keeps this
  // assertion passing, and it would keep passing with the rules restored underneath.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.ex-gate/.test(rules), '.ex-gate styles are back in exterior-studio.css');
});

// ---- the hero call to action -----------------------------------------------

test('the hero call to action is a STATIC sales link, not a control JS repoints', () => {
  const html = pageHtml();
  const cta = /<a[^>]*id="ex-cta"([^>]*)>/.exec(html);
  assert.ok(cta, 'the CTA is missing');
  assert.match(cta[1], /href="stagify-plus\.html"/, 'it only ever points at the plan');
});

test('the CTA label carries its own data-lang key', () => {
  // Repainting the label from JS without moving the key means the next language switch
  // re-renders the OLD label — the trap custom-select.js shipped with. The label is markup,
  // so the key travels with it.
  const html = pageHtml();
  const cta = /<a[^>]*id="ex-cta"[^>]*>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(cta, 'the CTA is missing');
  assert.match(
    cta[1],
    /data-lang="exteriorStudio\.ctaUpgrade"/,
    'the CTA label must resolve from the language pack, not from a string in JS',
  );
});
