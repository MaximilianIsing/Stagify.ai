# Translate one Stagify blog article into 10 languages

You are translating one published article from Stagify.ai (a virtual-staging web app) into
10 languages. This is production content served at /es/blog/<slug>, /fr/blog/<slug>, … and
indexed by Google. A validator checks your output against the English and REFUSES anything
structurally different, so precision matters more than flourish.

## Read first

1. `C:\Users\Maxim\Downloads\Stagify\.i18n-work\glossary.md` — binding terminology.
2. Your source file (path given in your task) — shape:
   `{ slug, marketNote, english: { meta:{title,description}, title, eyebrow, byline, crumb,
      figureAlt, body, cta:{title,body,link}, disclaimer? } }`

## Write

One file per language to `C:\Users\Maxim\Downloads\Stagify\.i18n-work\<slug>\<prefix>.json`

Prefixes: es (Spanish/Spain), fr (French/France), de (German), zh (Simplified Chinese),
ko (Korean), pt (Portuguese/Brazil), ru (Russian), it (Italian), ja (Japanese), nl (Dutch).

Each file mirrors `english` EXACTLY in its key set — same keys, no more, no fewer.
Include `disclaimer` if and only if the English has it. Never include `_meta`.

## Hard rules (automatic rejection)

1. `body` is an HTML fragment. The sequence of opening tags in your output must be
   IDENTICAL to the English, element for element, in order. Do not add, remove, merge,
   split or re-level any element. An <h3> stays an <h3>. Two <p> stay two <p>.
2. Never change an attribute VALUE. Every href, src and class is copied verbatim.
   `/stagify-plus.html` stays `/stagify-plus.html` — the server adds the language prefix.
   `<p class="lead">` keeps its class. `<div class="article-callout">` keeps its class.
3. Translate text nodes only. <strong>, <em>, <a>, <li>, <h2>, <h3> stay exactly where they
   are, wrapping the translated equivalent of the words they wrapped.
4. No <script>, no <iframe>, no inline event handlers, no javascript: URLs.
5. HTML entities stay well-formed. Never emit a bare `&`.

## Slot notes

- `meta.title` keeps its ` | Stagify.ai` suffix. Translate the part before it.
- `meta.description` is the search snippet: ~150-160 chars for Latin/Cyrillic scripts,
  ~90-110 for zh/ja/ko (a 150-char CJK snippet gets truncated).
- `crumb` is a short breadcrumb label. Keep it short.
- `byline` is HTML: `By <strong>Stagify.ai</strong> · <date> · N min read`. Translate "By"
  and "min read", render the date in the language's long form, keep <strong> and the ·.
- `figureAlt` is image alt text — describe the same image naturally.
- `cta.link` is button text, usually ending in →. Keep the arrow.
- `disclaimer`, where present, is a legal notice. Translate it faithfully and completely.
  Do not soften it, shorten it, or drop a sentence.

## marketNote

If your source has `"marketNote": true`, the article describes UNITED STATES practice.
In that case, and only then, insert exactly ONE extra element into `body`: a
`<div class="article-callout">` immediately after the first `</p>`, containing one or two
sentences in the target language saying that this article describes US rules/practice and
that local rules where the reader lives will differ, so they should check their own.

CRITICAL: do NOT name, cite or invent any specific foreign law, statute, agency, regulator
or figure. Say only that local rules differ and the reader should check theirs. A
hallucinated German disclosure statute on a page about legal compliance is the worst
possible failure of this task.

If `marketNote` is false, add nothing at all.

## Before you finish

For each of the 10 files, verify: it parses as JSON; its top-level key set matches the
English exactly; and the counts of `<p`, `<h2`, `<h3`, `<ul`, `<li`, `<a `, `<strong`,
`<em` and `<div` in your `body` match the English body's counts (plus exactly one `<div`
when marketNote is true). Report any file where they differ rather than silently leaving it.

Report back: the file paths written, and any judgement call worth knowing about.
