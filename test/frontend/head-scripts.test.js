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
  // Its VIEWPORT redirect is what still blocks: the studio is a desktop layout, and the
  // check reads the layout viewport so it has to run before the body paints. It no longer
  // redirects on the visitor — that page is a preview now — but it cannot simply mount the
  // shared preview-gate.js either, because that file never navigates by design and the width
  // check must come first. So it carries the shared gate's body inline, and
  // ai-designer-gate-mobile.test.js pins both halves.
  'ai-designer-gate.js': 'redirects a phone-sized viewport, then applies the cached-Pro shape, both before paint',
  'gallery-gate.js': 'PC-only feature — redirects a phone-sized viewport before the grid paints',
  'api-keys-gate.js': 'PC-only page — redirects a phone-sized viewport before the inspector paints',
  'developers-gate.js': 'PC-only page — redirects a phone-sized viewport before the three-column docs shell paints',
  'faq-redirect.js': 'meta-refresh stub — must redirect before anything renders',
  // The one that redirects NOBODY, and the reason this list is shrinking rather than
  // growing. A preview page ships in its anonymous shape, so a Stagify+ visitor used to
  // watch the sales pitch paint and vanish once /api/auth/me answered — a full round trip
  // later. This reads the plan auth.js cached and applies the Pro shape in CSS, which is
  // worth nothing at all after first paint. `masking-studio-gate.js` and
  // `exterior-studio-gate.js` both used to sit here; the first was deleted when that page
  // became a preview, the second when its page was folded onto this shared file.
  'preview-gate.js': 'applies the cached-Pro page shape before first paint on all four preview pages, so a subscriber never sees the pitch',
  // The only one on EVERY nav-bearing page, so it is also the only one whose cost is paid
  // site-wide. It is deliberately last in <head>: first paint is already blocked on the
  // stylesheets above it, so a small same-origin file fetched alongside them is free,
  // whereas putting it first would delay discovery of the CSS that paint is waiting for.
  'session-class.js': 'sets html.has-session before first paint so the nav Gallery tab does not pop in a round trip late',
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

test('the homepage preloads the one script it still lets block the parser', () => {
  // BLOCKING IS ONLY HALF THE COST. session-class.js earns its place on the allowlist —
  // it reads the stored token and sets html.has-session so the nav's Gallery tab does not
  // pop in a round trip late — but "blocks the parser" means nothing below it is parsed
  // and therefore NOTHING PAINTS until it has arrived. At 2 KB that should be free.
  //
  // It was not. The preload scanner discovers it at the same instant as ~60 module
  // scripts, five stylesheets, two fonts and the LCP image, and at default priority it
  // queued behind all of them: measured arriving at 508 ms on a page whose CSS was
  // complete at 333 ms and whose hero photo had decoded at 394 ms. First paint sat at
  // 636 ms waiting for it. Adding the preload took the homepage's LCP from a 640 ms median
  // to 520 ms, with every after-run below every before-run.
  //
  // The trap this guards is that the two lines look unrelated and live 90 lines apart, so
  // the preload reads as redundant with the tag and is the obvious thing to "tidy up".
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const head = headOf(html);

  assert.match(
    head,
    /<script src="scripts\/session-class\.js"><\/script>/,
    'session-class.js is no longer a blocking script in the homepage <head>. If it was ' +
      'deferred or dropped, delete the preload below it too — a preload for something ' +
      'nothing loads is pure waste.',
  );
  assert.match(
    head,
    /<link rel="preload" as="script" href="scripts\/session-class\.js">/,
    'the homepage lost its `<link rel="preload" as="script">` for session-class.js. That ' +
      'script blocks the parser, so first paint cannot happen before it arrives, and ' +
      'without the preload it loses the queue to ~60 modules and costs ~120 ms of LCP.',
  );

  const preloadAt = head.indexOf('<link rel="preload" as="script" href="scripts/session-class.js">');
  const firstSheet = head.indexOf('<link rel="stylesheet"');
  assert.ok(
    preloadAt !== -1 && firstSheet !== -1 && preloadAt < firstSheet,
    'the session-class.js preload must sit ABOVE the render-blocking stylesheets, or it ' +
      'is discovered no earlier than the tag it exists to hurry along.',
  );
});
