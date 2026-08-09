// Drift guard for the "Label as virtually staged" option, which spans four places that
// each fail quietly on their own: the markup in public/index.html, the 11 language packs,
// the error copy the pipeline looks up by key, and — uniquely for this feature — the
// pre-rendered badge masters that carry the disclosure into the pixels.
//
// The one that is genuinely easy to get wrong is the MARKUP SHAPE. `data-lang` replaces an
// element's textContent wholesale, so putting the (i) icon inside the label would delete
// the icon the first time a translation is applied — and only for users who switch
// language, which is nobody on the developer's machine. index.html:1366 carries the same
// warning about the room-type badge; this asserts it instead of hoping.
//
// Same spirit as room-types-i18n.test.js and unstageable-i18n.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

// English is served statically at the root rather than via a LOCALES entry, so it is not
// in that list — but it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];
const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const STAGING_KEYS = ['labelVirtuallyStaged', 'labelVirtuallyStagedInfo', 'labelVirtuallyStagedTip'];

test('every pack carries the option label, its tooltip and its aria-label', async () => {
  for (const lang of LANGS) {
    const staging = packFor(lang)?.modal?.staging || {};
    for (const key of STAGING_KEYS) {
      const value = staging[key];
      assert.equal(typeof value, 'string', `${lang}: modal.staging.${key} is missing`);
      assert.ok(value.trim().length > 0, `${lang}: modal.staging.${key} is empty`);
    }
  }
});

test('every pack carries the fail-closed error copy', async () => {
  // The pipeline looks this one up in JS against a server code rather than resolving it
  // from markup, so a missing key silently falls back to the server's English string.
  for (const lang of LANGS) {
    const value = packFor(lang)?.errors?.disclosureStampFailed;
    assert.equal(typeof value, 'string', `${lang}: errors.disclosureStampFailed is missing`);
    assert.ok(value.trim().length > 0, `${lang}: errors.disclosureStampFailed is empty`);
  }
});

test('index.html wires the checkbox, the label and the tooltip together', async () => {
  assert.match(html, /id="label-virtually-staged"/, 'the checkbox exists');
  assert.match(html, /data-lang="modal\.staging\.labelVirtuallyStaged"/, 'the label is localized');
  assert.match(html, /data-lang="modal\.staging\.labelVirtuallyStagedTip"/, 'the tooltip is localized');
  assert.match(
    html,
    /<input[^>]*id="label-virtually-staged"[^>]*aria-describedby="label-staged-tip"/,
    'the checkbox is described by the tip node, which is how assistive tech reads it',
  );
  assert.match(html, /id="label-staged-tip"/, 'the described-by target exists');
  assert.match(
    html,
    /data-lang-attr="modal\.staging\.labelVirtuallyStagedInfo\|aria-label"/,
    'the info button localizes its aria-label via data-lang-attr, not data-lang',
  );
});

test('the (i) icon is a SIBLING of the label, never inside a data-lang element', async () => {
  // THE POINT OF THIS FILE. data-lang overwrites textContent, so an icon nested inside the
  // labelled element is deleted the moment a translation is applied.
  const label = /<label[^>]*data-lang="modal\.staging\.labelVirtuallyStaged"[^>]*>([\s\S]*?)<\/label>/.exec(html);
  assert.ok(label, 'the localized label element is still there');
  assert.ok(
    !label[1].includes('<'),
    `the label must contain plain text only — a translation would erase any markup inside it, found: ${label[1]}`,
  );

  const tip = /<span[^>]*data-lang="modal\.staging\.labelVirtuallyStagedTip"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  assert.ok(tip, 'the tooltip element is still there');
  assert.ok(!tip[1].includes('<'), 'the tooltip must contain plain text only, for the same reason');
});

test('the English fallback baked into the markup matches english.json', async () => {
  // The markup ships English inline so the page reads correctly before the language pack
  // loads. If the two drift, the label visibly changes a beat after load.
  const pack = packFor('english').modal.staging;
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();

  const label = /<label[^>]*data-lang="modal\.staging\.labelVirtuallyStaged"[^>]*>([\s\S]*?)<\/label>/.exec(html);
  assert.equal(decode(label[1]), pack.labelVirtuallyStaged, 'label fallback matches the pack');

  const tip = /<span[^>]*data-lang="modal\.staging\.labelVirtuallyStagedTip"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  assert.equal(decode(tip[1]), pack.labelVirtuallyStagedTip, 'tooltip fallback matches the pack');
});

test('the option row is NOT inside the pro-only panel', async () => {
  // The feature is available on every plan. #stagify-pro-panel is hidden wholesale for free
  // accounts (auth.js applyUserToUI), so a row nested inside it would be invisible to
  // exactly the users this is meant to protect — and nothing else would look broken.
  const panelStart = html.indexOf('id="stagify-pro-panel"');
  const rowStart = html.indexOf('id="label-staged-row"');
  const ctaStart = html.indexOf('class="process-cta"');
  assert.ok(panelStart > 0 && rowStart > 0 && ctaStart > 0, 'sanity: all three anchors exist');
  assert.ok(rowStart > panelStart, 'sanity: the row comes after the pro panel opens');

  // The pro panel's closing </div> is the one immediately before the row; if the row were
  // inside the panel, the CTA (which is definitely outside it) would be the first thing
  // after the panel's close instead.
  const between = html.slice(rowStart, ctaStart);
  assert.ok(
    !between.includes('id="stagify-pro-panel"'),
    'the row must not open inside the pro panel',
  );
  assert.ok(rowStart < ctaStart, 'the row sits above the Process photo button');
});
