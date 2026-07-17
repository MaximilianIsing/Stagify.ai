// Guards the Stagify+ post-purchase confirmation page (public/plus-welcome.html).
//
// This page is load-bearing for two integrations that live OUTSIDE the repo, so a
// plain "does the file parse" check isn't enough:
//   1. It is the redirect target configured on the Stripe "Start free trial" Payment
//      Link's *After payment* setting (Stripe dashboard).
//   2. The same https://stagify.ai/plus-welcome.html URL is registered as the Google
//      Ads conversion page.
// If it is renamed, deleted, or gutted of its into-app CTA, the post-checkout hand-off
// and ad-conversion tracking break silently — no other test would catch it. This one
// pins the exact path and the invariants those integrations rely on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'public', 'plus-welcome.html');

test('plus-welcome.html exists at the exact path Stripe + Google Ads point to', () => {
  assert.ok(
    fs.existsSync(PAGE),
    'public/plus-welcome.html must exist — the Stripe Payment Link redirects here after checkout and Google Ads tracks it as the conversion page',
  );
});

test('plus-welcome.html is the Stagify+ confirmation page and stays out of search', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.match(
    html,
    /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i,
    'reached only via the Stripe redirect — must be noindex',
  );
  assert.match(html, /Stagify\+/, 'should render the Stagify+ confirmation copy');
});

test('plus-welcome.html routes a new subscriber into the product', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.match(
    html,
    /<a[^>]*class=["']pw-enjoy["'][^>]*href=["']index\.html["']/i,
    'the main CTA must link into the product (the homepage staging tool), not a dead end',
  );
});
