import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, errorCode, errorStack } from '../../lib/errors.js';

test('errorMessage reads an Error and anything else that was thrown', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage({ message: 'plain object' }), 'plain object');
  assert.equal(errorMessage('a string'), 'a string');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage({ message: 42 }), '[object Object]');
});

test('errorCode returns a string code or undefined', () => {
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errorCode(new Error('x')), undefined);
  assert.equal(errorCode({ code: 7 }), undefined);
  assert.equal(errorCode('ENOENT'), undefined);
  assert.equal(errorCode(null), undefined);
});

test('errorStack returns the stack of an Error only', () => {
  assert.match(String(errorStack(new Error('x'))), /Error: x/);
  assert.equal(errorStack({ stack: 'fake' }), undefined);
  assert.equal(errorStack('x'), undefined);
});
