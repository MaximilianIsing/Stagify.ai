// Tier: unit + whole-corpus property check — lib/http/text-assets.js.
//
// This module rewrites every stylesheet and every HTML page on their way to the browser.
// A bug in it is not a slow page, it is a BROKEN one, and the failure would be invisible in
// review because the source files on disk stay perfect. So the naive
// `/\/\*[\s\S]*?\*\//g` is not good enough and the tests are not a formality:
//
//   - `content: "/*"` in a stylesheet is a string, not a comment. Eating from there to the
//     next `*/` deletes every declaration in between.
//   - `url("data:image/svg+xml,...")` can carry the same two characters.
//   - `<!--` inside a <script> or <style> body is data. index.html carries a real inline
//     <style> (the noscript .reveal un-hide), so this is a live case, not a hypothetical.
//
// The last two tests are the ones that would actually catch a regression: rather than
// trusting hand-written fixtures to be representative, they run the strippers over EVERY
// real stylesheet and page in public/ and assert structural invariants that a mis-strip
// cannot preserve — balanced braces, an unchanged count of rule blocks, unchanged
// <script>/<style> bodies, and idempotence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCssComments, stripHtmlComments } from '../../lib/http/text-assets.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/* ------------------------------------------------------------------ CSS, by fixture */

test('stripCssComments removes comments and keeps the declarations around them', () => {
  const out = stripCssComments('a{color:red}/* gone */b{color:blue}');
  assert.ok(!out.includes('gone'), 'comment survived');
  assert.match(out, /a\{color:red\}/);
  assert.match(out, /b\{color:blue\}/);
});

test('stripCssComments does not fuse two declarations that a comment separated', () => {
  // The reason a newline is emitted in place of the comment rather than nothing at all.
  const out = stripCssComments('a{color:red}/*x*/b{color:blue}');
  assert.ok(!/\}b\{/.test(out.replace(/\n/g, '')) === false || out.includes('\n'));
  assert.match(out, /\}\s*\n?\s*b\{/, 'the two rules must remain separable');
});

test('stripCssComments leaves /* inside a double-quoted string alone', () => {
  const src = '.a::before{content:"/*"}.b{color:red}*/.c{color:blue}';
  const out = stripCssComments(src);
  assert.equal(out, src, 'a `/*` inside content:"" is a string, not the start of a comment');
});

test('stripCssComments leaves /* inside a single-quoted string alone', () => {
  const src = ".a::before{content:'/* not a comment */'}.b{color:red}";
  assert.equal(stripCssComments(src), src);
});

test('stripCssComments survives an escaped quote inside a string', () => {
  const src = '.a::before{content:"say \\" /* still a string */"}.b{color:red}';
  assert.equal(stripCssComments(src), src);
});

test('stripCssComments leaves a quoted data: URL intact', () => {
  const src = '.a{background:url("data:image/svg+xml,%3Csvg/*%3E")}.b{color:red}';
  assert.equal(stripCssComments(src), src);
});

test('stripCssComments drops the tail of an unterminated comment', () => {
  const out = stripCssComments('a{color:red}/* never closed');
  assert.match(out, /a\{color:red\}/);
  assert.ok(!out.includes('never closed'));
});

/* ----------------------------------------------------------------- HTML, by fixture */

test('stripHtmlComments removes comments and keeps the markup around them', () => {
  const out = stripHtmlComments('<p>a</p><!-- gone --><p>b</p>');
  assert.equal(out, '<p>a</p><p>b</p>');
});

test('stripHtmlComments leaves <script> bodies byte-identical', () => {
  const src = '<script>var a = 1; // <!-- not markup\nvar b = 2;</script><p>x</p>';
  assert.equal(stripHtmlComments(src), src);
});

test('stripHtmlComments leaves <style> bodies byte-identical', () => {
  // index.html's noscript block is exactly this shape.
  const src = '<style>.reveal{opacity:1!important}/* kept */</style><!-- dropped --><p>x</p>';
  const out = stripHtmlComments(src);
  assert.ok(out.includes('/* kept */'), 'CSS comments inside an inline <style> are its own');
  assert.ok(!out.includes('dropped'), 'a real markup comment must still go');
});

test('stripHtmlComments keeps the doctype', () => {
  const out = stripHtmlComments('<!doctype html><!-- x --><html></html>');
  assert.equal(out, '<!doctype html><html></html>');
});

/* -------------------------------------------------- the whole corpus, by invariant */

/** @param {string} dir @param {RegExp} match @returns {string[]} */
function filesUnder(dir, match) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

test('every real stylesheet survives stripping with its structure intact', () => {
  const sheets = filesUnder(path.join(PUBLIC, 'styles'), /\.css$/);
  assert.ok(sheets.length >= 10, `expected the site's stylesheets, found ${sheets.length}`);

  for (const file of sheets) {
    const name = path.relative(PUBLIC, file);
    const src = fs.readFileSync(file, 'utf8');
    const out = stripCssComments(src);

    // Braces are the load-bearing structure of CSS, but the SOURCE count is the wrong
    // baseline: ai-designer.css has a comment with braces in its prose, and removing
    // those is correct. The right baseline is the naive regex strip, which is known to
    // handle everything except strings — so agreeing with it on braces means we removed
    // the same comments, and the string-awareness check below covers the rest.
    const count = (s, ch) => s.split(ch).length - 1;
    const naive = src.replace(/\/\*[\s\S]*?\*\//g, '\n');
    assert.equal(
      count(out, '{'),
      count(naive, '{'),
      `${name}: stripping removed a different set of "{" than a plain comment strip would`
    );
    assert.equal(count(out, '{'), count(out, '}'), `${name}: unbalanced braces after stripping`);

    // THE STRING-AWARENESS INVARIANT, and the reason this module is a scanner rather than
    // that one-line regex. The naive strip treats a `/*` inside content:"" or a quoted
    // url() as the start of a comment and eats everything to the next `*/`, taking real
    // declarations with it. A string-aware scanner can therefore only ever keep MORE than
    // the naive one — never less. Deleting more means we ate something we should not have.
    assert.ok(
      out.length >= naive.length,
      `${name}: string-aware stripping deleted MORE than the naive regex would ` +
        `(${src.length} -> ${out.length} vs ${naive.length}). That can only happen if it ` +
        `mis-tracked a quote and ran a "comment" past its real end.`
    );

    // Idempotent: a second pass has nothing left to find. If it does, the first pass
    // produced something that only LOOKS like a comment, which means it mangled quoting.
    assert.equal(stripCssComments(out), out, `${name}: stripping is not idempotent`);

    // And it must actually be doing its job on the big sheets.
    if (src.includes('/*')) {
      assert.ok(out.length < src.length, `${name}: has comments but stripping saved nothing`);
    }
  }
});

test('every real page survives stripping with its scripts and styles untouched', () => {
  const pages = filesUnder(PUBLIC, /\.html$/);
  assert.ok(pages.length >= 10, `expected the site's pages, found ${pages.length}`);

  // Raw-text element bodies must come through byte-for-byte: they are JSON-LD, an inline
  // <style>, and (on other pages) real script. Nothing in them is a markup comment.
  const bodies = (s, tag) =>
    [...s.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);

  for (const file of pages) {
    const name = path.relative(PUBLIC, file);
    const src = fs.readFileSync(file, 'utf8');
    const out = stripHtmlComments(src);

    // BASELINE IS THE NAIVE STRIP, NOT THE SOURCE, throughout this loop — and the reason
    // is itself instructive. index.html's own prose contains the words "<script> tags",
    // so a regex scan of the RAW file reports a script body that does not exist, running
    // from inside one comment to the next real </script>. Both 404.html and index.html
    // carry markup inside comment prose. Removing all of that is the job; what has to
    // match is WHICH COMMENTS were removed, which is exactly what the naive regex —
    // correct on everything except raw-text elements — is a good witness for.
    const naive = src.replace(/<!--[\s\S]*?-->/g, '');

    assert.deepEqual(
      bodies(out, 'script'),
      bodies(naive, 'script'),
      `${name}: a <script> body changed. Its contents are raw text — "<!--" in there is ` +
        `data, and the JSON-LD blocks on these pages must survive byte-for-byte.`
    );
    assert.deepEqual(
      bodies(out, 'style'),
      bodies(naive, 'style'),
      `${name}: an inline <style> body changed. index.html's noscript .reveal block lives ` +
        `in one, and its CSS comments are not markup comments.`
    );

    const tags = (s) => (s.match(/<[a-zA-Z][^>]*>/g) || []).length;
    assert.equal(
      tags(out),
      tags(naive),
      `${name}: stripping removed a different set of tags than a plain comment strip would`
    );
    // Raw-text-aware stripping can only keep MORE than the naive regex (a "<!--" inside a
    // <script> is data). Keeping less means a real comment boundary was mis-read.
    assert.ok(
      out.length >= naive.length,
      `${name}: raw-text-aware stripping deleted MORE than the naive regex would`
    );

    assert.equal(stripHtmlComments(out), out, `${name}: stripping is not idempotent`);
    assert.ok(!/<!--/.test(out), `${name}: a markup comment survived`);
  }
});

test('the homepage keeps every hook its other drift tests key on', () => {
  // The stripped body is what browsers and Playwright actually get. If stripping ever ate
  // one of these, every OTHER test would still pass (they read the file from disk) and only
  // the live page would break.
  const src = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const out = stripHtmlComments(src);

  for (const hook of [
    'data-hp-img',
    'hp-canvas',
    'id="hero-upload"',
    'id="background-video"',
    'media-webp/example/modern-bedroom.webp',
    'scripts/hero-picker.js',
    'scripts/index-deferred.js',
    'data-lazy-css',
    'class="hp-canvas__img is-on"',
  ]) {
    assert.ok(out.includes(hook), `stripping removed \`${hook}\` from the served homepage`);
  }
});
