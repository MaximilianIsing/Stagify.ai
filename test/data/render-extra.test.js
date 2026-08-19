// The `extra_json` codec (lib/data/render-extra.js) and the one drift guard that makes its
// vocabulary safe to duplicate on the browser side.
//
// Everything here runs on the paid render path, so the through-line of these tests is that
// NOTHING THROWS: a malformed row, a hostile filename and a source nobody recognises all
// have to degrade to "this render has no name of its own" rather than to a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_SOURCES,
  MAX_QUALIFIER,
  MAX_SOURCE_NAME,
  sanitizeLabel,
  normalizeSourceName,
  buildRenderExtra,
  readRenderExtra,
} from '../../lib/data/render-extra.js';
import { NAMED_SOURCES } from '../../public/scripts/render-name.js';

test('the source vocabulary is the same on both sides of the lib/public boundary', () => {
  // A browser module cannot import from lib/ and nothing in lib/ imports from public/, so
  // the four ids exist twice by necessity. This is the guard that pays for that.
  //
  // `interior` is deliberately absent from SOURCE_RULES: it is the one source that keeps
  // the original `<Style> <Room type>` name and therefore needs no label of its own. That
  // asymmetry is the whole reason this is `[...NAMED_SOURCES, 'interior']` rather than a
  // plain set comparison — spell it out so nobody "fixes" it by adding an interior rule.
  assert.deepEqual(
    [...NAMED_SOURCES, 'interior'].sort(),
    [...RENDER_SOURCES].sort(),
    'lib/data/render-extra.js and public/scripts/render-name.js disagree about the studios',
  );
});

test('sanitizeLabel strips what would break a card, an aria-label or a heading', () => {
  assert.equal(sanitizeLabel('  a   b  ', 80), 'a b', 'whitespace is collapsed and trimmed');
  assert.equal(sanitizeLabel('a\u0000b\u001Fc', 80), 'a b c', 'control characters become spaces');
  assert.equal(sanitizeLabel('a\u202Eb', 80), 'a b', 'a bidi override cannot reverse the rest of a card');
  assert.equal(sanitizeLabel('a\nb', 80), 'a b', 'a newline cannot break the grid');
  assert.equal(sanitizeLabel('   ', 80), '', 'whitespace only is nothing');
  assert.equal(sanitizeLabel(undefined, 80), '', 'a non-string is nothing');
  assert.equal(sanitizeLabel(42, 80), '', 'a number is nothing, not "42"');
});

test('sanitizeLabel clamps by code point, never mid-surrogate', () => {
  // The bug this prevents: `.slice(4)` on '🏠🏠🏠' stores half a code point, which renders
  // as a replacement glyph forever.
  assert.equal(sanitizeLabel('🏠🏠🏠', 2), '🏠🏠');
  assert.equal([...sanitizeLabel('🏠'.repeat(50), 32)].length, 32);
  assert.equal(sanitizeLabel('abcdef', 3), 'abc');
});

test('normalizeSourceName reduces a filename to the part worth showing', () => {
  assert.equal(normalizeSourceName('123-main-front.jpg'), '123-main-front');
  assert.equal(normalizeSourceName('412 Rosewood Ln.jpeg'), '412 Rosewood Ln');
  assert.equal(normalizeSourceName('no-extension'), 'no-extension');
  assert.equal(normalizeSourceName('archive.tar.gz'), 'archive.tar', 'only the last extension goes');
});

test('normalizeSourceName takes the basename, so no path ever reaches a card', () => {
  // `originalname` is client-supplied. This is not a traversal fix — the value never
  // becomes a path — it is that "C:\fakepath\house.jpg" on a card is a bug users report.
  assert.equal(normalizeSourceName('C:\\fakepath\\house.jpg'), 'house');
  assert.equal(normalizeSourceName('/var/tmp/upload/house.jpg'), 'house');
  assert.equal(normalizeSourceName('../../etc/passwd'), 'passwd');
});

test('normalizeSourceName drops stems that would be identical on every render', () => {
  // public/scripts/app.js re-wraps a mask-edited "before" as 'photo.png' before re-staging
  // it. Without this every such render would read "· photo", which tells the owner nothing
  // and defeats the entire point of a disambiguating suffix.
  for (const generic of ['photo', 'image', 'IMG', 'Untitled', 'download', 'screenshot', 'blob']) {
    assert.equal(normalizeSourceName(`${generic}.png`), '', `${generic} should not become a suffix`);
  }
  assert.equal(normalizeSourceName('photo-of-412.png'), 'photo-of-412', 'only an EXACT match is dropped');
});

test('buildRenderExtra refuses a source it does not recognise, without throwing', () => {
  // A typo in a future writer must cost that render its NAME, not its row.
  assert.equal(buildRenderExtra({ source: 'listing-studio' }), null);
  assert.equal(buildRenderExtra({ source: '' }), null);
  assert.equal(buildRenderExtra({}), null);
  assert.equal(buildRenderExtra(null), null);
  assert.equal(buildRenderExtra(undefined), null);
  assert.equal(buildRenderExtra({ qualifier: 'Golden hour' }), null, 'a qualifier alone is not enough');
});

test('buildRenderExtra omits what it does not know rather than storing empty strings', () => {
  assert.deepEqual(buildRenderExtra({ source: 'interior' }), { source: 'interior' });
  assert.deepEqual(
    buildRenderExtra({ source: 'exterior', qualifier: 'Golden hour', sourceName: '123-main.jpg' }),
    { source: 'exterior', qualifier: 'Golden hour', sourceName: '123-main' },
  );
  assert.deepEqual(
    buildRenderExtra({ source: 'masking', sourceName: 'photo.png' }),
    { source: 'masking' },
    'a generic stem leaves no key behind at all',
  );
});

test('buildRenderExtra clamps both free-text fields', () => {
  const built = buildRenderExtra({
    source: 'exterior',
    qualifier: 'q'.repeat(500),
    sourceName: 's'.repeat(500),
  });
  assert.equal(built.qualifier.length, MAX_QUALIFIER);
  assert.equal(built.sourceName.length, MAX_SOURCE_NAME);
});

test('readRenderExtra never throws, whatever is in the column', () => {
  const empty = { source: '', qualifier: '', sourceName: '' };
  // One damaged row must not take down a whole page of the gallery.
  assert.deepEqual(readRenderExtra({ extra_json: '{not json' }), empty);
  assert.deepEqual(readRenderExtra({ extra_json: 'null' }), empty);
  assert.deepEqual(readRenderExtra({ extra_json: '[1,2,3]' }), empty, 'an array is not a payload');
  assert.deepEqual(readRenderExtra({ extra_json: '"a string"' }), empty);
  assert.deepEqual(readRenderExtra({ extra_json: '' }), empty);
  assert.deepEqual(readRenderExtra({ extra_json: null }), empty);
  assert.deepEqual(readRenderExtra({}), empty);
  assert.deepEqual(readRenderExtra(null), empty);
  assert.deepEqual(readRenderExtra(undefined), empty);
});

test('readRenderExtra re-sanitizes on the way out and allowlists the three keys', () => {
  // A reader that trusts its own storage is one restore-from-backup away from being wrong.
  const row = {
    extra_json: JSON.stringify({
      source: 'exterior',
      qualifier: 'Golden\u202Ehour',
      sourceName: 'x'.repeat(200),
      secret: 'should not survive',
    }),
  };
  const out = readRenderExtra(row);
  assert.deepEqual(Object.keys(out).sort(), ['qualifier', 'source', 'sourceName']);
  assert.equal(out.qualifier, 'Golden hour', 'a bidi override stored earlier is still stripped on read');
  assert.equal(out.sourceName.length, MAX_SOURCE_NAME);
});

test('readRenderExtra drops a source that is no longer in the vocabulary', () => {
  // Retiring a studio must degrade its old rows to the interior naming ladder rather than
  // leaving render-name.js to look up a rule that no longer exists.
  const row = { extra_json: JSON.stringify({ source: 'retired-studio', sourceName: 'house' }) };
  const out = readRenderExtra(row);
  assert.equal(out.source, '');
  assert.equal(out.sourceName, 'house', 'the rest of the row still survives');
});

test('what buildRenderExtra writes, readRenderExtra reads back unchanged', () => {
  for (const source of RENDER_SOURCES) {
    const built = buildRenderExtra({ source, qualifier: 'Golden hour', sourceName: '123-main.jpg' });
    const read = readRenderExtra({ extra_json: JSON.stringify(built) });
    assert.equal(read.source, source);
    assert.equal(read.qualifier, 'Golden hour');
    assert.equal(read.sourceName, '123-main');
  }
});

// ── DRIFT GUARD: every gallery writer names the studio it came from ──────────

test('every recordPending call site supplies a known source', async () => {
  // The whole naming scheme rests on this. A fifth writer added without an `extra` would
  // not fail at runtime — buildRenderExtra returns null and the row simply falls back to
  // the interior `<Style> <Room type>` ladder, which for a surface with neither is the
  // useless "Staged room". So the omission has to fail HERE instead.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  /** Every .js under a directory, recursively. */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });

  // Comments are stripped FIRST. This repo has shipped a guard that passed with the fix
  // deleted, because the fix's own comment still named the token it was scanning for.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const sites = [];
  for (const file of [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'routes'))]) {
    const src = strip(fs.readFileSync(file, 'utf8'));
    let from = 0;
    for (;;) {
      const at = src.indexOf('recordPending(', from);
      if (at === -1) break;
      from = at + 1;
      // Brace-match the argument object so a `source:` belonging to the NEXT call cannot
      // satisfy this one.
      const open = src.indexOf('{', at);
      if (open === -1) continue;
      let depth = 0;
      let end = open;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}' && --depth === 0) break;
      }
      const args = src.slice(open, end + 1);
      // The definition itself and its forwarding are not call sites.
      if (/function recordPending/.test(src.slice(Math.max(0, at - 40), at))) continue;
      // split/join rather than a regex: this file is read on Windows too, and a literal
      // path separator in a regex is exactly the sort of escape a shell eats in transit.
      sites.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), args });
    }
  }

  const callers = sites.filter((s) => !s.file.endsWith('lib/staging/render-persistence.js'));
  // The count is what makes DELETING a writer fail too, rather than passing vacuously on an
  // empty list. Four today: interior, exterior, designer, masking.
  assert.ok(callers.length >= 4, `expected at least 4 gallery writers, found ${callers.length}`);

  // Writers whose `source` is an EXPRESSION rather than a literal, named one at a time.
  //
  // This list is the repair for the way this guard once failed. It used to run
  // `args.match(/source:\s*'([a-z-]+)'/)` and skip the membership check whenever that did
  // not match. So when the public API turned `source: 'interior'` into
  // `source: meta.sourceTag || 'interior'`, the regex missed, the match came back null,
  // and the check was skipped in silence — the guard kept passing while every render sold
  // through the API was written with a source the vocabulary did not contain. A check that
  // quietly does nothing is worse than no check, because it also stops anyone looking.
  //
  // A non-literal is now tolerated only for a file ON THIS LIST, and every quoted id
  // inside such an expression still has to be a known source.
  const DYNAMIC_SOURCE_WRITERS = ['lib/staging/virtual-staging-handler.js'];

  /** The value expression after `source:`, up to the comma or brace that ends it. */
  const sourceValue = (args) => {
    const key = args.match(/source:/);
    if (!key) return null;
    let depth = 0;
    let quote = "";
    let out = "";
    for (let i = key.index + key[0].length; i < args.length; i++) {
      const c = args[i];
      if (quote) {
        out += c;
        if (c === "\\") { out += args[i + 1] ?? ""; i++; continue; }
        if (c === quote) quote = "";
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { quote = c; out += c; continue; }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
      out += c;
    }
    return out.trim();
  };

  const dynamicSeen = new Set();
  for (const site of callers) {
    assert.match(site.args, /source:/, `${site.file} calls recordPending without an extra.source`);
    const value = sourceValue(site.args);
    assert.ok(value, `${site.file} has an unreadable extra.source`);

    const literal = value.match(/^'([^']*)'$/);
    if (literal) {
      assert.ok(
        RENDER_SOURCES.includes(literal[1]),
        `${site.file} names an unknown source "${literal[1]}"`,
      );
      continue;
    }

    // An expression. Allowed, but only deliberately.
    dynamicSeen.add(site.file);
    assert.ok(
      DYNAMIC_SOURCE_WRITERS.includes(site.file),
      site.file + ' computes extra.source (' + value + ') instead of naming one. That is how '
      + 'the API once shipped a source the vocabulary did not contain. Add it to '
      + 'DYNAMIC_SOURCE_WRITERS if this is deliberate, and make sure every id it can produce '
      + 'is in RENDER_SOURCES.',
    );
    // Every id the expression could name still has to be real. This is what catches the
    // `|| 'interior'` fallback, and any future `cond ? 'a' : 'b'`.
    for (const [, id] of value.matchAll(/'([^']*)'/g)) {
      assert.ok(RENDER_SOURCES.includes(id), `${site.file} can produce the unknown source "${id}"`);
    }
  }

  // A stale allowlist is the next way this rots: a file listed here that no longer computes
  // its source would let a future literal typo through unexamined.
  for (const file of DYNAMIC_SOURCE_WRITERS) {
    assert.ok(
      dynamicSeen.has(file),
      `${file} is listed as a dynamic source writer but no longer computes extra.source — drop it`,
    );
  }
});

test('every sourceTag handed to the staging handler is a known source', async () => {
  // The sweep above cannot see lib/staging/api-render-billing.js AT ALL: it never calls
  // recordPending. It sets `sourceTag` on the meta object and lets virtual-staging-handler.js
  // forward it into `extra`. So the one writer that actually shipped an unknown source was
  // invisible to the guard written to catch unknown sources — the tag was asserted in
  // test/staging/api-render-billing.test.js against a faked handler, which passes whether or
  // not the tag survives buildRenderExtra.
  //
  // This is the other door. Anything naming a sourceTag is naming a render's origin, and an
  // unknown one does not merely lose the name: buildRenderExtra returns null, which nulls the
  // WHOLE extra_json column and takes `sourceName` with it.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const tags = [];
  for (const file of [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'routes'))]) {
    const src = strip(fs.readFileSync(file, 'utf8'));
    for (const [, tag] of src.matchAll(/sourceTag:\s*'([^']*)'/g)) {
      tags.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), tag });
    }
  }

  // Non-vacuous: comments are stripped first, so a guard that found nothing would mean the
  // writer was renamed, not that it is safe.
  assert.ok(tags.length >= 1, 'no sourceTag writers found — this sweep has gone vacuous');
  for (const { file, tag } of tags) {
    assert.ok(
      RENDER_SOURCES.includes(tag),
      `${file} sets sourceTag "${tag}", which is not in RENDER_SOURCES — that nulls extra_json entirely`,
    );
  }
});

test('an unknown source costs the row its FILENAME too, not just its origin', () => {
  // The failure mode that made the API bug expensive. `source` and `sourceName` share one
  // column, and buildRenderExtra rejects the whole object rather than the bad field — so an
  // unregistered id does not merely leave a render unlabelled, it deletes the source photo's
  // stem as well, and the card falls back to "Standard Bedroom" with nothing to tell it from
  // the owner's other twenty.
  const rejected = buildRenderExtra({ source: 'not-a-studio', sourceName: '412-rosewood.jpg' });
  assert.equal(rejected, null, 'the whole payload is dropped, filename included');

  // Registered, so both survive. This is the assertion that fails if 'api' is ever removed
  // from RENDER_SOURCES without the writer being removed with it.
  const kept = buildRenderExtra({ source: 'api', sourceName: '412-rosewood.jpg' });
  assert.deepEqual(kept, { source: 'api', sourceName: '412-rosewood' });
  assert.equal(readRenderExtra({ extra_json: JSON.stringify(kept) }).source, 'api');
});
