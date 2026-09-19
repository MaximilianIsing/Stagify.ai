// Drift guard between the health taxonomy (lib/health/service-health.js) and the
// language packs (public/languages/*.json).
//
// /api/status ships a stable reason CODE plus the server's canonical English, and the
// browser looks up `status.components.reason.<CODE>` before falling back to that English
// (public/scripts/status-components.js). A missing key therefore degrades silently
// instead of breaking — which is exactly why it would otherwise ship unnoticed. Adding a
// component or a reason without translating it is the mistake this catches, in the same
// spirit as test/i18n/unstageable-i18n.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';
import { HEALTH_REASONS, COMPONENT_IDS } from '../../lib/health/service-health.js';

const LANG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'languages');

// English is served at the root as static files rather than through a LOCALES entry, so
// pull it in explicitly — it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];

const STATES = ['operational', 'degraded', 'down', 'unknown'];

const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));
const componentsFor = (lang) => {
  const block = packFor(lang).status?.components;
  assert.ok(block, `${lang}.json has no status.components block`);
  return block;
};

/** @param {string} lang @param {object} block @param {string} keyPath */
function requireString(lang, value, keyPath) {
  assert.equal(typeof value, 'string', `${lang}.json is missing ${keyPath}`);
  assert.ok(value.trim().length > 0, `${lang}.json has an empty ${keyPath}`);
}

test('every language pack translates every reason code', () => {
  for (const lang of LANGS) {
    const reason = componentsFor(lang).reason || {};
    for (const code of Object.keys(HEALTH_REASONS)) {
      requireString(lang, reason[code], `status.components.reason.${code}`);
    }
  }
});

test('no language pack carries a reason code the server can never send', () => {
  // A stale key is dead copy translators keep maintaining for nothing, and it usually
  // means a code was renamed on the server without a pack update.
  for (const lang of LANGS) {
    for (const code of Object.keys(componentsFor(lang).reason || {})) {
      assert.ok(code in HEALTH_REASONS, `${lang}.json has stale status.components.reason.${code}`);
    }
  }
});

test('every component has a name and every state has a label', () => {
  for (const lang of LANGS) {
    const block = componentsFor(lang);
    for (const id of COMPONENT_IDS) {
      requireString(lang, block.name?.[id], `status.components.name.${id}`);
    }
    for (const state of STATES) {
      requireString(lang, block.state?.[state], `status.components.state.${state}`);
    }
    requireString(lang, block.heading, 'status.components.heading');
    requireString(lang, block.loading, 'status.components.loading');
    requireString(lang, block.checked, 'status.components.checked');
    // The third banner headline, beside operational/disruption.
    requireString(lang, packFor(lang).status?.degraded, 'status.degraded');
  }
});

test('the placeholder in the checked line survives translation', () => {
  // The renderer substitutes {ago}; a pack that drops it loses the timestamp entirely
  // rather than failing loudly.
  for (const lang of LANGS) {
    assert.ok(componentsFor(lang).checked.includes('{ago}'), `${lang}.json lost {ago} from status.components.checked`);
  }
});

test("no component name collides with another component's name", () => {
  // Two rows reading "Database" would be indistinguishable on the page.
  for (const lang of LANGS) {
    const names = COMPONENT_IDS.map((id) => componentsFor(lang).name[id]);
    assert.equal(new Set(names).size, names.length, `${lang}.json reuses a component name`);
  }
});

test('non-English packs are actually translated, not copies of the English copy', () => {
  // Cheap smoke test for the "added the key, forgot to translate it" mistake. A few
  // proper nouns legitimately survive translation, so this asserts on the bulk rather
  // than on every single string.
  const english = componentsFor('english').reason;
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const reason = componentsFor(lang).reason;
    const identical = Object.keys(english).filter((code) => reason[code] === english[code]);
    assert.ok(
      identical.length <= 2,
      `${lang}.json looks untranslated: ${identical.length} reason strings match English (${identical.slice(0, 5).join(', ')})`,
    );
  }
});
