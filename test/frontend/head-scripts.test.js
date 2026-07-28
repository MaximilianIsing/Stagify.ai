// Nothing may block the parser in <head> unless it has a reason to.
//
// There is no bundler here (a standing decision — see docs/guides/architecture.md),
// so every page hand-lists its <script> tags and a copy-pasted one inherits whatever
// attributes the page it was copied from had. That is how the Google Ads tag ended up
// synchronous and FIRST in <head> on all 19 public pages: a blocking fetch ahead of
// every stylesheet link, for a file that only queues two dataLayer entries and appends
// an already-async loader.
//
// A synchronous <script src> in <head> stops parsing until it is fetched and run, which
// also delays discovery of the CSS below it. Three scripts genuinely need that (they
// gate or redirect before anything paints); everything else must carry `defer`, `async`,
// or be a module. The allowlist below is the whole set — a new entry needs a reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');

/**
 * Scripts allowed to block the parser in <head>, and why. Keyed by basename so the
 * root-relative / relative / `../` path variants across pages all resolve to one entry.
 */
const BLOCKING_ALLOWED = {
  'ai-designer-gate.js': 'redirects signed-out visitors before the studio paints',
  'masking-studio-gate.js': 'same gate for the Masking Studio',
  'faq-redirect.js': 'meta-refresh stub — must redirect before anything renders',
};

/** Every .html under public/, recursively. */
function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** The `<head>` of a document, or '' when it has none. */
function headOf(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

const pages = htmlFiles(publicDir);

test('the page set is discovered (guard against an empty sweep)', () => {
  assert.ok(pages.length >= 20, `expected the public pages, found ${pages.length}`);
});

test('no unexplained render-blocking <script> in any <head>', () => {
  const offenders = [];
  for (const file of pages) {
    const head = headOf(fs.readFileSync(file, 'utf8'));
    for (const tag of head.match(/<script\b[^>]*\bsrc=[^>]*>/gi) || []) {
      if (/\bdefer\b|\basync\b|type=["']module["']/i.test(tag)) continue;
      const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1] || '';
      const base = path.basename(src);
      if (Object.hasOwn(BLOCKING_ALLOWED, base)) continue;
      offenders.push(`${path.relative(root, file)}: ${tag.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These block HTML parsing (and CSS discovery) in <head>. Add defer/async, or add the ' +
      'script to BLOCKING_ALLOWED in this file with the reason it must run before paint:\n' +
      offenders.join('\n'),
  );
});

test('every page that loads the Google Ads tag defers it', () => {
  const tagged = pages.filter((f) => fs.readFileSync(f, 'utf8').includes('scripts/gtag.js'));
  assert.ok(tagged.length >= 19, `expected the tag on the public pages, found ${tagged.length}`);
  for (const file of tagged) {
    const tag = fs.readFileSync(file, 'utf8').match(/<script\b[^>]*gtag\.js[^>]*>/i);
    assert.ok(tag, `${path.relative(root, file)}: no gtag script tag matched`);
    // `defer` specifically, not merely non-blocking: this tag is first in <head>, and
    // defer preserves document order, so `window.gtag` is guaranteed to exist before
    // any other deferred or module script runs. `async` would drop that guarantee and
    // race a future conversion snippet.
    assert.match(
      tag[0],
      /\bdefer\b/,
      `${path.relative(root, file)} loads gtag.js without defer. Synchronous blocks the parser ` +
        'ahead of every stylesheet; async loses the ordering guarantee that window.gtag exists ' +
        'before later scripts run. See the header comment in public/scripts/gtag.js.',
    );
  }
});

test('the allowlisted blocking scripts still exist and are still in a head', () => {
  // A stale allowlist quietly re-permits a name someone later reuses for something
  // that has no business blocking.
  for (const [base, reason] of Object.entries(BLOCKING_ALLOWED)) {
    assert.ok(reason.length > 10, `${base} needs a real reason, not a placeholder`);
    assert.ok(
      fs.existsSync(path.join(publicDir, 'scripts', base)),
      `BLOCKING_ALLOWED names ${base}, which no longer exists — drop the entry`,
    );
    const used = pages.some((f) => headOf(fs.readFileSync(f, 'utf8')).includes(base));
    assert.ok(used, `BLOCKING_ALLOWED names ${base}, which no <head> loads any more — drop the entry`);
  }
});
