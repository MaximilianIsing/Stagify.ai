// Visibility rule for the "Remove existing furniture" control in the stage modal.
//
// TWO independent conditions gate this row, owned by two different files:
//   • plan — it is a Stagify+ / Enterprise feature (auth.js, on every auth change)
//   • room type — some rooms cannot have their furniture removed (app.js, on select)
//
// They must not each toggle `.hidden` on their own: applyUserToUI() runs from eight
// call sites (login, logout, profile menu, google sign-in, after a staging run), and
// any of them would re-reveal the row while a no-removal room is still selected. So
// both callers funnel through syncRemoveFurnitureRow() here, which recomputes the
// whole rule from scratch — there is exactly one writer.

/**
 * Room types whose furniture is fixed, so offering to remove it is wrong.
 *
 * A dorm's desk, bed frame, wardrobe and dresser are university property the student
 * cannot swap out; the server enforces this too (ROOM_TYPE_CONSTRAINTS in
 * lib/staging/room-constraints.js explicitly overrides a removal request). Hiding the
 * control keeps the UI from promising something the prompt will refuse to do.
 * @type {ReadonlySet<string>}
 */
export const ROOM_TYPES_WITHOUT_REMOVAL = new Set(['Dorm']);

/**
 * Whether the remove-existing-furniture control should be available.
 * Pure — no DOM — so the rule itself is unit-testable.
 * @param {boolean} isPro - Stagify+ / Enterprise (enterprise users carry plan 'pro').
 * @param {string | null | undefined} roomType - the select's untranslated `data-value`.
 * @returns {boolean}
 */
export function removalAllowed(isPro, roomType) {
  if (!isPro) return false;
  return !ROOM_TYPES_WITHOUT_REMOVAL.has(String(roomType ?? '').trim());
}

/**
 * Recompute the row's visibility from the CURRENT plan + room type and apply it.
 * Safe to call on pages without the stage modal (no-ops), and safe to call repeatedly.
 *
 * When the control becomes unavailable the checkbox is also cleared and a `change`
 * event dispatched — clearing matters because `staging-pipeline.js` reads
 * `#remove-furniture.checked` directly, so a hidden-but-checked box would still submit
 * `removeFurniture=true`; the event matters because app.js's syncRemoveFurnitureUI()
 * listens for it to put back the variation slider and hide the keep-furniture box.
 * @returns {boolean} whether the control is now available
 */
export function syncRemoveFurnitureRow() {
  const row = document.getElementById('remove-furniture-row');
  if (!row) return false;

  const auth = /** @type {any} */ (window).StagifyAuth;
  const isPro =
    typeof auth?.isProUser === 'function' ? !!auth.isProUser() : auth?.user?.plan === 'pro';
  // The select mirrors the picked option's untranslated data-value onto its root —
  // the same value that gets submitted. Never read the displayed label here.
  const roomType = document.getElementById('room-type-select')?.dataset.value;

  const allowed = removalAllowed(isPro, roomType);
  row.classList.toggle('hidden', !allowed);

  if (!allowed) {
    const checkbox = /** @type {HTMLInputElement | null} */ (
      document.getElementById('remove-furniture')
    );
    if (checkbox?.checked) {
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return allowed;
}
