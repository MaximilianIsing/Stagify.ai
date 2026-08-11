// Basic Mask's "Label as virtually staged" — this dialog's binding of the shared option.
//
// The behaviour, the round trip to /api/stamp-image and the reasoning all live in
// scripts/mask/stamp-option.js, which the Masking Studio binds the same way. Only the two
// element ids differ, and they have to: the Basic Mask dialog shares index.html with the
// staging modal's copy of these same controls, so both the checkbox and the options
// container are named for this surface and every read is scoped to them.
//
// A binding module rather than an import of the factory at the call site because
// scripts/app/stage-mask-editor.js is at the max-lines ratchet in eslint.config.js.
import { createStampOption } from '../mask/stamp-option.js';

const option = createStampOption({
  checkboxId: 'mask-label-virtually-staged',
  optsId: 'mask-stamp-opts',
});

export const stampRequested = option.requested;
export const stampIfRequested = option.stampIfRequested;
export const downloadWithLabel = option.downloadWithLabel;

/** Where the control lives on a phone: its own row, directly above "Reference photo". */
const PHONE = '(max-width: 768px)';

/**
 * Move the control between its two homes as the viewport crosses the phone breakpoint.
 *
 * WHY THE NODE MOVES RATHER THAN BEING RE-ORDERED IN CSS
 * The two placements are not the same box in different clothes. On a PC the group rides
 * INSIDE .stage-mask-toolrow, in the empty half beside the brush tools — that is what makes
 * it cost the photo no height. On a phone that row cannot hold it, and the only comfortable
 * place is its own row above the reference photo, which means a different PARENT.
 *
 * CSS can fake that with `order`, or with `display:contents` on the toolbar row — and both
 * were rejected for the same reason: they move the control visually while leaving it early
 * in the DOM, so a keyboard user still meets it right after the Erase button, three rows
 * above where it appears. Moving the element keeps reading order and focus order the same
 * thing, which is the whole point of getting the placement right.
 *
 * Safe to move at any time: every listener is bound to these nodes (or their children) by
 * initStampStyleRow, so they travel with them, and nothing here caches an element — the
 * shared option re-reads by id on each call.
 * @returns {void}
 */
export function initMaskStampPlacement() {
  const stamp = document.getElementById('mask-stamp');
  const toolrow = document.querySelector('#stage-mask-modal .stage-mask-toolrow');
  const controls = document.querySelector('#stage-mask-modal .stage-mask-controls');
  const refRow = document.querySelector('#stage-mask-modal .stage-mask-ref-container');
  if (!stamp || !toolrow || !controls || !refRow || stamp.dataset.placed === 'true') return;
  stamp.dataset.placed = 'true';

  // The desktop anchor is the note, which is the toolrow's other end and is display:none
  // during the draw phase; inserting before it keeps the group between the tools and the
  // note in both phases.
  const note = toolrow.querySelector('.stage-mask-note');

  /**
   * @param {MediaQueryList | MediaQueryListEvent} mq - The phone query's current state.
   * @returns {void}
   */
  function place(mq) {
    const target = mq.matches ? controls : toolrow;
    const before = mq.matches ? refRow : note;
    // Guard the no-op: re-inserting a node that already sits there still moves it in the
    // DOM, which blurs anything focused inside it — and this runs on every resize tick.
    if (stamp.parentElement === target && stamp.nextElementSibling === before) return;
    target.insertBefore(stamp, before);
  }

  const query = window.matchMedia(PHONE);
  place(query);
  query.addEventListener('change', place);
}
