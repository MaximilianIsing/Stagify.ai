// public/scripts/status/status-components.js — the lookup order and the class mapping behind
// the Components section of /status.
//
// The point of the lookup order is that translating is additive: the server always
// sends English, the pack is tried first, and a missing key (or a page where the
// language runtime has not loaded at all) degrades to that English rather than to a
// blank line. Both halves of that are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_NAMES, componentLabel, componentReason, stateLabel, stateClass, bannerClass, bannerText,
} from '../../public/scripts/status/status-components.js';

/** A language runtime that knows only the keys it is given. */
const packOf = (entries) => (key, fallback) => (key in entries ? entries[key] : fallback);

test('a reason prefers the pack and falls back to the server English', () => {
  const component = { reasonCode: 'DB_SLOW', reason: 'Responding, but more slowly than usual.' };
  const t = packOf({ 'status.components.reason.DB_SLOW': 'Antwortet langsamer als üblich.' });
  assert.equal(componentReason(component, t), 'Antwortet langsamer als üblich.');
  // Key absent from this pack: the English the server sent, not a blank line.
  assert.equal(componentReason(component, packOf({})), 'Responding, but more slowly than usual.');
  // No language runtime at all (the pack has not loaded yet).
  assert.equal(componentReason(component), 'Responding, but more slowly than usual.');
});

test('a reason with no code is shown verbatim', () => {
  // An older cached bundle against a newer server, or the reverse.
  assert.equal(componentReason({ reason: 'Something specific.' }, packOf({})), 'Something specific.');
  assert.equal(componentReason({}, packOf({})), '');
  assert.equal(componentReason(null), '');
});

test('a component name prefers the pack, then English, then the raw id', () => {
  const t = packOf({ 'status.components.name.database': 'Base de données' });
  assert.equal(componentLabel('database', t), 'Base de données');
  assert.equal(componentLabel('database', packOf({})), FALLBACK_NAMES.database);
  // An id this bundle has never heard of still renders as something readable.
  assert.equal(componentLabel('quantum-widgets', packOf({})), 'quantum-widgets');
});

test('state labels cover every state and treat anything unknown as unknown', () => {
  for (const state of ['operational', 'degraded', 'down', 'unknown']) {
    assert.ok(stateLabel(state, packOf({})).length > 0);
  }
  assert.equal(stateLabel('something-new', packOf({})), stateLabel('unknown', packOf({})));
  assert.equal(stateLabel('down', packOf({ 'status.components.state.down': 'Caído' })), 'Caído');
});

test('state classes map one-to-one, with unknown as the catch-all', () => {
  assert.equal(stateClass('operational'), 'is-operational');
  assert.equal(stateClass('degraded'), 'is-degraded');
  assert.equal(stateClass('down'), 'is-down');
  assert.equal(stateClass('unknown'), 'is-unknown');
  assert.equal(stateClass(undefined), 'is-unknown');
  assert.equal(stateClass('something-new'), 'is-unknown');
});

test('the banner prefers overall and falls back to currentState', () => {
  assert.equal(bannerClass({ overall: 'operational', currentState: 'up' }), 'is-up');
  assert.equal(bannerClass({ overall: 'degraded', currentState: 'up' }), 'is-degraded');
  assert.equal(bannerClass({ overall: 'down', currentState: 'up' }), 'is-down');
  // An older server that sends no `overall` at all.
  assert.equal(bannerClass({ currentState: 'up' }), 'is-up');
  assert.equal(bannerClass({ currentState: 'down' }), 'is-down');
  assert.equal(bannerClass(null), 'is-down');
});

test('the banner headline matches the class it paints', () => {
  const t = packOf({
    'status.operational': 'Todo operativo',
    'status.degraded': 'Algunos sistemas degradados',
    'status.disruption': 'Interrupción detectada',
  });
  assert.equal(bannerText({ overall: 'operational' }, t), 'Todo operativo');
  assert.equal(bannerText({ overall: 'degraded' }, t), 'Algunos sistemas degradados');
  assert.equal(bannerText({ overall: 'down' }, t), 'Interrupción detectada');
  // Without a runtime, English — and never an empty headline.
  assert.equal(bannerText({ overall: 'degraded' }), 'Some systems are degraded');
});
