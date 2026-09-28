// Secrets and boot settings come from env vars only: the Render dashboard in production,
// `.env` locally. The .txt file fallbacks were removed because a stray file on disk
// silently overrode the dashboard value (the config.js readers even checked the file
// FIRST). These tests pin both halves: createConfig reads the env, and none of the
// three secret-reading modules touches the filesystem again.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../../lib/config/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'ENTERPRISE_PRICE_ID', 'endpoint_key',
  'ENTERPRISE_METER_EVENT_NAME', 'API_CREDIT_PRICE_20'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('createConfig reads each secret from its env var, trimmed', () => {
  process.env.STRIPE_SECRET_KEY = '  sk_test_abc  ';
  process.env.endpoint_key = 'k-123';
  process.env.API_CREDIT_PRICE_20 = 'price_20';
  const c = createConfig();
  assert.equal(c.readStripeSecretKey(), 'sk_test_abc');
  assert.equal(c.readEndpointAccessKey(), 'k-123');
  assert.equal(c.readApiCreditPriceIds().api_20, 'price_20');
});

test('a value with the wrong prefix is ignored rather than used', () => {
  process.env.STRIPE_SECRET_KEY = 'pk_live_wrong_slot';
  process.env.ENTERPRISE_PRICE_ID = 'prod_not_a_price';
  const c = createConfig();
  assert.equal(c.readStripeSecretKey(), '');
  assert.equal(c.readEnterprisePriceId(), '');
});

test('unset values resolve to empty, and the meter event keeps its default', () => {
  for (const k of KEYS) delete process.env[k];
  const c = createConfig();
  assert.equal(c.readStripePublishableKey(), '');
  assert.equal(c.readEndpointAccessKey(), '');
  assert.equal(c.readEnterpriseMeterEventName(), 'user_generation');
});

for (const rel of ['lib/config/config.js', 'lib/services/ai-clients.js', 'lib/config/runtime-flags.js']) {
  test(`${rel} reads no secret files`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /\b(readFileSync|existsSync|readFile)\s*\(/, `${rel} must not read files`);
    assert.doesNotMatch(src, /\.txt['"`]/, `${rel} must not name a .txt secret file`);
  });
}
