// Tier: drift guard. The admin console's upgrade-candidates rule needs the free
// plan's daily cap, but the browser cannot import lib/data/auth-store.js and
// /authstore does not send it, so the rule carries a copy. This keeps the copy
// honest: change the real cap and this fails until the admin copy follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FREE_DAILY_LIMIT as serverLimit } from '../../../lib/data/auth-store.js';
import { FREE_DAILY_LIMIT as adminLimit } from '../../../public/scripts/admin/plan-limits.js';

test('the admin findings use the same free daily cap the server enforces', () => {
  assert.equal(adminLimit, serverLimit);
});
