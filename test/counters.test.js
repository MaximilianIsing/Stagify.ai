// Unit tests for lib/data/counters.js — the two in-memory runtime counters
// (rooms staged / contact submissions) exposed through get/inc accessors.
//
// SCOPE: only the pure in-memory accessor behavior is exercised here:
//   getPromptCount/incPromptCount and getContactCount/incContactCount.
// These touch nothing outside the module — no fs, no network, no model or
// email client, so there is no external API call and no cost involved.
//
// Deliberately NOT tested: initializePromptCount/initializeContactCount. Those
// read a fixed <repoRoot>/data/*.csv path (or /data on Render) that is NOT
// injectable — the log directory is derived internally from import.meta.url and
// process.env.RENDER with no seam to redirect it. Driving them would read (and,
// via the CSV-derived state, effectively depend on) real on-disk data, so they
// are left out on purpose to keep this suite hermetic and side-effect free.
//
// The module is a process-wide singleton: promptCount/contactCount are module
// scoped and shared by every importer. Some other test file in the same process
// could already have mutated them, so every assertion here captures a fresh
// baseline via the get accessor and asserts a RELATIVE delta rather than an
// absolute value (never assumes the counter starts at 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPromptCount,
  incPromptCount,
  getContactCount,
  incContactCount,
} from '../lib/data/counters.js';

test('incPromptCount raises getPromptCount by exactly 1 per call', () => {
  const before = getPromptCount();
  incPromptCount();
  assert.equal(getPromptCount(), before + 1);
});

test('N calls to incPromptCount add exactly N to getPromptCount', () => {
  const before = getPromptCount();
  const N = 5;
  for (let i = 0; i < N; i += 1) incPromptCount();
  assert.equal(getPromptCount(), before + N);
});

test('incContactCount raises getContactCount by exactly 1 per call', () => {
  const before = getContactCount();
  incContactCount();
  assert.equal(getContactCount(), before + 1);
});

test('N calls to incContactCount add exactly N to getContactCount', () => {
  const before = getContactCount();
  const N = 3;
  for (let i = 0; i < N; i += 1) incContactCount();
  assert.equal(getContactCount(), before + N);
});

test('incrementing the prompt counter leaves the contact counter untouched', () => {
  const contactBefore = getContactCount();
  incPromptCount();
  assert.equal(getContactCount(), contactBefore);
});

test('incrementing the contact counter leaves the prompt counter untouched', () => {
  const promptBefore = getPromptCount();
  incContactCount();
  assert.equal(getPromptCount(), promptBefore);
});

test('getPromptCount is a pure read: two calls with no inc return the same value', () => {
  assert.equal(getPromptCount(), getPromptCount());
});

test('getContactCount is a pure read: two calls with no inc return the same value', () => {
  assert.equal(getContactCount(), getContactCount());
});
