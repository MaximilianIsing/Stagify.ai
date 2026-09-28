// Tier: markup + source guard — the manual refresh control on /status.
//
// WHY A STATIC GUARD AND NOT A UNIT TEST
// public/scripts/status/status.js is an IIFE with no exports (it ships `export {}` purely so
// `eslint .` picks it up), and it is on the SHRINK-ONLY allowlist in
// untested-frontend-modules.test.js. There is nothing to import. So this asserts the
// things that are invisible when they break rather than the behaviour: an accessibility
// attribute nobody sees, and a throttle that fails open.
//
// The three regressions this exists to catch, in order of how quietly they would land:
//
//   1. `aria-live="off"` dropped from the button. It sits inside the banner's
//      aria-live="polite" region, so without it a screen reader announces every tick of
//      the cooldown — ten announcements per click — and a sighted reviewer sees nothing
//      wrong at all.
//   2. The countdown moved into the data-lang label. The language runtime rewrites that
//      node's text on every translation pass, so the numeral would be erased mid-count
//      and would fight rerender(). It has to stay in its own span.
//   3. The visibilitychange handler going back to a bare load(). It used to refetch on
//      every tab return, which makes the button's cooldown decorative: alt-tab twice and
//      you have refreshed as often as you like. Both paths must share one timestamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'status.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'status', 'status.js'), 'utf8');

/** The `<button …>` element carrying data-refresh, opening tag through close. */
function refreshButton() {
  const m = /<button\b[^>]*\bdata-refresh\b[^>]*>[\s\S]*?<\/button>/.exec(html);
  assert.ok(m, 'status.html no longer has a [data-refresh] button');
  return m[0];
}

test('the refresh button exists exactly once, and is a real button', () => {
  const all = html.match(/\bdata-refresh\b(?!-)/g) || [];
  assert.equal(all.length, 1, `expected one [data-refresh], found ${all.length}`);

  const btn = refreshButton();
  assert.match(btn, /type="button"/, 'without an explicit type a <button> defaults to submit');
});

test('the button sits inside the status banner', () => {
  // Placement is not decoration here: it is next to "last check Ns ago", which is the
  // number it exists to change. Somewhere else on the page and it reads as unrelated.
  const banner = /<section class="st-banner[\s\S]*?<\/section>/.exec(html);
  assert.ok(banner, 'the .st-banner section is gone — this guard needs rewriting');
  assert.match(banner[0], /\bdata-refresh\b/, 'the refresh button moved out of the banner');
});

test('the button opts OUT of the banner’s aria-live region', () => {
  // See regression 1 in the header. This is the assertion most likely to be deleted by
  // someone who does not know why it is here, hence the comment on the markup too.
  const banner = /<section class="st-banner[^>]*>/.exec(html);
  assert.ok(banner, 'the .st-banner opening tag is gone');
  assert.match(banner[0], /aria-live="polite"/, 'the banner is no longer a live region — if that is deliberate, this guard can go');
  assert.match(refreshButton(), /aria-live="off"/, 'the countdown will be announced once a second without this');
});

test('the label is translated and the countdown is not part of it', () => {
  const btn = refreshButton();
  assert.match(btn, /data-lang="status\.refresh"/, 'the label must be translatable');

  // The numeral lives in its own span, hidden from assistive tech (it is noise next to
  // a disabled control) and outside the node the language runtime overwrites.
  const count = /<span class="st-refresh__count"[^>]*>/.exec(btn);
  assert.ok(count, 'the [data-refresh-count] span is gone');
  assert.match(count[0], /aria-hidden="true"/);
  assert.match(count[0], /\bdata-refresh-count\b/);

  const label = /<span data-lang="status\.refresh">([^<]*)<\/span>/.exec(btn);
  assert.ok(label, 'the label span changed shape');
  assert.doesNotMatch(label[1], /\d/, 'the countdown leaked into the translated label');
});

test('status.refresh resolves in every language pack', () => {
  // static.test.js already enforces whole-file key parity; this names the one key, so a
  // failure points at this feature instead of at a list of 40 missing keys.
  const dir = path.join(ROOT, 'public', 'languages');
  const missing = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const value = pack?.status?.refresh;
    if (typeof value !== 'string' || !value.trim()) missing.push(file);
  }
  assert.deepEqual(missing, [], `packs without a usable status.refresh: ${missing.join(', ')}`);
});

test('the cooldown is real, and both refresh paths share it', () => {
  assert.match(js, /var COOLDOWN_MS = \d+;/, 'the cooldown constant is gone');

  // See regression 3. The handler must consult the shared timestamp, not just fetch.
  const handler = /visibilitychange'[\s\S]*?\n {8}\}\);/.exec(js);
  assert.ok(handler, 'the visibilitychange handler changed shape — re-read it before editing this');
  assert.match(
    handler[0],
    /lastFetchAt \+ COOLDOWN_MS/,
    'visibilitychange refetches without checking the cooldown, so alt-tabbing defeats the button',
  );
});

test('load() cannot run twice concurrently', () => {
  // Three callers (the 60s timer, the visibility handler, the button) and a slow network
  // is all it takes for an older response to land after a newer one and win the render.
  const load = /function load\(\) \{[\s\S]*?\n {8}\}/.exec(js);
  assert.ok(load, 'load() changed shape');
  assert.match(load[0], /if \(inFlight\) return;/, 'the in-flight guard is gone');
  assert.match(load[0], /inFlight = true;/);
});
