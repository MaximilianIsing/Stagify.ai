// Tier: i18n + SEO drift guard — the /about FAQPage structured data, in all eleven
// languages.
//
// WHAT WAS WRONG
// renderLocalizedPage() localizes exactly one marked JSON-LD block (the AboutPage), so
// /es/about.html shipped a Spanish page whose FAQPage structured data was entirely in
// English: ten of eleven locales declaring answers that were nowhere on the page they
// were attached to, and every Question `url` pointing back into the English tree.
// localizeFaq() fixes that; this file is what keeps it fixed.
//
// THE PROPERTY THAT MATTERS IS PARITY, NOT TRANSLATION
// test/seo/organization-jsonld.test.js already asserts that every answer in about.html's
// FAQPage appears as visible text on the page — an FAQPage whose answers a human cannot
// see is cloaking. That test scans the static English file, so the locale tree was
// invisible to it. The last test below is the same assertion, ten locales over.
//
// Google restricted FAQ rich results to government and health sites in 2023, so this
// does not change how /about looks in Google. It is about not publishing structured
// data that contradicts the page — Bing and the AI crawlers still read it.
//
// The homepage FAQ is deliberately NOT translated (see the note in
// test/i18n/faq-jsonld-parity.test.js); that decision is scoped to the homepage, whose
// FAQ has no marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLocalizedPage } from '../../lib/i18n/render-page.js';
import { ENGLISH, LOCALES, SITE_ORIGIN } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const ABOUT = fs.readFileSync(path.join(PUBLIC, 'about.html'), 'utf8');

const pack = (locale) =>
  JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', `${locale.lang}.json`), 'utf8'));

/** The FAQPage block out of a rendered page. */
function faqBlock(html) {
  const m = html.match(/<script[^>]*id="about-faq-jsonld"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'about.html no longer has an #about-faq-jsonld block');
  return JSON.parse(m[1]);
}

/**
 * The VISIBLE question and answer for one FAQ slot, read out of the rendered
 * `<details>` rather than by searching the whole page.
 *
 * Reading the exact element is the point: a substring search over the page text has to
 * decide what a stripped tag leaves behind, and either answer is wrong. Replacing `<a>`
 * with a space turns "la <a>página</a>, bajo" into "página , bajo" and the match fails
 * on punctuation; replacing it with nothing runs adjacent blocks together and the match
 * can succeed against text that is not the answer at all.
 */
function visiblePair(html, n) {
  const q = html.match(new RegExp(`<summary[^>]*data-lang="about\\.faq\\.q${n}"[^>]*>([\\s\\S]*?)</summary>`));
  const a = html.match(new RegExp(`<p[^>]*data-lang-html="about\\.faq\\.a${n}"[^>]*>([\\s\\S]*?)</p>`));
  assert.ok(q && a, `the rendered page has no visible question/answer ${n}`);
  return { question: plain(q[1]), answer: plain(a[1]) };
}

/** Tags out, entities back, whitespace collapsed. */
function plain(s) {
  return s.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const strip = (s) => s.replace(/<[^>]+>/g, '');
const localized = LOCALES;

const render = (locale) => renderLocalizedPage({
  html: ABOUT,
  translations: pack(locale),
  locale,
  path: '/about.html',
});

test('the FAQ block carries the marker the renderer looks for', () => {
  // Without it localizeFaq() is a silent no-op and every assertion below would be
  // testing the English fallback path.
  assert.match(ABOUT, /id="about-faq-jsonld"[^>]*\bdata-lang-faq="about\.faq"/);
});

test('every locale gets its own questions and answers', () => {
  assert.equal(localized.length, 10, 'expected ten non-English locales');

  for (const locale of localized) {
    const translations = pack(locale);
    const questions = faqBlock(render(locale)).mainEntity;
    assert.equal(questions.length, 10, `${locale.lang}: expected ten questions`);

    questions.forEach((question, i) => {
      const n = i + 1;
      assert.equal(question.name, translations.about.faq[`q${n}`], `${locale.lang}: q${n}`);
      assert.equal(
        question.acceptedAnswer.text,
        strip(translations.about.faq[`a${n}`]),
        `${locale.lang}: a${n} (answers are tag-stripped — the packs carry inline links)`,
      );
    });
  }
});

test('every question points at its own locale copy of the page', () => {
  for (const locale of localized) {
    for (const question of faqBlock(render(locale)).mainEntity) {
      assert.equal(
        question.url,
        `${SITE_ORIGIN}/${locale.prefix}/about.html#about-faq`,
        `${locale.lang}: a question still links the English page`,
      );
    }
  }
});

test('every structured answer is visible on the page it is attached to', () => {
  // The anti-cloaking guard, in the locale tree. Both halves resolve the same pack
  // keys, so they agree by construction — this is what proves the construction holds.
  for (const locale of localized) {
    const html = render(locale);
    faqBlock(html).mainEntity.forEach((question, i) => {
      const visible = visiblePair(html, i + 1);
      assert.equal(plain(question.name), visible.question, `${locale.lang}: question ${i + 1} differs from the page`);
      assert.equal(
        plain(question.acceptedAnswer.text),
        visible.answer,
        `${locale.lang}: answer ${i + 1} is in the structured data but not in those words on the page`,
      );
    });
  }
});

test('the English page is left exactly as authored', () => {
  // localizeFaq only runs for a prefixed locale: the static English file is served
  // straight off disk, and rewriting it here would mean the committed file and the
  // served bytes could differ.
  const before = faqBlock(ABOUT);
  const after = faqBlock(render(ENGLISH));
  assert.deepEqual(after, before);
});
