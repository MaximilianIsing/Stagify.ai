// Tier: drift guard — where the JSON-LD "keywords" property gets its translation key.
//
// Two things are pinned here, and they are pinned together because one used to BE the
// other:
//
//   1. No page carries <meta name="keywords">. Google has ignored the tag for ranking
//      since 2009 and Bing reads it as a spam signal, so the six that existed were
//      deleted. This sweep is what stops one being pasted back in.
//   2. The schema.org JSON-LD "keywords" property — a different, legitimate thing that
//      was deliberately KEPT — names its own translation key via data-lang-keywords on
//      the ld+json tag.
//
// #2 exists because of how #1 nearly went wrong. Both renderers used to find the
// keywords key by scraping the meta tag: lib/i18n/render-page.js regex-matched it and
// fell back to 'meta.keywords', and public/scripts/language-loader.js hardcoded
// 'meta.keywords' outright. Deleting the tag would therefore not have removed the
// localized keywords from the three studio pages — it would have silently swapped in
// the HOMEPAGE's keyword list, on pages describing entirely different tools. Nothing
// would have failed: applyStructuredData had no test coverage at all, which is the
// other reason this file exists.
//
// The failure modes each assertion below catches:
//   • a meta keywords tag creeping back on a new page (nobody would notice; it renders
//     nothing and breaks nothing — it is purely a credibility smell);
//   • a JSON-LD block with a "keywords" property but no data-lang-keywords — it would
//     stay English in all eleven locales, quietly, since the renderer just skips it;
//   • an attribute naming a key that no pack defines, or that only english.json has —
//     resolveKey returns undefined and the English survives, so the omission hides;
//   • the renderer inventing a keywords property on a block that never had one, which
//     is exactly what the old 'meta.keywords' fallback did to guides.html's
//     BreadcrumbList and contact.html's ContactPage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLocalizedPage } from '../../lib/i18n/render-page.js';
import { localeByPrefix } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

/**
 * Drop HTML comments before scanning markup. A comment is not served, and the note on
 * index.html's JSON-LD block explains this rule by quoting the very tag it bans — which
 * tripped the sweep below the first time it ran.
 */
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const packFiles = fs.readdirSync(path.join(PUBLIC, 'languages')).filter((f) => f.endsWith('.json'));
const lookup = (pack, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), pack);

/** Assert a key resolves to a non-empty string in every language pack. */
function assertTranslatedEverywhere(key, where) {
  for (const file of packFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', file), 'utf8'));
    const value = lookup(pack, key);
    assert.equal(typeof value, 'string', `${file} is missing ${key} (named by ${where})`);
    assert.ok(value.trim(), `${file} has an empty ${key} (named by ${where})`);
  }
}

/**
 * The FIRST ld+json block in document order — the only one either renderer touches
 * (render-page.js's replace() is non-global; language-loader.js uses querySelector).
 * Returns the open tag and the parsed body, or null when the page has no block.
 */
function firstJsonLd(html) {
  const m = /<script([^>]*\btype="application\/ld\+json"[^>]*)>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  return { attrs: m[1], data: JSON.parse(m[2]) };
}

test('sanity: the sweep actually found pages and packs', () => {
  // Every assertion below iterates these; if discovery breaks they all pass vacuously.
  assert.ok(pages.length >= 15, `expected the public pages, found ${pages.length}`);
  assert.equal(packFiles.length, 11, 'eleven language packs');
  assert.ok(pages.includes('index.html') && pages.includes('masking-studio.html'));
});

test('no page carries a <meta name="keywords"> tag', () => {
  // Swept rather than listed, so a page added tomorrow is covered the day it ships.
  const offenders = pages.filter((f) => /<meta[^>]*\bname="keywords"/i.test(stripComments(read(f))));
  assert.deepEqual(
    offenders,
    [],
    'meta keywords is ignored by Google and read as a spam signal by Bing — put the '
      + 'terms in the JSON-LD "keywords" property instead, keyed by data-lang-keywords',
  );
});

test('every JSON-LD "keywords" property names a translation key that all eleven packs define', () => {
  const annotated = [];
  for (const file of pages) {
    const block = firstJsonLd(read(file));
    if (!block || block.data.keywords === undefined) continue;

    const key = /\bdata-lang-keywords="([^"]+)"/.exec(block.attrs)?.[1];
    assert.ok(
      key,
      `${file}'s JSON-LD has a "keywords" property but no data-lang-keywords on the `
        + 'tag — it would stay English in all eleven locales',
    );
    // The renderer's own regex requires the attribute to sit AFTER type=, since it
    // matches left-to-right from `<script`. Authoring it before would parse here and
    // silently not match there.
    assert.match(
      block.attrs,
      /\btype="application\/ld\+json"[^>]*\bdata-lang-keywords=/i,
      `${file}: data-lang-keywords must come after type= to match the renderer's regex`,
    );
    assertTranslatedEverywhere(key, file);
    annotated.push(file);
  }
  assert.ok(annotated.length >= 4, `expected the four keyword-bearing pages, got ${annotated}`);
});

test('the renderer localizes keywords from the attribute, and invents none without it', () => {
  const spanish = localeByPrefix('es');
  assert.ok(spanish, 'the es locale must exist');
  const translations = {
    meta: { title: 'T', description: 'D' },
    pageMeta: { maskingStudio: { keywords: 'palabras ES' } },
  };

  const withAttr = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title></head><body>'
      + '<script type="application/ld+json" data-lang-keywords="pageMeta.maskingStudio.keywords">'
      + '{"@type":"WebApplication","keywords":"english kw"}</script></body></html>',
    translations,
    locale: spanish,
    path: '/masking-studio.html',
  });
  assert.equal(firstJsonLd(withAttr).data.keywords, 'palabras ES');

  // No attribute → the authored keywords survive untouched. Under the old
  // meta.keywords fallback this came back as the homepage list.
  const withoutAttr = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title></head><body>'
      + '<script type="application/ld+json">'
      + '{"@type":"WebApplication","keywords":"english kw"}</script></body></html>',
    translations: { ...translations, meta: { ...translations.meta, keywords: 'HOMEPAGE ES' } },
    locale: spanish,
    path: '/masking-studio.html',
  });
  assert.equal(firstJsonLd(withoutAttr).data.keywords, 'english kw');

  // …and a block with no keywords property must not grow one. This is guides.html's
  // BreadcrumbList and contact.html's ContactPage, both of which the old fallback
  // stamped the homepage keyword list onto.
  const noKeywords = renderLocalizedPage({
    html: '<html><head><title data-lang="meta.title">T</title></head><body>'
      + '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script></body></html>',
    translations: { ...translations, meta: { ...translations.meta, keywords: 'HOMEPAGE ES' } },
    locale: spanish,
    path: '/guides.html',
  });
  assert.equal(firstJsonLd(noKeywords).data.keywords, undefined);
});

test('the client mirrors the server: language-loader reads the same attribute', () => {
  // The two renderers are separate implementations of one rule, and the client's was
  // the one that had the bug. Pin that it reads the attribute rather than a literal.
  const src = fs.readFileSync(path.join(PUBLIC, 'scripts', 'language-loader.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')          // a comment naming the call is not the call
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /getAttribute\(\s*['"]data-lang-keywords['"]\s*\)/);
  assert.doesNotMatch(
    src,
    /getText\(\s*['"]meta\.keywords['"]\s*\)/,
    "hardcoding 'meta.keywords' puts the homepage keyword list on every studio page",
  );
});
