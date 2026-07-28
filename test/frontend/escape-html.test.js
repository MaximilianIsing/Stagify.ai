// The frontend's single HTML escaper (public/scripts/escape-html.js) and the
// guard that keeps it single.
//
// WHY THIS MATTERS: `escapeHtml` is the last line between data and an `innerHTML`
// string. Its predecessor in admin/helpers.js was `String(s||'')` — it returned
// its input unchanged while being named, exported, and called like an escaper at
// three `innerHTML` sinks. Nothing was exploitable, because every argument was a
// literal; the bug was the trap left for whoever first passed `user.email` to it.
// So these tests assert the escaping actually happens, character by character,
// rather than that the function merely exists.
//
// The quote cases are not padding: the profile menu interpolates into
// `title="…"` and `aria-label="…"`, and an escaper that handles only `&<>` lets a
// quote close the attribute early and start a new one.
//
// No DOM, no network: the module is a pure string transform (deliberately — the
// old profile-menu version needed `document.createElement`, which is why it could
// not be unit-tested here at all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml } from '../../public/scripts/escape-html.js';
import { esc as adminEsc } from '../../public/scripts/admin/helpers.js';
import { escapeHtml as aiDesignerEscape } from '../../public/scripts/ai-designer/format.js';

const SCRIPTS_DIR = fileURLToPath(new URL('../../public/scripts/', import.meta.url));

test('escapeHtml neutralizes the five markup-significant characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b', 'plain text around them is untouched');
});

test('escapeHtml defuses a script-tag payload and an attribute-breakout payload', () => {
  const scriptTag = escapeHtml('<script>alert(1)</script>');
  assert.equal(scriptTag, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!scriptTag.includes('<'), 'no tag can survive');

  // The classic stored-XSS shape for an admin table: an attacker-chosen email.
  const img = escapeHtml('"><img src=x onerror=alert(document.cookie)>');
  assert.ok(!img.includes('<') && !img.includes('>'), 'the injected tag is inert');
  assert.ok(!img.includes('"'), 'the quote that would close an attribute is escaped');

  // Inside a quoted attribute, neither quote style may pass through.
  const attr = escapeHtml("' onmouseover='alert(1)");
  assert.ok(!attr.includes("'"), 'single quotes cannot close a single-quoted attribute');
});

test('escapeHtml escapes & first, so an entity is encoded once and not mangled', () => {
  // If `&` were replaced last, '<' would become '&lt;' and then '&amp;lt;'.
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
  // Escaping already-escaped text encodes the ampersand (correct, and visible):
  // it means "the literal text &lt;", not "a less-than sign".
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml: null/undefined become empty, other values stringify', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(0), '0', '0 is a value, not an absence — it must not vanish');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(7), '7');
});

test('the admin dashboard and the AI Designer share this exact implementation', () => {
  // Both used to hold their own copy — admin's escaped nothing at all. Re-exports
  // rather than lookalikes, so a fix here reaches every call site.
  assert.equal(adminEsc, escapeHtml, 'admin/helpers.js esc IS the shared escaper');
  assert.equal(aiDesignerEscape, escapeHtml, 'ai-designer/format.js escapeHtml IS the shared escaper');

  const payload = '<img src=x onerror="alert(1)">';
  assert.equal(adminEsc(payload), escapeHtml(payload));
  assert.equal(aiDesignerEscape(payload), escapeHtml(payload));
});

// ── Drift guard ────────────────────────────────────────────────────────────────
// The dedup is only worth anything if a fourth copy can't reappear. This walks the
// frontend source for the two shapes a hand-rolled escaper takes and fails on any
// file other than escape-html.js. Skips minified/generated files, which are not
// hand-authored.

function frontendSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...frontendSources(full));
    } else if (name.endsWith('.js') && !name.endsWith('.min.js') && name !== 'locale-data.js') {
      out.push(full);
    }
  }
  return out;
}

test('no second HTML escaper exists in public/scripts', () => {
  const ENTITY_CHAIN = /replace\(\s*\/&\/g\s*,\s*['"]&amp;['"]\s*\)/;
  // The other way to write one: set textContent on a detached node, read innerHTML
  // back. That shape does NOT escape quotes, which is why it was replaced.
  const TEXTCONTENT_ROUNDTRIP = /\.textContent\s*=[^;]+;[\s\S]{0,120}?return\s+\w+\.innerHTML/;

  const files = frontendSources(SCRIPTS_DIR);
  assert.ok(files.length > 40, `expected to walk the frontend sources, found ${files.length}`);

  const offenders = [];
  for (const file of files) {
    if (basename(file) === 'escape-html.js') continue; // the one allowed implementation
    const src = readFileSync(file, 'utf8');
    if (ENTITY_CHAIN.test(src) || TEXTCONTENT_ROUNDTRIP.test(src)) {
      offenders.push(file.slice(SCRIPTS_DIR.length).replace(/\\/g, '/'));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these files hand-roll HTML escaping — import escapeHtml from scripts/escape-html.js instead',
  );
});

test('every translated string the profile menu interpolates goes through esc()', () => {
  // profile-menu.js builds its dropdown as an innerHTML string, and every lang()
  // value in the file lands in one — six in element content, two in `title=` /
  // `aria-label=`. Translations are team-authored, so this is not XSS; it is a
  // translator writing `&`, `<` or a quote and silently mangling the menu. The
  // attribute pair was escaped first (they break most visibly); this pins the rest,
  // because "escaped over here, bare over there" reads like a considered decision
  // when it is really an oversight waiting to be copied into the next block.
  //
  // Scanned rather than rendered: the dropdown builder lives inside an IIFE with no
  // export, and extracting it purely to test six wrappers would be a bigger and
  // riskier change than the wrappers themselves.
  const src = readFileSync(join(SCRIPTS_DIR, 'profile-menu.js'), 'utf8');

  const bare = [];
  // Tolerate whitespace after `esc(` so a reformat can't fail this for style.
  const re = /(.{0,8})lang\(\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!/esc\(\s*$/.test(m[1])) bare.push(m[3]);
  }

  assert.ok(
    src.includes("esc(lang('profile.signOut'"),
    'sanity: the scan is looking at a file that still builds the menu this way',
  );
  assert.deepEqual(
    bare,
    [],
    'these lang() values reach innerHTML unescaped — wrap them in esc()',
  );
});
