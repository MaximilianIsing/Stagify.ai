// Every accessible name in the shared site-header must be localized.
//
// There is no HTML templating here (a standing decision — see
// docs/guides/architecture.md), so all nine public pages carry their own copy of the
// `<header class="site-header">` nav. A copy inherits whatever the page it was copied
// from had, and that is exactly how this drifted: `index.html` wired the account-menu
// button's aria-label to `auth.accountMenu`, and the other eight pages kept a
// hardcoded English `aria-label="Account menu"`. Every language pack has the
// translation ("Kontomenü", "アカウントメニュー", …), so the only thing standing between a
// screen-reader user on /de/contact.html and their own language was a missing
// attribute on one <button>.
//
// It fails quietly, too: an aria-label has no visible rendering, so nobody sees the
// English leaking through. Both renderers honour [data-lang-attr] — the client
// language-loader.js and the server-side render-page.js — so the attribute is the
// whole fix, and its absence is the whole bug.
//
// The rule below is deliberately broader than the one control that drifted: ANY
// aria-label inside the shared header must carry a matching [data-lang-attr]. The next
// copy-pasted nav control is then caught on the commit that adds it, not months later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_LOCALES } from '../../lib/i18n/locales.js';

const root = process.cwd();
const publicDir = path.join(root, 'public');

/** Every .html directly under public/ (the shared nav only appears on top-level pages). */
function htmlFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => path.join(dir, e.name));
}

/**
 * The `<header class="site-header">…</header>` block, with HTML comments stripped.
 *
 * Stripping matters: without it a commented-out `data-lang-attr` elsewhere in the
 * header could satisfy a naive whole-block substring search while the live element
 * still lacked it. Every check below is also scoped to a single tag for the same
 * reason — see openTags().
 *
 * @param {string} html
 * @returns {string} the header block, or '' when the page has no shared nav.
 */
function siteHeaderOf(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = withoutComments.match(/<header[^>]*\bclass="[^"]*\bsite-header\b[^"]*"[^>]*>([\s\S]*?)<\/header>/i);
  return m ? m[1] : '';
}

/** Each opening tag in a fragment, as its raw `<tag …>` string. */
function openTags(fragment) {
  return fragment.match(/<[a-zA-Z][\w-]*\b[^>]*>/g) || [];
}

const pages = htmlFiles(publicDir).filter((f) => siteHeaderOf(fs.readFileSync(f, 'utf8')));

test('the shared-nav page set is discovered (guard against an empty sweep)', () => {
  // Without this, a regex that stopped matching would make every assertion below pass
  // vacuously over an empty list.
  assert.ok(pages.length >= 9, `expected the pages carrying <header class="site-header">, found ${pages.length}`);
});

test('every aria-label in the shared site-header is wired to a translation key', () => {
  const offenders = [];
  for (const file of pages) {
    const header = siteHeaderOf(fs.readFileSync(file, 'utf8'));
    for (const tag of openTags(header)) {
      if (!/\baria-label="/.test(tag)) continue;
      // Scoped to THIS tag: the key must be on the same element as the aria-label.
      if (/\bdata-lang-attr="[^"]+\|aria-label"/.test(tag)) continue;
      const label = (tag.match(/aria-label="([^"]*)"/) || [])[1];
      offenders.push(`${path.relative(root, file)}: aria-label="${label}" has no data-lang-attr`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These accessible names stay English in all 10 non-English locales — an aria-label ' +
      'renders nowhere, so the leak is invisible. Add data-lang-attr="<key>|aria-label" to ' +
      'the same element (see the button in public/index.html) and add <key> to every pack:\n' +
      offenders.join('\n'),
  );
});

/** Every `key` referenced as `data-lang-attr="key|aria-label"` anywhere in a shared header. */
const referencedKeys = [
  ...new Set(
    pages.flatMap((file) =>
      openTags(siteHeaderOf(fs.readFileSync(file, 'utf8')))
        .map((tag) => (tag.match(/\bdata-lang-attr="([^"|]+)\|aria-label"/) || [])[1])
        .filter(Boolean),
    ),
  ),
];

test('the sweep actually found localized aria-labels (the checks are not vacuous)', () => {
  assert.ok(
    referencedKeys.length >= 1,
    'no data-lang-attr="…|aria-label" found in any shared header — either the nav lost its ' +
      'localized controls, or the scan above stopped matching and is now checking nothing',
  );
});

test('every aria-label key referenced by the shared nav resolves in every language pack', () => {
  // A key that is missing from a pack does not throw: both renderers fall back to the
  // hardcoded English aria-label, which is precisely the bug this file exists to stop —
  // it would just come back one pack at a time instead of one page at a time.
  const missing = [];
  for (const locale of ALL_LOCALES) {
    const packPath = path.join(publicDir, 'languages', `${locale.lang}.json`);
    assert.ok(fs.existsSync(packPath), `language pack missing entirely: ${locale.lang}.json`);
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    for (const key of referencedKeys) {
      const value = key.split('.').reduce((cur, part) => (cur && typeof cur === 'object' ? cur[part] : undefined), pack);
      if (typeof value !== 'string' || !value.trim()) missing.push(`${locale.lang}.json: ${key}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'These packs lack a key the shared nav points at, so those locales silently fall back ' +
      'to English:\n' + missing.join('\n'),
  );
});
