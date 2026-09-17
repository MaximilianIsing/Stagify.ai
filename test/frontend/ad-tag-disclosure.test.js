// Drift guard: what the privacy policy SAYS about advertising must match what
// public/scripts/gtag.js actually DOES.
//
// WHY THIS EXISTS — a real failure, not a hypothetical one. The Google Ads tag was
// added across the public pages while privacy.html (which loads the tag itself)
// went on stating, in five separate places, that the site deploys no third-party
// advertising cookies, shares nothing for cross-context behavioral advertising, and
// builds no advertising profiles. Nothing in the suite compared the two, because
// they are a static HTML document and a classic script that no test loads — so the
// contradiction sat there through every green build.
//
// The two files can drift in EITHER direction, and both are bad in a way only this
// test notices:
//   * tag added / kept, denials left in the copy → the policy is false, and the
//     CPRA "sale and sharing" section is the part regulators read literally;
//   * tag removed, disclosures left in the copy → the policy over-discloses,
//     promising an opt-out for a tag that no longer exists and pointing at a
//     control with nothing behind it.
//
// So the assertions are keyed on whether gtag.js is present, and the failure
// messages name the copy to change in each direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = path.join(ROOT, 'public', 'scripts', 'gtag.js');
const POLICY = path.join(ROOT, 'public', 'privacy.html');

const tagShips = fs.existsSync(TAG);
const policy = fs.readFileSync(POLICY, 'utf8');

/** Collapse whitespace so a re-wrap of the copy does not fail the scan. */
const flat = policy.replace(/\s+/g, ' ');

/**
 * Claims that are FALSE while the tag ships. Each is the phrase as it stood when
 * the contradiction was found, trimmed to the part that carries the meaning.
 */
const DENIALS = [
  'We do not deploy third-party advertising cookies',
  'We do not share personal information for cross-context behavioral advertising',
  'We do not use your personal information for cross-context behavioral advertising',
  'We do <strong>not</strong> share personal information for cross-context behavioral advertising',
  'We do not create advertising profiles about you',
];

test('the privacy policy does not deny advertising while the tag ships', () => {
  if (!tagShips) return; // the opposite direction is covered below
  const surviving = DENIALS.filter((claim) => flat.includes(claim.replace(/\s+/g, ' ')));
  assert.deepEqual(
    surviving,
    [],
    'public/scripts/gtag.js ships Google Ads, so these privacy.html claims are false. '
      + 'Either remove the tag or rewrite the claim — see §9, §10 and §16.3.',
  );
});

test('the policy names Google Ads where a reader would look for it', () => {
  if (!tagShips) return;
  // §9 is where a reader checks what is stored in their browser, §10 is where they
  // check who receives it. A disclosure in only one of the two is a half-disclosure.
  assert.match(flat, /Advertising \(Google Ads\)/, '§9 must list the advertising cookies');
  assert.match(flat, /Google LLC \(Google Ads\)/, '§10 must name the recipient');
  assert.match(
    flat,
    /We <strong>do share<\/strong> personal information for cross-context behavioral advertising/,
    '§16.3 must state the CPRA position plainly',
  );
});

test('the policy offers the opt-out the tag actually honors', () => {
  if (!tagShips) return;
  // The control and the gate are two halves of one promise: the copy may not
  // advertise an opt-out the code does not implement.
  assert.match(flat, /id="ad-optout"/, 'the opt-out control must be on the page');
  assert.match(flat, /scripts\/ad-optout\.js/, 'the control must be wired');
  assert.match(flat, /Global Privacy Control/, 'GPC must be described');

  const tag = fs.readFileSync(TAG, 'utf8');
  assert.match(tag, /globalPrivacyControl/, 'gtag.js must honor GPC, since §16.3 says it does');
  assert.match(tag, /stagifyAdOptOut/, 'gtag.js must read the flag the control writes');
});

test('if the tag is ever removed, the disclosures come out with it', () => {
  if (tagShips) return;
  assert.equal(
    flat.includes('Google LLC (Google Ads)'),
    false,
    'public/scripts/gtag.js is gone, so privacy.html must stop disclosing Google Ads '
      + 'sharing and stop pointing at an opt-out for a tag that no longer runs. '
      + 'Restore the "we do not share… for cross-context behavioral advertising" copy.',
  );
});
