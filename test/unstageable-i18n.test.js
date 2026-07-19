// Drift guard between the upload gatekeeper's rejection taxonomy
// (lib/staging/unstageable.js) and the language packs (public/languages/*.json).
//
// The browser localizes a rejection by looking up `errors.unstageable.<CODE>`
// (public/scripts/unstageable-message.js). A missing key degrades to the server's
// English rather than breaking — which is exactly why it would otherwise ship
// unnoticed. Adding a 7th category without translating it is the mistake this
// catches, in the same spirit as the hreflang/sitemap drift test in i18n.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../lib/i18n/locales.js';
import { UNSTAGEABLE_CODES, GENERIC_UNSTAGEABLE_CODE } from '../lib/staging/unstageable.js';

const LANG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'languages');

// Every code the server can put on the wire: the six categories plus the generic
// fallback used when the grader's digit is unreadable.
const REQUIRED_CODES = [...Object.values(UNSTAGEABLE_CODES).map((e) => e.code), GENERIC_UNSTAGEABLE_CODE];

// English is served at the root as static files rather than through a LOCALES entry,
// so pull it in explicitly — it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];

const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));

test('every language pack translates every rejection code', () => {
  for (const lang of LANGS) {
    const block = packFor(lang).errors?.unstageable;
    assert.ok(block, `${lang}.json has no errors.unstageable block`);
    for (const code of REQUIRED_CODES) {
      const msg = block[code];
      assert.equal(typeof msg, 'string', `${lang}.json is missing errors.unstageable.${code}`);
      assert.ok(msg.trim().length > 0, `${lang}.json has an empty errors.unstageable.${code}`);
    }
  }
});

test('no language pack carries a rejection code the server can never send', () => {
  // A stale key is dead copy that translators keep maintaining for nothing, and it
  // usually means a category was renamed on the server without a pack update.
  for (const lang of LANGS) {
    for (const code of Object.keys(packFor(lang).errors.unstageable)) {
      assert.ok(REQUIRED_CODES.includes(code), `${lang}.json has stale errors.unstageable.${code}`);
    }
  }
});

test('non-English packs are actually translated, not copies of the English copy', () => {
  // Cheap smoke test for the "added the key, forgot to translate it" mistake.
  const english = packFor('english').errors.unstageable;
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    const block = packFor(lang).errors.unstageable;
    const copied = REQUIRED_CODES.filter((code) => block[code] === english[code]);
    assert.equal(copied.length, 0, `${lang}.json still has the English string for: ${copied.join(', ')}`);
  }
});
