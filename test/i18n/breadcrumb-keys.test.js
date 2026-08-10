// Every LOCALIZED_PAGES `crumb` key must resolve to a real string in all eleven packs.
//
// These pages carry breadcrumb structured data and no on-page trail, so the crumb names
// in the localized renders are stamped by exactly one thing: localizeBreadcrumbs() in
// render-page.js, resolving each page's `crumb` key. A key missing from a pack does not
// throw — it falls back to the name authored in the English source, so /ja/guides.html
// would publish "ホーム › Guides". Nothing about that is visible from the English page,
// which is the only one most checks look at. This file is that check.
//
// The keys are deliberately existing navigation.* / page-title keys rather than a new
// breadcrumbs.* section: the trail's label for a page and the nav's label for that same
// page are the same words, and two keys holding one string is how they drift apart. The
// last test pins the other end of that — the English name authored in the page must be
// what the key says, or switching language silently rewords the hierarchy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_LOCALES, LOCALIZED_PAGES, SITE_ORIGIN } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const pack = (lang) => JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', `${lang}.json`), 'utf8'));

/** Resolve a dot-path key, mirroring render-page.js's resolveKey. */
function resolveKey(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return null;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : null;
}

test('the scan sees every locale and page', () => {
  // A miscounted set makes every assertion below vacuous.
  assert.equal(ALL_LOCALES.length, 11, 'expected English + ten locales');
  assert.ok(LOCALIZED_PAGES.length >= 9, `expected the localized pages, found ${LOCALIZED_PAGES.length}`);
});

test('every page declares a crumb key', () => {
  const undeclared = LOCALIZED_PAGES.filter((p) => !p.crumb).map((p) => p.path);
  assert.deepEqual(
    undeclared, [],
    'a page with no crumb key keeps its authored English name in all ten localized '
      + 'renders, which is invisible when you only check the English page',
  );
});

test('every crumb key resolves to a non-empty string in all eleven packs', () => {
  const missing = [];
  for (const locale of ALL_LOCALES) {
    const translations = pack(locale.lang);
    for (const page of LOCALIZED_PAGES) {
      const value = resolveKey(translations, page.crumb);
      if (!value || !value.trim()) missing.push(`${locale.lang}: ${page.crumb} (${page.path})`);
    }
  }
  assert.deepEqual(missing, [], 'these crumb labels would fall back to English');
});

test('the English crumb label matches the name authored in the page\'s BreadcrumbList', () => {
  // English is not rewritten at request time — localizeBreadcrumbs only runs for a
  // prefixed locale — so the authored name IS the English crumb. If it disagrees with
  // what the key says, the trail changes wording the moment you switch language, which
  // reads as two different hierarchies to anyone comparing the localized URLs.
  const english = pack('english');
  const wrong = [];
  for (const page of LOCALIZED_PAGES) {
    const html = fs.readFileSync(path.join(PUBLIC, page.file), 'utf8');
    const block = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .find((d) => d && d['@type'] === 'BreadcrumbList');
    if (!block) continue; // breadcrumbs.test.js decides whether a missing trail is allowed

    const url = page.path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${page.path}`;
    const self = block.itemListElement.find((i) => i.item === url);
    if (!self) continue; // a parent-only crumb chain — nothing to compare here

    const expected = resolveKey(english, page.crumb);
    if (self.name !== expected) {
      wrong.push(`${page.file}: authored "${self.name}", ${page.crumb} says "${expected}"`);
    }
  }
  assert.deepEqual(wrong, [], 'authored English crumb names disagree with their translation key');
});
