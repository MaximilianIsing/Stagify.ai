// DRIFT GUARD: the parameter table in public/developers.html vs the real vocabularies.
//
// WHY THIS IS A TEST AND NOT A RENDERER
// The obvious fix for a hand-written docs table is to render it from GET /api/v1/options
// at page load. That was rejected: developers-pricing.js's header states the rule this
// page follows — "documentation that needs JavaScript to be readable is documentation
// that is sometimes not readable" — and a parameter table is the part a developer is
// most likely to hit with JS off, from a cached copy, or in a text browser. So the table
// stays static HTML and THIS is what stops it lying.
//
// The bug it was written for: the table said "e.g. Living Room, Bedroom, Kitchen" and
// the curl sent `roomType=Living Room`. Capital R, which is not a promptMatrix key, so
// the one example we shipped silently took the generic fallback prompt and still charged
// a credit. Nothing caught it because nothing compared the two.
//
// This asserts BOTH directions: every real value appears, and no value appears that is
// not real. The second half is the one that catches a renamed or deleted room type.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiOptions } from '../../lib/staging/api-options.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(rootDir, 'public', 'developers.html'), 'utf8');

/** The parameter table only, so a word appearing in prose elsewhere cannot stand in. */
function parametersSection() {
  const start = html.indexOf('id="parameters"');
  assert.ok(start > -1, 'the parameters section is gone');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

/** Every `<code>…</code>` value inside the section, which is how each value is marked up. */
function codeValues(section) {
  return new Set([...section.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1].trim()));
}

const OPTIONS = buildApiOptions();

test('every accepted roomType is documented, and nothing else is', () => {
  const section = parametersSection();
  const codes = codeValues(section);

  for (const value of OPTIONS.room_type.values) {
    assert.ok(codes.has(value), `roomType "${value}" is accepted but not documented`);
  }
  // The reverse: a capitalised or renamed leftover must not survive here. Only checks
  // strings that LOOK like a room type (capitalised words), so field names and codes in
  // the same table are not swept up.
  const roomish = [...codes].filter((c) => /^[A-Z][a-z]+( [a-z]+)?$/.test(c));
  for (const c of roomish) {
    assert.ok(
      OPTIONS.room_type.values.includes(c),
      `"${c}" is documented as a room type but is not a promptMatrix key — this is the ` +
      '"Living Room" bug: it will not be rejected, it will be pasted into the prompt',
    );
  }
});

test('every furnitureStyle and stampStyle is documented', () => {
  const codes = codeValues(parametersSection());
  for (const value of OPTIONS.furniture_style.values) {
    assert.ok(codes.has(value), `furnitureStyle "${value}" is accepted but not documented`);
  }
  for (const value of OPTIONS.stamp_style.values) {
    assert.ok(codes.has(value), `stampStyle "${value}" is accepted but not documented`);
  }
});

test('every stampLang is documented — all eleven, not a sample', () => {
  const codes = codeValues(parametersSection());
  for (const value of OPTIONS.stamp_lang.values) {
    assert.ok(codes.has(value), `stampLang "${value}" is accepted but not documented`);
  }
});

test('the stampScale bounds and the upload limit match the server', () => {
  const section = parametersSection();
  assert.ok(section.includes(`<code>${OPTIONS.stamp_scale.min}</code>`), 'stampScale min drifted');
  assert.ok(section.includes(`<code>${OPTIONS.stamp_scale.max}</code>`), 'stampScale max drifted');

  const mb = OPTIONS.image.max_bytes / (1024 * 1024);
  assert.ok(section.includes(`${mb} MB`), `the documented upload limit is not ${mb} MB`);
});

test('the copy-pasteable curl uses values the server actually accepts', () => {
  // The quickstart is the first thing anyone runs. A value that is merely PLAUSIBLE here
  // costs a real credit and returns a quietly worse image.
  // Quickstart now carries the pricing grid too, so the section runs to #parameters.
  const curl = html.slice(html.indexOf('id="quickstart"'), html.indexOf('id="parameters"'));

  const room = curl.match(/roomType=([^"\\\n]+)/);
  assert.ok(room, 'the quickstart no longer sends a roomType');
  assert.ok(
    OPTIONS.room_type.values.includes(room[1].trim()),
    `the quickstart sends roomType="${room[1].trim()}", which is not an accepted value`,
  );

  const style = curl.match(/furnitureStyle=([^"\\\n]+)/);
  if (style) {
    assert.ok(
      OPTIONS.furniture_style.values.includes(style[1].trim()),
      `the quickstart sends furnitureStyle="${style[1].trim()}", which is not accepted`,
    );
  }
});

test('the docs point at the live options endpoint', () => {
  // Belt and braces: if someone deletes the endpoint, route-inventory catches it. If
  // someone deletes the mention, integrators just never learn it exists.
  assert.ok(html.includes('GET /api/v1/options'), 'the options endpoint is no longer documented');
});

test('no error code is advertised that the server never emits', () => {
  // IMAGE_REQUIRED was in this table for a while and appeared nowhere in the source: the
  // real response is a 400 with no `code` at all, so a client branching on it never
  // matched. Every code in the errors table must exist in the route or the handler.
  const errors = html.slice(html.indexOf('id="errors"'), html.indexOf('id="other-endpoints"'));
  const advertised = [...errors.matchAll(/<code>([A-Z][A-Z_]+)<\/code>/g)].map((m) => m[1]);
  assert.ok(advertised.length >= 8, 'sanity: the error table looks empty');

  const sources = [
    'routes/api-v1.js',
    'lib/staging/virtual-staging-handler.js',
    'lib/http/api-key-auth.js',
    'lib/http/api-concurrency.js',
    'lib/http/rate-limiters.js',
  ]
    .map((rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8'))
    .join('\n');

  for (const code of advertised) {
    assert.ok(sources.includes(code), `the docs advertise ${code}, which no source file emits`);
  }
});
