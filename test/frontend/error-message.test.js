import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorMessage } from '../../public/scripts/shared/error-message.js';

test('errorMessage returns a non-empty string message', () => {
  assert.equal(errorMessage(new Error('boom'), 'fallback'), 'boom');
  assert.equal(errorMessage({ message: 'plain object' }), 'plain object');
});

test('errorMessage falls back for anything without a usable message', () => {
  assert.equal(errorMessage(new Error(''), 'fallback'), 'fallback');
  assert.equal(errorMessage('a string', 'fallback'), 'fallback');
  assert.equal(errorMessage(null, 'fallback'), 'fallback');
  assert.equal(errorMessage({ message: 42 }, 'fallback'), 'fallback');
  assert.equal(errorMessage(undefined), '');
});
