// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/remove-furniture-gate.js.
//
// The "Remove existing furniture" control is gated by TWO conditions owned by two
// different files (plan, in auth.js; room type, in app.js), which is exactly the shape
// that rots: each caller toggling `.hidden` on its own would let applyUserToUI() — which
// runs from eight call sites — re-reveal the row while a no-removal room is selected.
// The rule therefore lives here as one pure function plus one idempotent DOM writer.
//
// The security-relevant half is the CLEARING, not the hiding: staging-pipeline.js reads
// `#remove-furniture.checked` directly, so a hidden-but-still-checked box would submit
// removeFurniture=true anyway — a free user could get a pro-only feature, and a dorm
// would be asked to discard the fixed furniture the prompt is built to preserve.
//
// Exercised against a minimal fake DOM (no jsdom), matching the other island suites.
// The browser-level proof is e2e/stage-room-type.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    checked: false,
    dataset: /** @type {Record<string, string>} */ ({}),
    dispatched: /** @type {string[]} */ ([]),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    dispatchEvent(e) { this.dispatched.push(e.type); return true; },
  };
}

/** Build a stage-modal DOM and install it as the global `document` / `window`. */
function mountModal({ plan, roomType, checked = false, withRow = true } = {}) {
  const row = withRow ? makeEl('remove-furniture-row') : null;
  const checkbox = makeEl('remove-furniture');
  const select = makeEl('room-type-select');
  checkbox.checked = checked;
  if (roomType !== undefined) select.dataset.value = roomType;

  const byId = { 'remove-furniture-row': row, 'remove-furniture': checkbox, 'room-type-select': select };
  globalThis.document = /** @type {any} */ ({ getElementById: (id) => byId[id] ?? null });
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: plan === undefined ? undefined : { isProUser: () => plan === 'pro', user: { plan } },
  });
  globalThis.Event = /** @type {any} */ (class { constructor(type) { this.type = type; } });
  return { row, checkbox, select };
}

const { removalAllowed, syncRemoveFurnitureRow, ROOM_TYPES_WITHOUT_REMOVAL } = await import(
  '../../../public/scripts/app/remove-furniture-gate.js'
);

// ---- The pure rule ---------------------------------------------------------

test('removalAllowed requires pro AND a room whose furniture is not fixed', () => {
  assert.equal(removalAllowed(true, 'Bedroom'), true);
  assert.equal(removalAllowed(true, 'Dorm'), false, 'a dorm cannot have its furniture removed');
  assert.equal(removalAllowed(false, 'Bedroom'), false, 'free users never get the control');
  assert.equal(removalAllowed(false, 'Dorm'), false);
});

test('removalAllowed allows every room type except the fixed-furniture ones', () => {
  for (const room of ['Bedroom', 'Living room', 'Dining room', 'Kitchen', 'Bathroom', 'Office', 'Outdoors']) {
    assert.equal(removalAllowed(true, room), true, `${room} should allow removal`);
  }
  for (const room of ROOM_TYPES_WITHOUT_REMOVAL) {
    assert.equal(removalAllowed(true, room), false, `${room} should block removal`);
  }
});

test('removalAllowed treats a missing or blank room type as removable', () => {
  // The value is absent only before the select initializes; failing OPEN here keeps a
  // pro user's control from flickering away, and the server still applies its own rules.
  for (const v of [undefined, null, '', '   ']) assert.equal(removalAllowed(true, v), true);
});

test('removalAllowed matches the room type exactly — no case or substring slack', () => {
  // The gate compares against the select's untranslated data-value, which is a fixed
  // vocabulary. Loose matching would be a liability, not a kindness: "Dormitory" or a
  // translated label must not silently disable a legitimate control.
  for (const v of ['dorm', 'DORM', 'Dorm room', 'Dormitory', ' Dorm ']) {
    assert.equal(removalAllowed(true, v), v.trim() === 'Dorm' ? false : true, `"${v}"`);
  }
});

// ---- The DOM writer --------------------------------------------------------

test('syncRemoveFurnitureRow reveals the row for a pro user on a normal room', () => {
  const { row, checkbox } = mountModal({ plan: 'pro', roomType: 'Bedroom', checked: true });
  assert.equal(syncRemoveFurnitureRow(), true);
  assert.equal(row.classList.contains('hidden'), false);
  assert.equal(checkbox.checked, true, 'an allowed control keeps the user\'s choice');
});

test('syncRemoveFurnitureRow hides the row and CLEARS the box when a dorm is picked', () => {
  // The regression that matters: hiding alone would still submit removeFurniture=true,
  // because the pipeline reads the checkbox, not the row's visibility.
  const { row, checkbox } = mountModal({ plan: 'pro', roomType: 'Dorm', checked: true });
  assert.equal(syncRemoveFurnitureRow(), false);
  assert.equal(row.classList.contains('hidden'), true);
  assert.equal(checkbox.checked, false, 'a hidden-but-checked box would still submit removal');
  assert.deepEqual(checkbox.dispatched, ['change'], 'app.js listens for change to restore the variation slider');
});

test('syncRemoveFurnitureRow hides the row for a free user regardless of room', () => {
  for (const roomType of ['Bedroom', 'Dorm']) {
    const { row, checkbox } = mountModal({ plan: 'free', roomType, checked: true });
    assert.equal(syncRemoveFurnitureRow(), false);
    assert.equal(row.classList.contains('hidden'), true, roomType);
    assert.equal(checkbox.checked, false, `free user must not submit removal (${roomType})`);
  }
});

test('syncRemoveFurnitureRow treats a signed-out visitor as not pro', () => {
  const { row } = mountModal({ plan: undefined, roomType: 'Bedroom' });
  assert.equal(syncRemoveFurnitureRow(), false);
  assert.equal(row.classList.contains('hidden'), true);
});

test('syncRemoveFurnitureRow does not dispatch change when the box is already clear', () => {
  // Guards against a feedback loop: app.js's change handler runs on every dispatch.
  const { checkbox } = mountModal({ plan: 'pro', roomType: 'Dorm', checked: false });
  syncRemoveFurnitureRow();
  assert.deepEqual(checkbox.dispatched, []);
});

test('syncRemoveFurnitureRow is idempotent and reversible across room switches', () => {
  // applyUserToUI() calls this from eight sites; re-running must not drift, and moving
  // off the dorm must give a pro user the control back.
  const { row, checkbox, select } = mountModal({ plan: 'pro', roomType: 'Dorm', checked: true });
  syncRemoveFurnitureRow();
  syncRemoveFurnitureRow();
  assert.equal(row.classList.contains('hidden'), true);
  assert.deepEqual(checkbox.dispatched, ['change'], 'only the first run clears anything');

  select.dataset.value = 'Bedroom';
  assert.equal(syncRemoveFurnitureRow(), true);
  assert.equal(row.classList.contains('hidden'), false, 'the control comes back');
  assert.equal(checkbox.checked, false, 'but stays unchecked — it is not re-armed silently');
});

test('syncRemoveFurnitureRow no-ops on pages without the stage modal', () => {
  mountModal({ plan: 'pro', roomType: 'Bedroom', withRow: false });
  assert.doesNotThrow(() => syncRemoveFurnitureRow());
  assert.equal(syncRemoveFurnitureRow(), false);
});
